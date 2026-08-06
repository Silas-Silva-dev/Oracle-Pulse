/**
 * CONFIG.JS - Carregamento e validação centralizada das variáveis de ambiente.
 * Falha rápido (fail-fast) no startup se algo obrigatório estiver faltando,
 * em vez de quebrar silenciosamente no meio de uma requisição.
 */
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const bool = (v) => String(v).toLowerCase() === 'true';
const int = (v, def) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
};

const config = {
    port: int(process.env.PORT, 3000),
    demoMode: bool(process.env.DEMO_MODE),

    db: {
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        service: process.env.DB_SERVICE,
        clientPath: process.env.ORACLE_CLIENT_PATH,
        get connectString() {
            return `${this.host}:${this.port}/${this.service}`;
        },
        get isSys() {
            return this.user && this.user.toLowerCase() === 'sys';
        },
        pool: {
            min: int(process.env.DB_POOL_MIN, 1),
            max: int(process.env.DB_POOL_MAX, 10),
            increment: int(process.env.DB_POOL_INCREMENT, 1),
        },
    },

    auth: {
        // Conta DBA (acesso total - pode executar ações destrutivas)
        user: process.env.AUTH_USER,
        passHash: process.env.AUTH_PASS_HASH,
        // Conta de visualização opcional (somente leitura)
        viewerUser: process.env.AUTH_VIEWER_USER || null,
        viewerPassHash: process.env.AUTH_VIEWER_PASS_HASH || null,
        // Tempo de vida do token de sessão (em minutos)
        tokenTtlMinutes: int(process.env.AUTH_TOKEN_TTL_MIN, 480), // 8h
    },

    ssh: {
        host: process.env.SSH_HOST && process.env.SSH_HOST !== '#' ? process.env.SSH_HOST : null,
        user: process.env.SSH_USER,
        password: process.env.SSH_PASSWORD,
        port: int(process.env.SSH_PORT, 22),
        privateKeyPath: process.env.SSH_PRIVATE_KEY_PATH || null,
    },

    // Ambiente Oracle NO SERVIDOR (para automatizar comandos RMAN). Opcional:
    // sem isso, o painel apenas mostra o comando RMAN para o DBA executar.
    oracleServer: {
        home: process.env.DB_ORACLE_HOME || null,        // ORACLE_HOME no servidor
        sid: process.env.DB_ORACLE_SID || process.env.DB_SERVICE || null,
        osUser: process.env.DB_OS_USER || null,          // dono do Oracle no SO (ex.: oracle)
        // Autenticação do RMAN/sqlplus por SENHA do SYS (recomendado). Quando
        // definido, o painel conecta com "sys/<senha>[@alias]" — funciona mesmo
        // que o usuário do SSH (ex.: root) NÃO seja membro do grupo dba. Sem
        // isso, cai no modo de autenticação por SO ("rman target /").
        sysUser: process.env.DB_SYS_USER || 'sys',
        sysPassword: process.env.DB_SYS_PASSWORD || null,
        // Alias TNS para a conexão (ex.: "master"). No Linux costuma ser vazio
        // (conexão local via ORACLE_SID); no Windows normalmente é necessário.
        tnsAlias: process.env.DB_TNS_ALIAS || null,
        // Caminho da FRA a usar quando ela ainda não está configurada. Opcional:
        // se vazio, o sistema usa <ORACLE_BASE>/fast_recovery_area.
        fraDest: process.env.DB_FRA_DEST || null,
        get rmanAutomationReady() {
            return !!(this.home && this.sid);
        },
        // true quando vamos autenticar por senha do SYS (e não por SO).
        get usesPasswordAuth() {
            return !!this.sysPassword;
        },
    },

    alerts: {
        webhookUrl: process.env.ALERT_WEBHOOK_URL || null,
        tablespacePct: int(process.env.ALERT_TABLESPACE_PCT, 90),
        diskPct: int(process.env.ALERT_DISK_PCT, 85),
        // Memória: agora baseada na RAM REAL do servidor + swap (não no ratio SGA/PGA do Oracle)
        memoryPct: int(process.env.ALERT_MEMORY_PCT, 92),
        swapPct: int(process.env.ALERT_SWAP_PCT, 25),
        // FRA: avisar cedo evita o banco PARAR quando a recovery area enche (archivelog)
        fraPct: int(process.env.ALERT_FRA_PCT, 80),
    },

    paths: {
        public: path.join(__dirname, '..', 'public'),
        logs: path.join(__dirname, '..', 'logs'),
    },
};

/**
 * Valida a configuração. Em modo DEMO nada é obrigatório (usa mocks).
 * Lança Error com a lista de problemas se algo essencial faltar.
 */
function validateConfig() {
    const problems = [];

    if (!config.auth.user || !config.auth.passHash) {
        problems.push('AUTH_USER e AUTH_PASS_HASH são obrigatórios (credenciais de login).');
    }

    if (config.auth.viewerUser && !config.auth.viewerPassHash) {
        problems.push('AUTH_VIEWER_USER definido sem AUTH_VIEWER_PASS_HASH.');
    }

    if (!config.demoMode) {
        if (!config.db.user) problems.push('DB_USER é obrigatório fora do modo DEMO.');
        if (!config.db.password) problems.push('DB_PASSWORD é obrigatório fora do modo DEMO.');
        if (!config.db.host) problems.push('DB_HOST é obrigatório fora do modo DEMO.');
        if (!config.db.service) problems.push('DB_SERVICE é obrigatório fora do modo DEMO.');
    }

    if (problems.length > 0) {
        throw new Error('Configuração inválida (.env):\n  - ' + problems.join('\n  - '));
    }

    // Avisos não-fatais (não impedem o boot, mas alertam sobre configs incompletas)
    const warnings = [];
    if (config.ssh.host && !config.ssh.privateKeyPath && !config.ssh.password) {
        warnings.push('SSH_HOST definido, mas sem SSH_PASSWORD nem SSH_PRIVATE_KEY_PATH — a leitura de disco remoto vai falhar por falta de credenciais.');
    }
    if (config.ssh.host && !config.ssh.user) {
        warnings.push('SSH_HOST definido, mas SSH_USER está vazio.');
    }
    if (config.oracleServer.rmanAutomationReady && !config.oracleServer.sysPassword) {
        warnings.push('Automação RMAN ativa sem DB_SYS_PASSWORD — o painel usará autenticação por SO ' +
            '(rman target /), que exige que o usuário do SSH seja membro do grupo dba do Oracle. ' +
            'Se você conecta com "sys/<senha>", defina DB_SYS_PASSWORD no .env.');
    }
    if (config.oracleServer.sysPassword && /[\r\n]/.test(config.oracleServer.sysPassword)) {
        warnings.push('DB_SYS_PASSWORD contém quebra de linha — verifique as aspas no .env.');
    }
    return warnings;
}

module.exports = { config, validateConfig };

/**
 * BACKUPADMIN.JS - Operações de backup/recuperação executadas no servidor
 * (RMAN e sqlplus), via SSH ou localmente. Tudo sem reinício, EXCETO a troca de
 * modo archivelog (que exige MOUNT — feita como job em segundo plano).
 *
 * AUTENTICAÇÃO (importante):
 *  - Por padrão conectamos com a SENHA do SYS: "rman target sys/<senha>[@alias]"
 *    e "sqlplus sys/<senha>[@alias] as sysdba". É o mesmo método que o DBA usa
 *    manualmente e funciona mesmo que o usuário do SSH (ex.: root) NÃO seja
 *    membro do grupo dba do Oracle.
 *  - No Linux normalmente NÃO se usa alias (conexão local via ORACLE_SID); no
 *    Windows normalmente é necessário (DB_TNS_ALIAS, ex.: "master").
 *  - A senha NUNCA vai na linha de comando: ela é enviada pela ENTRADA PADRÃO
 *    (stdin) como a primeira linha do script (CONNECT ...), evitando que apareça
 *    em `ps`/Task Manager. A saída é higienizada (scrubSecrets) antes de logar.
 *  - Sem DB_SYS_PASSWORD, cai no modo antigo de autenticação por SO
 *    (rman target / ; sqlplus / as sysdba).
 *
 * Limites do Oracle relevantes:
 *  - RETENTION POLICY só MARCA obsoletos; quem apaga é DELETE OBSOLETE.
 *  - ARCHIVELOG DELETION POLICY torna a FRA capaz de reciclar logs já copiados.
 *  - BACKUP ... DELETE INPUT remove os archives após salvá-los (libera a FRA).
 */
const crypto = require('crypto');
const { config } = require('./config');
const { detectServerOs, execOnServer, psEncoded } = require('./osDisk');
const audit = require('./audit');
const logger = require('./logger');

// ==========================================================================
// Helpers de autenticação / construção de comandos
// ==========================================================================

/** Rejeita caracteres perigosos em identificadores de caminho/SID do .env. */
function safeIdent(value, label) {
    const s = String(value || '');
    if (s === '' || /["'`;&|\n\r$]/.test(s)) {
        throw new Error(`${label} inválido ou não configurado no .env.`);
    }
    return s;
}

/** Remove a senha do SYS de qualquer texto antes de logar/exibir/armazenar. */
function scrubSecrets(text) {
    if (text == null) return text;
    let t = String(text);
    const pwd = config.oracleServer.sysPassword;
    if (pwd) t = t.split(pwd).join('********');
    // Backstop: mascara a senha em strings de conexão (user/senha@alias),
    // cobrindo "rman target sys/pwd", "CONNECT TARGET sys/pwd" e "CONNECT sys/pwd".
    t = t.replace(/(\b(?:connect\s+target|connect|target)\s+[\w$#]+\/)[^@\s;'"]+/gi, '$1********');
    return t;
}

/** "@alias" quando DB_TNS_ALIAS está definido; senão "" (conexão local). */
function connectAlias() {
    return config.oracleServer.tnsAlias ? '@' + safeIdent(config.oracleServer.tnsAlias, 'DB_TNS_ALIAS') : '';
}

/** Usuário administrativo (padrão "sys"). */
function adminUser() {
    return safeIdent(config.oracleServer.sysUser || 'sys', 'DB_SYS_USER');
}

/**
 * Define como o RMAN será invocado.
 *  - Com senha: programa "rman" (sem target) + linha CONNECT no stdin.
 *  - Sem senha: "rman target /" (autenticação por SO), sem linha CONNECT.
 * @returns {{ args: string, connectLine: string|null }}
 */
function rmanInvocation() {
    if (!config.oracleServer.usesPasswordAuth) return { args: 'target /', connectLine: null };
    return { args: '', connectLine: `CONNECT TARGET ${adminUser()}/${config.oracleServer.sysPassword}${connectAlias()};` };
}

/**
 * Define como o sqlplus será invocado.
 *  - Com senha: "sqlplus -S /nolog" + linha CONNECT ... AS SYSDBA no stdin.
 *  - Sem senha: "sqlplus -S / as sysdba" (autenticação por SO).
 *
 * Conecta SEMPRE pelo MESMO método que o usuário usa na mão e que comprovadamente
 * funciona: o alias TNS (ex.: "sys/<senha>@master as sysdba"). Já tentamos a
 * conexão LOCAL/BEQ (sem alias) no SHUTDOWN/STARTUP do archivelog, mas o Windows
 * do cliente a RECUSA com ORA-12546 (TNS:permission denied) — o ambiente só
 * autoriza conexão pelo listener/alias. Não há perda: dentro do MESMO script
 * sqlplus a sessão SYSDBA permanece válida através do SHUTDOWN para emitir o
 * STARTUP (no Windows, com o OracleService<SID> no ar, o STARTUP MOUNT funciona).
 * @returns {{ args: string, connectLine: string|null }}
 */
function sqlplusInvocation() {
    if (!config.oracleServer.usesPasswordAuth) return { args: '-S / AS SYSDBA', connectLine: null };
    return { args: '-S /nolog', connectLine: `CONNECT ${adminUser()}/${config.oracleServer.sysPassword}${connectAlias()} AS SYSDBA` };
}

/**
 * Monta o comando de SO que prepara o ambiente e invoca o binário Oracle.
 * O script (com a senha) vai por stdin — aqui NUNCA entra a senha.
 * @param {'rman'|'sqlplus'} bin
 * @param {string} args  argumentos do binário (ex.: 'target /', '-S /nolog')
 * @param {'linux'|'windows'} serverOs
 */
function buildServerCommand(bin, args, serverOs) {
    const tail = args ? ` ${args}` : '';

    if (serverOs === 'windows') {
        const sid = config.oracleServer.sid ? safeIdent(config.oracleServer.sid, 'DB_ORACLE_SID') : '';

        // WINDOWS LOCAL (sem SSH) — banco na MESMA máquina do painel (caso comum).
        // Roda EXATAMENTE como no CMD: invoca "rman"/"sqlplus" pelo NOME e HERDA
        // todo o ambiente do painel (mesmo PATH do CMD onde o RMAN funciona).
        // DOIS quesitos críticos, ambos aprendidos na marra:
        //  1) NÃO mexer no PATH (prepend de "${home}\bin" mascarava o rman.exe
        //     correto por outro Oracle Home sem permissão → "Acesso negado").
        //  2) NÃO setar ORACLE_HOME. No Windows o rman.exe/sqlplus.exe DESCOBREM o
        //     ORACLE_HOME pela própria localização do .exe (parente de \bin). Se a
        //     gente força ORACLE_HOME (mesmo o do .env), e ele não bate exatamente
        //     com o home do exe, o RMAN procura o catálogo de mensagens no lugar
        //     errado → "Message file RMAN<lang>.msb not found". Por isso herdamos
        //     o ambiente sem sobrescrever — idêntico ao CMD do usuário, que
        //     funciona sem setar nada. Só passamos ORACLE_SID (ignorado pelo rman
        //     quando há @alias; ajuda o sqlplus local do archivelog).
        if (!config.ssh.host) {
            const env = sid ? { ORACLE_SID: sid } : null;
            return { command: `${bin}${tail}`, env };
        }

        // WINDOWS REMOTO via SSH — PowerShell -EncodedCommand (imune ao shell
        // padrão do OpenSSH, cmd OU PowerShell). O EXE herda o stdin diretamente.
        const h = safeIdent(config.oracleServer.home, 'DB_ORACLE_HOME');
        const s = safeIdent(config.oracleServer.sid, 'DB_ORACLE_SID');
        const ps = [
            "$ProgressPreference='SilentlyContinue'",
            `$env:ORACLE_HOME='${h}'`,
            `$env:ORACLE_SID='${s}'`,
            `$exe="$env:ORACLE_HOME\\bin\\${bin}.exe"`,
            `& $exe${tail}`,
        ].join(';');
        return { command: psEncoded(ps), env: null };
    }

    // LINUX (local ou via SSH)
    const home = safeIdent(config.oracleServer.home, 'DB_ORACLE_HOME');
    const sid = safeIdent(config.oracleServer.sid, 'DB_ORACLE_SID');
    const inner = `export ORACLE_HOME=${home}; export ORACLE_SID=${sid}; "$ORACLE_HOME/bin/${bin}"${tail}`;
    const osUser = config.oracleServer.osUser;
    // Em Linux, se acessamos por um usuário diferente do dono do Oracle (ex.:
    // SSH como root), rodamos via "su - <oracle>" para herdar o ambiente certo.
    if (config.ssh.host && osUser && osUser !== config.ssh.user) {
        return { command: `su - ${safeIdent(osUser, 'DB_OS_USER')} -c '${inner}'`, env: null };
    }
    return { command: inner, env: null };
}

/** Monta { command, env, stdin } para um script RMAN. */
function buildRmanRun(rmanLines, serverOs) {
    const { args, connectLine } = rmanInvocation();
    const { command, env } = buildServerCommand('rman', args, serverOs);
    const lines = [];
    if (connectLine) lines.push(connectLine);
    lines.push(...rmanLines, 'EXIT;');
    return { command, env, stdin: lines.join('\n') + '\n' };
}

/** Monta { command, stdin } para a troca de modo archivelog (sqlplus). */
function buildArchivelogRun(enable, serverOs) {
    const mode = enable ? 'ARCHIVELOG' : 'NOARCHIVELOG';
    // Conecta pelo ALIAS (mesmo "sys/<senha>@master" do RMAN e do seu CMD). NÃO
    // usamos conexão local/BEQ: o Windows do cliente a recusa com ORA-12546. A
    // sessão SYSDBA sobrevive ao SHUTDOWN dentro do próprio script para o STARTUP.
    // No Linux (DB_TNS_ALIAS vazio) isto continua sendo conexão local, como antes.
    const { args, connectLine } = sqlplusInvocation();
    const { command, env } = buildServerCommand('sqlplus', args, serverOs);
    const lines = ['WHENEVER SQLERROR EXIT FAILURE'];
    if (connectLine) lines.push(connectLine);
    lines.push(
        'SHUTDOWN IMMEDIATE;',
        'STARTUP MOUNT;',
        `ALTER DATABASE ${mode};`,
        'ALTER DATABASE OPEN;',
        'ARCHIVE LOG LIST;',
        'EXIT;',
    );
    return { command, env, stdin: lines.join('\n') + '\n' };
}

/** Sucesso RMAN = saída 0 e sem erro RMAN-xxxx/ORA-xxxx. */
function rmanSucceeded(result) {
    const out = `${result.stdout}\n${result.stderr}`;
    if (/RMAN-\d{4,}/.test(out) || /ORA-\d{4,}/.test(out)) return false;
    return result.code === 0;
}

/** Sucesso sqlplus = saída 0 e sem ORA-xxxx. */
function archivelogSucceeded(result) {
    const out = `${result.stdout}\n${result.stderr}`;
    if (/ORA-\d{3,}/.test(out)) return false;
    return result.code === 0;
}

/**
 * Detecta "Acesso negado" ao LANÇAR rman.exe/sqlplus.exe no Windows (CreateProcess
 * ACCESS_DENIED). Não é erro do Oracle: é a conta do SSH sem permissão para
 * executar o Oracle Home. Retorna uma orientação acionável, ou '' se não se aplica.
 */
function serverLaunchHint(output, diag = '') {
    if (!/Acesso negado|Access is denied|failed to run program|An error occurred trying to start process/i.test(output)) return '';

    // Cenário REMOTO via SSH (ex.: banco Linux): a conta é a do SSH.
    if (config.ssh.host) {
        return [
            '⚠️ DIAGNÓSTICO: "Acesso negado" ao INICIAR o rman.exe/sqlplus.exe no servidor.',
            'Não é erro do Oracle — é o SO recusando a execução: a conta do SSH não tem',
            'permissão para executar o Oracle Home. Como resolver:',
            `  1) Use no SSH (SSH_USER) a MESMA conta com que você roda "rman target ..." manualmente.`,
            '  2) OU conceda essa conta no Oracle Home: icacls "%ORACLE_HOME%" /grant "USUARIO:(OI)(CI)RX" /T',
        ].join('\n');
    }

    // Cenário LOCAL (Windows na MESMA máquina do banco, sem SSH). O painel já roda
    // como a conta atual; e o usuário roda o RMAN na mão COM SUCESSO nessa MESMA
    // conta. Logo, "Acesso negado" aqui quase sempre significa que o painel está
    // lançando um rman.exe DIFERENTE do que o seu CMD usa (outro Oracle Home no
    // PATH/DB_ORACLE_HOME) — não um problema de conta. O bloco `diag` (de
    // windowsLaunchDiagnostics) mostra QUAL rman.exe o painel encontra.
    const acct = (process.env.USERDOMAIN && process.env.USERNAME)
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : (process.env.USERNAME || 'a conta atual');
    const home = config.oracleServer.home || '(DB_ORACLE_HOME vazio)';
    const lines = [
        '⚠️ DIAGNÓSTICO: "Acesso negado" ao INICIAR o rman.exe/sqlplus.exe.',
        'NÃO é erro do Oracle — é o Windows recusando a EXECUÇÃO do programa.',
        `Conta do painel: "${acct}"   |   DB_ORACLE_HOME (.env): ${home}`,
        'Como você roda o RMAN na mão COM SUCESSO nesta MESMA conta, o mais provável',
        'é o painel estar lançando um rman.exe de OUTRO Oracle Home (que esta conta',
        'não pode executar), e não o do seu CMD.',
    ];
    if (diag) lines.push('', diag);
    lines.push(
        '',
        'Como resolver:',
        '  1) No CMD onde o RMAN funciona, rode:  where rman',
        '     Aponte DB_ORACLE_HOME (no .env) para ESSE Oracle Home — ou deixe-o',
        '     VAZIO para o painel usar exatamente o mesmo rman do seu PATH.',
        '  2) Reinicie o painel a partir de um CMD novo logado como esta conta,',
        '     para herdar o mesmo PATH do seu CMD.',
        `  3) Persistindo, libere a execução:  icacls "<ORACLE_HOME>\\bin" /grant "${acct}:(OI)(CI)RX" /T`,
    );
    return lines.join('\n');
}

/**
 * Quando há "Acesso negado" no Windows LOCAL, coleta o fato decisivo: QUAL
 * rman.exe/sqlplus.exe o PATH do painel resolve (todos, em ordem). Comparado com
 * o `where rman` do CMD onde o usuário roda com sucesso, isto revela na hora se o
 * painel está achando outro Oracle Home. Retorna '' fora do Windows local.
 */
async function windowsLaunchDiagnostics() {
    if (config.ssh.host || process.platform !== 'win32') return '';
    try {
        const r = await execOnServer('where rman.exe & echo --- & where sqlplus.exe');
        const txt = scrubSecrets((r.stdout || r.stderr || '').trim());
        if (!txt) return '';
        return [
            'rman.exe/sqlplus.exe que o PAINEL encontra no PATH (em ordem):',
            txt,
            '→ Compare com o `where rman` do CMD onde funciona. Se o caminho diferir,',
            '  ajuste DB_ORACLE_HOME ou inicie o painel a partir daquele mesmo CMD.',
        ].join('\n');
    } catch {
        return '';
    }
}

/**
 * Detecta o erro de AMBIENTE (não de conexão/permissão): o rman/sqlplus iniciou,
 * mas o ORACLE_HOME que ele enxerga aponta para um home sem o catálogo de
 * mensagens → "Message file RMAN<lang>.msb not found" / RMAN-00554 / "Verify that
 * ORACLE_HOME is set properly". Orienta a alinhar o ambiente com o do CMD do
 * usuário. Retorna '' se não se aplica.
 */
function oracleHomeHint(output) {
    if (!/Message file RMAN.*\.msb not found|RMAN-00554|Verify that ORACLE_HOME is set/i.test(output)) return '';
    const home = config.oracleServer.home || '(DB_ORACLE_HOME vazio)';
    return [
        '⚠️ DIAGNÓSTICO: o rman/sqlplus INICIOU, mas não encontrou seu catálogo de',
        'mensagens (RMAN<lang>.msb). Isso é ORACLE_HOME apontando para o home ERRADO —',
        'NÃO é erro de conexão, de senha nem de permissão.',
        `DB_ORACLE_HOME no .env: ${home}`,
        '',
        'Como resolver (o painel deve usar o MESMO ambiente do seu CMD):',
        '  1) No CMD onde "rman target sys/...@master" funciona, rode:  where rman',
        '     O ORACLE_HOME correto é a pasta ANTES de \\bin\\rman.exe.',
        '  2) Reinicie o painel (node server.js) a partir DESSE mesmo CMD, para herdar',
        '     o ambiente certo — ou ajuste DB_ORACLE_HOME no .env para esse caminho.',
    ].join('\n');
}

/**
 * ORA-12546 (TNS:permission denied) — o banco RECUSOU a conexão. Não é senha:
 * é o método/origem da conexão (tipicamente BEQ local não autorizado, ou
 * tcp.validnode_checking no sqlnet.ora barrando o IP). Orienta a usar o alias
 * que funciona no CMD. Retorna '' se não se aplica.
 */
function connectPermissionHint(output) {
    if (!/ORA-12546/i.test(output)) return '';
    const alias = config.oracleServer.tnsAlias || 'master';
    return [
        '⚠️ DIAGNÓSTICO: ORA-12546 (TNS:permission denied) — o banco RECUSOU a conexão.',
        'NÃO é senha incorreta: é o método/origem da conexão.',
        `O painel conecta como "sys/<senha>@${alias} as sysdba" (DB_TNS_ALIAS=${config.oracleServer.tnsAlias || '(vazio)'}).`,
        'Confirme que ESTE comando funciona no seu CMD:',
        `  sqlplus sys/<senha>@${alias} as sysdba`,
        'Se funciona no CMD mas falha aqui, verifique no sqlnet.ora do servidor se há',
        'tcp.validnode_checking=yes com INVITED_NODES limitando os IPs que podem conectar.',
    ].join('\n');
}

/** Executa um script RMAN em primeiro plano (ops rápidas: CONFIGURE). */
async function runRman(rmanLines) {
    const serverOs = await detectServerOs();
    const { command, stdin, env } = buildRmanRun(rmanLines, serverOs);
    const result = await execOnServer(command, { stdin, env });
    let output = scrubSecrets(`${result.stdout}\n${result.stderr}`).trim();
    let hint = '';
    if (serverLaunchHint(output)) hint = serverLaunchHint(output, await windowsLaunchDiagnostics());
    else if (oracleHomeHint(output)) hint = oracleHomeHint(output);
    else if (connectPermissionHint(output)) hint = connectPermissionHint(output);
    if (hint) output = `${hint}\n\n--- saída original ---\n${output}`;
    return { ok: rmanSucceeded(result), output };
}

// ==========================================================================
// FRA — destino (db_recovery_file_dest) e criação automática da pasta
// ==========================================================================

/** Tenta obter $ORACLE_BASE diretamente do servidor (caminho mais confiável). */
async function detectOracleBase(serverOs) {
    try {
        if (serverOs === 'windows') {
            const r = await execOnServer('cmd /c echo %ORACLE_BASE%');
            const v = (r.stdout || '').trim();
            if (v && !v.includes('%') && v.length > 2) return v;
        } else {
            const inner = 'echo "$ORACLE_BASE"';
            const owner = config.oracleServer.osUser;
            const cmd = (config.ssh.host && owner && owner !== config.ssh.user)
                ? `su - ${safeIdent(owner, 'DB_OS_USER')} -c '${inner}'`
                : inner;
            const r = await execOnServer(cmd);
            const v = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
            if (v && v.trim().startsWith('/')) return v.trim();
        }
    } catch { /* ignore — usaremos o fallback derivado do ORACLE_HOME */ }
    return null;
}

/**
 * Resolve o caminho da FRA a usar quando ela ainda não está configurada:
 *  1) DB_FRA_DEST (.env), se definido;
 *  2) <ORACLE_BASE>/fast_recovery_area (ORACLE_BASE lido do servidor);
 *  3) fallback derivado do ORACLE_HOME (home sem ".../product/<ver>").
 */
async function resolveFraPath() {
    const serverOs = await detectServerOs();
    const sep = serverOs === 'windows' ? '\\' : '/';

    if (config.oracleServer.fraDest) {
        return safeIdent(config.oracleServer.fraDest, 'DB_FRA_DEST');
    }
    const base = await detectOracleBase(serverOs);
    if (base) return safeIdent(base.replace(/[\\/]+$/, '') + sep + 'fast_recovery_area', 'caminho da FRA');

    const home = safeIdent(config.oracleServer.home, 'DB_ORACLE_HOME');
    const re = serverOs === 'windows' ? /\\product\\.*$/i : /\/product\/.*$/;
    let derived = home.replace(re, '');
    if (derived === home) {
        // ORACLE_HOME sem segmento ".../product/...": usa o PAI do home para NÃO
        // criar a FRA dentro do próprio ORACLE_HOME (recovery files podem crescer).
        derived = home.replace(/[\\/][^\\/]+$/, '');
    }
    if (!derived || derived === home) {
        const err = new Error('Não foi possível derivar o caminho da FRA com segurança. Defina DB_FRA_DEST no .env.');
        err.needsConfig = true;
        throw err;
    }
    return safeIdent(derived.replace(/[\\/]+$/, '') + sep + 'fast_recovery_area', 'caminho da FRA');
}

/** Cria uma pasta no servidor de banco (idempotente). Lança em caso de falha. */
async function createServerDir(path, serverOs) {
    serverOs = serverOs || await detectServerOs();
    const p = safeIdent(path, 'caminho da pasta');

    let cmd;
    if (serverOs === 'windows') {
        // -EncodedCommand: opaco ao shell padrão (cmd ou PowerShell). -Force =
        // idempotente. Se houver uma conta de serviço Oracle configurada
        // (DB_OS_USER), concede a ela escrita na pasta via icacls — necessário
        // quando o serviço NÃO roda como LocalSystem. Sem DB_OS_USER é no-op
        // (LocalSystem já tem acesso ao que cria localmente).
        let ps = "$ProgressPreference='SilentlyContinue';" +
            `New-Item -ItemType Directory -Force -Path '${p}' | Out-Null`;
        const acct = config.oracleServer.osUser;
        if (acct) {
            const a = safeIdent(acct, 'DB_OS_USER');
            ps += `;icacls '${p}' /grant '${a}:(OI)(CI)M' | Out-Null`;
        }
        cmd = psEncoded(ps);
    } else {
        const mk = `mkdir -p '${p}' && chmod 750 '${p}'`;
        const owner = config.oracleServer.osUser;
        cmd = (config.ssh.host && owner && owner !== config.ssh.user)
            ? `su - ${safeIdent(owner, 'DB_OS_USER')} -c "${mk}"`
            : mk;
    }
    const r = await execOnServer(cmd);
    if (r.code !== 0) {
        throw new Error('Não foi possível criar a pasta no servidor: ' +
            scrubSecrets((r.stderr || r.stdout || 'erro desconhecido').trim()).slice(0, 300));
    }
    return p;
}

// ==========================================================================
// Dicas manuais (mostradas quando a automação não está pronta) — sem senha
// ==========================================================================

function connectHintRman() {
    if (!config.oracleServer.usesPasswordAuth) return 'rman target /';
    const alias = config.oracleServer.tnsAlias ? '@' + config.oracleServer.tnsAlias : '';
    return `rman target ${config.oracleServer.sysUser || 'sys'}/<senha>${alias}`;
}

function connectHintSqlplus() {
    if (!config.oracleServer.usesPasswordAuth) return 'sqlplus / as sysdba';
    const alias = config.oracleServer.tnsAlias ? '@' + config.oracleServer.tnsAlias : '';
    return `sqlplus ${config.oracleServer.sysUser || 'sys'}/<senha>${alias} as sysdba`;
}

function rmanHint(lines) {
    return connectHintRman() + '\n' + lines.map((l) => `RMAN> ${l}`).join('\n');
}

// ==========================================================================
// RETENÇÃO
// ==========================================================================

function retentionRmanScript(days) {
    return `CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF ${days} DAYS;`;
}
function retentionManualHint(days) {
    return rmanHint([retentionRmanScript(days)]);
}

async function setRetention(days) {
    const lines = [retentionRmanScript(days)];
    const manual = rmanHint(lines);
    if (config.demoMode) return { success: true, message: `Simulação: retenção definida para ${days} dias.`, manual };
    if (!config.oracleServer.rmanAutomationReady) {
        return { success: false, needsConfig: true, message: 'Automação do RMAN não configurada (DB_ORACLE_HOME/DB_ORACLE_SID). Rode o comando abaixo manualmente.', manual };
    }
    const { ok, output } = await runRman(lines);
    return ok
        ? { success: true, message: `Retenção do RMAN definida para janela de ${days} dias.`, manual }
        : { success: false, message: 'O RMAN não confirmou a alteração.', detail: output.slice(0, 500), manual };
}

// ==========================================================================
// POLÍTICA DE DELEÇÃO DE ARCHIVELOG (faz a FRA reciclar logs já copiados)
// ==========================================================================

async function setArchivelogDeletionPolicy(enable) {
    const policy = enable
        ? 'CONFIGURE ARCHIVELOG DELETION POLICY TO BACKED UP 1 TIMES TO DISK;'
        : 'CONFIGURE ARCHIVELOG DELETION POLICY TO NONE;';
    const manual = rmanHint([policy]);

    if (config.demoMode) {
        return { success: true, message: `Simulação: política de deleção de archive ${enable ? 'ATIVADA (BACKED UP 1 TIMES TO DISK)' : 'removida (NONE)'}.`, manual };
    }
    if (!config.oracleServer.rmanAutomationReady) {
        return { success: false, needsConfig: true, message: 'Automação do RMAN não configurada. Rode o comando abaixo manualmente.', manual };
    }
    const { ok, output } = await runRman([policy]);
    return ok
        ? { success: true, message: enable ? 'Política de deleção ativada: a FRA agora recicla archives já copiados.' : 'Política de deleção definida como NONE.', manual }
        : { success: false, message: 'O RMAN não confirmou a alteração.', detail: output.slice(0, 500), manual };
}

// ==========================================================================
// JOBS EM SEGUNDO PLANO (operações longas: DELETE OBSOLETE, BACKUP, ARCHIVELOG)
// ==========================================================================

const jobs = new Map();
const MAX_JOBS = 50; // mantém apenas os jobs mais recentes em memória
function getJob(jobId) { return jobs.get(jobId) || null; }

/** Lista os jobs mais recentes (para a tela de "logs de execução"). */
function listJobs(limit = 20) {
    return [...jobs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit)
        .map((j) => ({
            id: j.id, action: j.action, state: j.state, message: j.message,
            startedAt: j.startedAt, finishedAt: j.finishedAt,
            output: scrubSecrets(j.output || ''),
        }));
}

function createJob(action, message) {
    const job = { id: crypto.randomBytes(8).toString('hex'), action, state: 'running', message, output: '', startedAt: Date.now(), finishedAt: null };
    jobs.set(job.id, job);
    // Poda os jobs mais antigos para não crescer indefinidamente.
    if (jobs.size > MAX_JOBS) {
        const oldest = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, jobs.size - MAX_JOBS);
        oldest.forEach((j) => jobs.delete(j.id));
    }
    return job;
}

function assertReady() {
    if (!config.demoMode && !config.oracleServer.rmanAutomationReady) {
        const err = new Error('Defina DB_ORACLE_HOME e DB_ORACLE_SID no .env para executar esta operação automaticamente.');
        err.needsConfig = true;
        throw err;
    }
}

/** Inicia um job RMAN genérico em segundo plano. Retorna o jobId. */
function startRmanJob(action, rmanLines, ctx = {}, opts = {}) {
    assertReady();
    const job = createJob(action, opts.startMessage || 'Operação RMAN iniciada em segundo plano...');
    runRmanJob(job, rmanLines, ctx, opts).catch((err) => {
        job.state = 'failed';
        job.message = 'Erro inesperado: ' + scrubSecrets(err.message);
        job.finishedAt = Date.now();
    });
    return job.id;
}

async function runRmanJob(job, rmanLines, ctx, opts) {
    if (config.demoMode) {
        await new Promise((r) => setTimeout(r, 1500));
        job.state = 'done';
        job.message = opts.demoMessage || 'Operação RMAN concluída (modo DEMO).';
        job.output = opts.demoOutput || 'RMAN> ' + rmanLines.join('\nRMAN> ');
        job.finishedAt = Date.now();
        audit.record({ action: job.action, user: ctx.user, role: ctx.role, ip: ctx.ip, detail: '[DEMO] ' + rmanLines.join(' ') });
        return;
    }

    logger.info(`RMAN job [${job.action}] iniciado em segundo plano...`);
    const { ok, output } = await runRman(rmanLines);
    job.output = output.slice(0, 6000);
    job.state = ok ? 'done' : 'failed';
    job.message = ok ? (opts.okMessage || 'Operação concluída com sucesso.') : 'A operação RMAN falhou — veja o log abaixo.';
    job.finishedAt = Date.now();
    audit.record({ action: job.action, user: ctx.user, role: ctx.role, ip: ctx.ip, success: ok, detail: rmanLines.join(' ') });
}

/** DELETE OBSOLETE (NOPROMPT) — apaga fisicamente o que a retenção marcou. */
function startDeleteObsoleteJob(ctx) {
    return startRmanJob('delete-obsolete', ['DELETE NOPROMPT OBSOLETE;'], ctx, {
        startMessage: 'Removendo backups/arquivos obsoletos...',
        okMessage: 'Limpeza concluída: obsoletos removidos.',
        demoOutput: 'RMAN retention policy will be applied to the command\nRMAN retention policy is set to recovery window of 7 days\nDeleted 3 objects\n',
    });
}

/** Backup sob demanda. type: 'full' | 'archivelog'. DELETE INPUT libera a FRA. */
function startBackupJob(type, ctx) {
    const lines = type === 'archivelog'
        ? ['BACKUP ARCHIVELOG ALL DELETE INPUT;']
        : ['BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;'];
    return startRmanJob('backup', lines, ctx, {
        startMessage: type === 'archivelog' ? 'Fazendo backup dos archivelogs...' : 'Fazendo backup do banco + archivelogs...',
        okMessage: 'Backup concluído com sucesso.',
        demoOutput: 'Starting backup at ...\nchannel ORA_DISK_1: starting full datafile backup set\nFinished backup at ...\nStarting Control File Autobackup\nFinished Control File Autobackup\n',
    });
}

// ==========================================================================
// ARCHIVELOG ON/OFF (sqlplus, exige MOUNT/parada breve) — job em 2º plano
// ==========================================================================

function archivelogProcedure(enable) {
    const action = enable ? 'ARCHIVELOG' : 'NOARCHIVELOG';
    return [
        '-- ATENÇÃO: alterar o modo archivelog EXIGE parada breve do banco',
        '-- (o banco precisa passar pelo estado MOUNT). Execute em janela de manutenção:',
        connectHintSqlplus(),
        'SQL> SHUTDOWN IMMEDIATE;',
        'SQL> STARTUP MOUNT;',
        `SQL> ALTER DATABASE ${action};`,
        'SQL> ALTER DATABASE OPEN;',
        'SQL> ARCHIVE LOG LIST;',
    ].join('\n');
}

function startArchivelogJob(enable, ctx = {}) {
    assertReady();
    const job = createJob('archivelog', `Iniciando ${enable ? 'ativação' : 'desativação'} do archivelog (o banco será reiniciado brevemente)...`);
    runArchivelogJob(job, enable, ctx).catch((err) => {
        job.state = 'failed';
        job.message = 'Erro inesperado: ' + scrubSecrets(err.message);
        job.finishedAt = Date.now();
    });
    return job.id;
}

async function runArchivelogJob(job, enable, ctx) {
    const target = enable ? 'ARCHIVELOG' : 'NOARCHIVELOG';

    if (config.demoMode) {
        await new Promise((r) => setTimeout(r, 1500));
        job.state = 'done';
        job.message = `Simulação: banco agora em ${target} (modo DEMO, sem ação real).`;
        job.output = `Database log mode\t  ${enable ? 'Archive Mode' : 'No Archive Mode'}\nDatabase altered.`;
        job.finishedAt = Date.now();
        audit.record({ action: 'archivelog', user: ctx.user, role: ctx.role, ip: ctx.ip, detail: `[DEMO] -> ${target}` });
        return;
    }

    const serverOs = await detectServerOs();
    const { command, stdin, env } = buildArchivelogRun(enable, serverOs);
    logger.info(`Archivelog: executando ${target} no servidor [${serverOs}] em segundo plano...`);

    const result = await execOnServer(command, { stdin, env });
    const ok = archivelogSucceeded(result);
    const rawOut = `${result.stdout}\n${result.stderr}`;
    let launchHint = serverLaunchHint(rawOut);
    if (launchHint) launchHint = serverLaunchHint(rawOut, await windowsLaunchDiagnostics());
    else if (oracleHomeHint(rawOut)) launchHint = oracleHomeHint(rawOut);
    else if (connectPermissionHint(rawOut)) launchHint = connectPermissionHint(rawOut);
    let cleanOut = scrubSecrets(rawOut).trim();
    if (launchHint) cleanOut = `${launchHint}\n\n--- saída original ---\n${cleanOut}`;
    job.output = cleanOut.slice(0, 4000);

    // O SHUTDOWN já invalidou as conexões do pool em AMBOS os casos: recicla
    // sempre (ensurePool reconstrói sob demanda na próxima consulta). Se isso
    // ficasse só no sucesso, uma falha deixaria o painel com conexões mortas.
    try { await require('./db').closePool(); } catch { /* ignore */ }

    if (ok) {
        job.state = 'done';
        job.message = `Banco agora em ${target}. Reinício concluído com sucesso.`;
    } else {
        job.state = 'failed';
        // Detecta "banco desligado e não voltou" para dar uma mensagem acionável.
        const down = /ORA-0(1034|1089)|ORA-12514|ORA-12528|ORA-12541/i.test(rawOut);
        job.message = launchHint
            ? 'Falha de PERMISSÃO ao iniciar o sqlplus no servidor Windows — veja o diagnóstico no log abaixo (o banco NÃO foi alterado).'
            : down
                ? `ATENÇÃO: o banco foi DESLIGADO e o STARTUP não concluiu. Faça STARTUP manualmente no servidor` +
                  ` (ou inicie o serviço OracleService${config.oracleServer.sid || ''}) e verifique o listener.` +
                  ` Em Windows com conexão por alias TNS, o STARTUP exige registro ESTÁTICO do SID no listener.`
                : `Falha ao alterar para ${target}. Verifique o log abaixo e o estado do banco.`;
    }
    job.finishedAt = Date.now();
    audit.record({ action: 'archivelog', user: ctx.user, role: ctx.role, ip: ctx.ip, success: ok, detail: `-> ${target}${ok ? '' : ' (FALHOU)'}` });
}

module.exports = {
    retentionManualHint,
    setRetention,
    setArchivelogDeletionPolicy,
    archivelogProcedure,
    startArchivelogJob,
    startDeleteObsoleteJob,
    startBackupJob,
    getJob,
    listJobs,
    resolveFraPath,
    createServerDir,
    // Helpers expostos para teste/diagnóstico (não usam rede):
    buildServerCommand,
    buildRmanRun,
    buildArchivelogRun,
    rmanInvocation,
    sqlplusInvocation,
    scrubSecrets,
    serverLaunchHint,
    oracleHomeHint,
    connectPermissionHint,
};

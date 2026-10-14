#!/usr/bin/env node
/**
 * CONFIGURE-ENV.JS - Ferramenta do instalador Windows do Oracle Pulse.
 *
 * Comandos:
 *   write    --env <.env> --input <arquivo> --result <arquivo> [--app <pasta>] [--dry-run]
 *            Grava/atualiza o .env a partir dos valores digitados no instalador
 *            (--dry-run só valida, sem gravar nada).
 *   info     --env <.env> --result <arquivo>
 *            Informa a porta e o modo (DEMO/LIVE) de um .env existente.
 *   check-db --env <.env> --result <arquivo> [--timeout <segundos>]
 *            Testa a conexão com o Oracle usando os dados do .env.
 *
 * O arquivo de entrada tem uma linha "CHAVE=HEX" por campo, onde HEX são as
 * unidades UTF-16 do valor em 4 dígitos hexadecimais cada (vazio = valor
 * vazio). Assim nenhum caractere de senha (#, aspas, espaços, $, \) precisa ser
 * escapado entre o Pascal do instalador e este script.
 *
 * O resultado vai para --result em UTF-8: 1ª linha "OK", "ERRO", "FALHA" ou
 * "IGNORADO"; as demais são CHAVE=valor (info) ou a mensagem para o usuário.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

// Campos especiais da entrada: senhas em texto puro que viram hash scrypt.
const PASSWORD_INPUTS = { AUTH_PASS: 'AUTH_PASS_HASH', AUTH_VIEWER_PASS: 'AUTH_VIEWER_PASS_HASH' };

// Layout do .env gerado (mesmas seções e comentários do .env.example).
// Cada item: [CHAVE, valorPadrão] ou uma linha de comentário (string).
const LAYOUT = [
    '# ==========================================',
    '# Oracle Pulse - configuração gerada pelo instalador',
    '# Para alterar: execute o instalador novamente (opção "Revisar e alterar")',
    '# ou edite este arquivo como Administrador e reinicie o serviço OraclePulse.',
    '# ==========================================',
    '',
    '# ----- Servidor / Modo de operação -----',
    ['PORT', '3000'],
    '# Se true, usa dados simulados e não toca em banco real (demonstração)',
    ['DEMO_MODE', 'false'],
    '# Nível de log: debug | info | warn | error',
    ['LOG_LEVEL', 'info'],
    '',
    '# ----- Conexão Oracle -----',
    ['DB_USER', ''],
    ['DB_PASSWORD', ''],
    ['DB_HOST', ''],
    ['DB_PORT', '1521'],
    ['DB_SERVICE', ''],
    '# Pasta \\bin do Oracle Client 64-bit (modo THICK). Vazio = modo THIN (recomendado).',
    ['ORACLE_CLIENT_PATH', ''],
    ['DB_POOL_MIN', '1'],
    ['DB_POOL_MAX', '10'],
    ['DB_POOL_INCREMENT', '1'],
    '',
    '# ----- Acesso ao SO do servidor de banco (disco, memória, RMAN) -----',
    '# Deixe SSH_HOST vazio se o banco roda na mesma máquina do painel.',
    ['SSH_HOST', ''],
    ['SSH_USER', ''],
    ['SSH_PASSWORD', ''],
    ['SSH_PORT', '22'],
    ['SSH_PRIVATE_KEY_PATH', ''],
    ['SSH_DEBUG', 'false'],
    '',
    '# ----- Segurança / Login -----',
    '# Conta DBA (acesso total). Hash scrypt gerado pelo instalador.',
    ['AUTH_USER', 'DBA'],
    ['AUTH_PASS_HASH', ''],
    '# (Opcional) Conta somente-leitura (perfil "viewer")',
    ['AUTH_VIEWER_USER', ''],
    ['AUTH_VIEWER_PASS_HASH', ''],
    ['AUTH_TOKEN_TTL_MIN', '480'],
    '',
    '# ----- Ambiente Oracle no SERVIDOR (opcional: automação RMAN/archivelog) -----',
    ['DB_ORACLE_HOME', ''],
    ['DB_ORACLE_SID', ''],
    ['DB_OS_USER', ''],
    ['DB_SYS_USER', 'sys'],
    ['DB_SYS_PASSWORD', ''],
    ['DB_TNS_ALIAS', ''],
    ['DB_FRA_DEST', ''],
    '',
    '# ----- Alertas -----',
    ['ALERT_WEBHOOK_URL', ''],
    ['ALERT_TABLESPACE_PCT', '90'],
    ['ALERT_DISK_PCT', '85'],
    ['ALERT_MEMORY_PCT', '90'],
];

const LAYOUT_KEYS = LAYOUT.filter(Array.isArray).map(([k]) => k);

class UserError extends Error {}

const BOM = String.fromCharCode(0xfeff);
const BOM_RE = new RegExp('^' + BOM);

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) args[key] = true;
            else { args[key] = next; i++; }
        } else {
            args._.push(a);
        }
    }
    return args;
}

/** Decodifica "HEX" (unidades UTF-16 de 4 dígitos) para string. */
function decodeHex(hex) {
    const h = String(hex || '').trim();
    if (h.length % 4 !== 0 || /[^0-9a-f]/i.test(h)) {
        throw new Error('Valor hexadecimal inválido no arquivo de entrada.');
    }
    let s = '';
    for (let i = 0; i < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s;
}

/** Lê o arquivo de entrada do instalador: { CHAVE: valor }. */
function readInput(file) {
    const text = fs.readFileSync(file, 'utf8').replace(BOM_RE, '');
    const values = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) throw new Error(`Linha inválida no arquivo de entrada: ${line.slice(0, 40)}`);
        const key = line.slice(0, eq).trim();
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Chave inválida no arquivo de entrada: ${key}`);
        values[key] = decodeHex(line.slice(eq + 1));
    }
    return values;
}

/** Mesmo formato de bin/hash-password.js (verificado por src/auth.js). */
function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 32).toString('hex');
    return `scrypt$${salt.toString('hex')}$${hash}`;
}

// Linhas bem formadas que oferecem, para cada tipo de aspa, um "fim válido"
// (aspa seguida de comentário). Um valor mal delimitado que avance para as
// linhas seguintes termina numa delas e é lido errado — e assim é detectado.
const PROBE_LINES = [
    ['PROBE_A', "'#a'", '#a'], ['PROBE_B', '"#b"', '#b'], ['PROBE_C', '`#c`', '#c'],
    ['PROBE_D', '"it\'s #d"', "it's #d"], ['PROBE_E', "'say \"e\" #e'", 'say "e" #e'],
    ['PROBE_F', '# comentário', ''], ['PROBE_Z', 'fim', 'fim'],
];
const PROBE_TAIL = PROBE_LINES.map(([k, repr]) => `${k}=${repr}`).join('\n');

function survivesProbe(key, value, repr) {
    for (const before of ['', PROBE_TAIL + '\n']) {
        const parsed = dotenv.parse(`${before}${key}=${repr}\n${PROBE_TAIL}\n`);
        if (parsed[key] !== value) return false;
        if (!PROBE_LINES.every(([k, , expected]) => parsed[k] === expected)) return false;
    }
    return true;
}

/**
 * Escolhe uma forma de escrever o valor que o dotenv lê de volta EXATAMENTE
 * igual, em qualquer posição do arquivo. O parser do dotenv não tem escape de
 * aspas: um valor entre aspas que contém a própria aspa, ou que termina em "\"
 * (vira \' ou \"), pode avançar pelas linhas seguintes; um valor sem aspas é
 * cortado no "#" e aparado nas bordas. Cada forma (sem aspas, '…', "…", `…`)
 * é testada no parser real contra linhas adversárias; usa-se a primeira que
 * sobrevive. O arquivo final ainda é conferido inteiro em cmdWrite.
 */
function serializeValue(key, value) {
    if (/[\r\n]/.test(value)) {
        throw new UserError(`O valor de ${key} não pode conter quebra de linha.`);
    }
    for (const c of [value, `'${value}'`, `"${value}"`, `\`${value}\``]) {
        if (survivesProbe(key, value, c)) return c;
    }
    throw new UserError(`O valor de ${key} tem uma combinação de caracteres que o arquivo .env não consegue ` +
        'representar: termina com "\\" ou contém os três tipos de aspas (\' " `), junto com "#", espaço nas ' +
        'bordas ou aspa no início. Altere esse valor.');
}

function isTrue(v) {
    return String(v).toLowerCase() === 'true';
}

function validPort(v) {
    return /^\d{1,5}$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 65535;
}

/** Validações equivalentes às de src/config.js (validateConfig) + formatos. */
function validate(env) {
    const problems = [];
    if (!env.AUTH_USER) problems.push('Usuário de login do painel (AUTH_USER) é obrigatório.');
    if (!env.AUTH_PASS_HASH) problems.push('Senha de login do painel é obrigatória.');
    if (env.AUTH_VIEWER_USER && !env.AUTH_VIEWER_PASS_HASH) {
        problems.push('Informe a senha da conta somente-leitura (ou deixe o usuário dela em branco).');
    }
    if (!validPort(env.PORT)) problems.push('Porta do painel (PORT) deve ser um número entre 1 e 65535.');
    if (env.SSH_PORT && !validPort(env.SSH_PORT)) problems.push('Porta SSH deve ser um número entre 1 e 65535.');
    if (!isTrue(env.DEMO_MODE)) {
        if (!env.DB_HOST) problems.push('Host do banco Oracle (DB_HOST) é obrigatório.');
        if (!validPort(env.DB_PORT)) problems.push('Porta do banco Oracle (DB_PORT) deve ser um número entre 1 e 65535.');
        if (!env.DB_SERVICE) problems.push('Service name do Oracle (DB_SERVICE) é obrigatório.');
        if (!env.DB_USER) problems.push('Usuário do banco Oracle (DB_USER) é obrigatório.');
        if (!env.DB_PASSWORD) problems.push('Senha do banco Oracle (DB_PASSWORD) é obrigatória.');
    }
    if (problems.length) throw new UserError(problems.join('\n'));
}

function writeResult(file, status, lines) {
    if (!file) return;
    const body = [status, ...[].concat(lines || [])].join('\r\n') + '\r\n';
    fs.writeFileSync(file, BOM + body, 'utf8');
}

function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Montagem do .env
// ---------------------------------------------------------------------------

/**
 * Aplica a entrada do instalador sobre o .env existente (se houver):
 *  - chaves ausentes da entrada mantêm o valor atual;
 *  - senha do painel em branco mantém o hash atual;
 *  - chaves desconhecidas do .env atual são preservadas.
 */
function buildEnv(existing, input) {
    const env = { ...existing };
    for (const [key, value] of Object.entries(input)) {
        if (PASSWORD_INPUTS[key]) continue;
        env[key] = value;
    }
    for (const [inKey, hashKey] of Object.entries(PASSWORD_INPUTS)) {
        if (input[inKey]) env[hashKey] = hashPassword(input[inKey]);
    }
    // Sem usuário somente-leitura, não deixa hash órfão para trás.
    if (!env.AUTH_VIEWER_USER) env.AUTH_VIEWER_PASS_HASH = '';
    for (const item of LAYOUT) {
        if (Array.isArray(item) && env[item[0]] === undefined) env[item[0]] = item[1];
    }
    return env;
}

function renderEnv(env) {
    const out = [];
    for (const item of LAYOUT) {
        if (Array.isArray(item)) out.push(`${item[0]}=${serializeValue(item[0], env[item[0]])}`);
        else out.push(item);
    }
    const extras = Object.keys(env).filter((k) => !LAYOUT_KEYS.includes(k));
    if (extras.length) {
        out.push('', '# ----- Outras configurações (preservadas do .env anterior) -----');
        for (const k of extras) out.push(`${k}=${serializeValue(k, env[k])}`);
    }
    return out.join('\r\n') + '\r\n';
}

/** Roda o validateConfig() REAL da aplicação num processo separado. */
function runAppValidation(appDir) {
    const code = [
        "const { validateConfig } = require('./src/config');",
        'try {',
        '  const w = validateConfig() || [];',
        "  process.stderr.write('@@WARN@@' + JSON.stringify(w) + '\\n');",
        '} catch (e) {',
        "  process.stderr.write('@@FAIL@@' + JSON.stringify(e.message) + '\\n');",
        '  process.exit(2);',
        '}',
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', code], {
        cwd: appDir,
        encoding: 'utf8',
        env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
        timeout: 30000,
        windowsHide: true,
    });
    const err = r.stderr || '';
    const fail = err.match(/@@FAIL@@(.*)/);
    if (fail) throw new UserError(JSON.parse(fail[1]));
    const warn = err.match(/@@WARN@@(.*)/);
    if (r.status !== 0 || !warn) {
        throw new Error(`Falha ao validar a configuração com a aplicação: ${(r.error && r.error.message) || err.trim() || 'código ' + r.status}`);
    }
    return JSON.parse(warn[1]);
}

function cmdWrite(args) {
    if (!args.env || !args.input) throw new Error('Uso: write --env <arquivo> --input <arquivo> --result <arquivo> [--app <pasta>]');
    const envFile = path.resolve(args.env);
    const input = readInput(args.input);
    const hadExisting = fs.existsSync(envFile);
    const existing = hadExisting ? dotenv.parse(fs.readFileSync(envFile)) : {};

    const env = buildEnv(existing, input);
    validate(env);
    const text = renderEnv(env);

    // Conferência final: o arquivo inteiro precisa voltar idêntico pelo dotenv.
    const back = dotenv.parse(text);
    for (const [k, v] of Object.entries(env)) {
        if (back[k] !== v) throw new Error(`Conferência do .env falhou na chave ${k}.`);
    }
    // --dry-run: só valida (usado pelo assistente antes de instalar qualquer coisa).
    if (args['dry-run']) return ['OK', [`PORT=${env.PORT}`, `DEMO_MODE=${isTrue(env.DEMO_MODE)}`]];

    let backup = null;
    if (hadExisting) {
        backup = `${envFile}.bak-${timestamp()}`;
        fs.copyFileSync(envFile, backup);
    }
    const tmp = `${envFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, envFile);

    let warnings = [];
    if (args.app) {
        try {
            warnings = runAppValidation(path.resolve(args.app));
        } catch (err) {
            // Não deixa um .env rejeitado pela aplicação no lugar do anterior.
            if (backup) fs.copyFileSync(backup, envFile);
            else fs.unlinkSync(envFile);
            throw err;
        }
    }
    return ['OK', [`PORT=${env.PORT}`, `DEMO_MODE=${isTrue(env.DEMO_MODE)}`,
        ...(backup ? [`BACKUP=${backup}`] : []), ...warnings.map((w) => `AVISO=${w}`)]];
}

function cmdInfo(args) {
    if (!args.env) throw new Error('Uso: info --env <arquivo> --result <arquivo>');
    const env = dotenv.parse(fs.readFileSync(path.resolve(args.env)));
    const port = env.PORT ? env.PORT.trim() : '3000';
    if (!validPort(port)) throw new UserError(`PORT inválida no .env: "${env.PORT}"`);
    return ['OK', [`PORT=${Number(port)}`, `DEMO_MODE=${isTrue(env.DEMO_MODE)}`]];
}

// ---------------------------------------------------------------------------
// Teste de conexão com o Oracle (mesma lógica de src/db.js)
// ---------------------------------------------------------------------------

function explainOraError(message) {
    const m = String(message || '');
    const hints = [
        [/ORA-01017/, 'Usuário ou senha do Oracle incorretos.'],
        [/ORA-12514|NJS-518/, 'O listener não conhece esse SERVICE NAME. Confira DB_SERVICE (ex.: o valor de "lsnrctl status").'],
        [/ORA-12541|NJS-511|ECONNREFUSED/, 'Nada escutando nesse host/porta. Confira DB_HOST, DB_PORT e se o listener está no ar.'],
        [/ENOTFOUND|EAI_AGAIN|getaddrinfo/, 'Não foi possível resolver o nome do servidor. Use o IP em DB_HOST.'],
        [/ETIMEDOUT|NJS-510|timed out|timeout/i, 'Tempo esgotado: verifique firewall, host e porta.'],
        [/ORA-28000/, 'A conta do Oracle está bloqueada.'],
        [/ORA-28001/, 'A senha do Oracle expirou.'],
        [/ORA-01031/, 'Privilégios insuficientes (para conectar como SYS é necessário SYSDBA).'],
        [/NJS-138|NJS-116/, 'O modo THIN não suporta esta versão/configuração do banco. Instale o Oracle Client 64-bit e informe ORACLE_CLIENT_PATH.'],
    ];
    const hit = hints.find(([re]) => re.test(m));
    return hit ? hit[1] : '';
}

async function cmdCheckDb(args) {
    if (!args.env) throw new Error('Uso: check-db --env <arquivo> --result <arquivo> [--timeout <s>]');
    const env = dotenv.parse(fs.readFileSync(path.resolve(args.env)));
    if (isTrue(env.DEMO_MODE)) return ['IGNORADO', ['Modo DEMO: o painel não conecta ao banco.']];

    const oracledb = require('oracledb');
    const notes = [];
    if (env.ORACLE_CLIENT_PATH) {
        try {
            oracledb.initOracleClient({ libDir: env.ORACLE_CLIENT_PATH });
            notes.push(`Oracle Client (modo THICK) carregado de ${env.ORACLE_CLIENT_PATH}.`);
        } catch (err) {
            notes.push(`Aviso: Oracle Client não carregou (${err.message.split('\n')[0]}); o painel usará o modo THIN.`);
        }
    }
    const isSys = String(env.DB_USER || '').toLowerCase() === 'sys';
    const opts = {
        user: isSys ? 'SYS' : env.DB_USER,
        password: env.DB_PASSWORD,
        connectString: `${env.DB_HOST}:${env.DB_PORT}/${env.DB_SERVICE}`,
        connectTimeout: 15,
        transportConnectTimeout: 15,
    };
    if (isSys) opts.privilege = oracledb.SYSDBA;

    let conn;
    try {
        conn = await oracledb.getConnection(opts);
    } catch (err) {
        const first = String(err.message || err).split('\n')[0];
        const hint = explainOraError(err.message);
        return ['FALHA', [`Não foi possível conectar em ${opts.connectString} como ${env.DB_USER}:`, first, ...(hint ? [hint] : []), ...notes]];
    }
    try {
        const r = await conn.execute('SELECT instance_name, version, status FROM v$instance', [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const row = (r.rows && r.rows[0]) || {};
        return ['OK', [`Conectado: instância ${row.INSTANCE_NAME} (Oracle ${row.VERSION}, ${row.STATUS}).`, ...notes]];
    } catch (err) {
        const first = String(err.message || err).split('\n')[0];
        return ['FALHA', ['Conectou ao banco, mas o usuário não consegue ler V$INSTANCE:', first,
            `Conceda ao usuário ${env.DB_USER} acesso às views V$/DBA_ (ex.: GRANT SELECT_CATALOG_ROLE TO ${env.DB_USER}).`, ...notes]];
    } finally {
        try { await conn.close(); } catch { /* ignora */ }
    }
}

// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const command = args._[0];
    const handlers = { write: cmdWrite, info: cmdInfo, 'check-db': cmdCheckDb };
    const handler = handlers[command];
    if (!handler) {
        console.error('Comandos: write | info | check-db');
        process.exit(64);
    }

    if (command === 'check-db') {
        const seconds = Number(args.timeout) > 0 ? Number(args.timeout) : 30;
        setTimeout(() => {
            writeResult(args.result, 'FALHA', [`Tempo esgotado (${seconds}s) ao conectar no Oracle. Verifique host, porta, service name e firewall.`]);
            process.exit(3);
        }, seconds * 1000).unref();
    }

    try {
        const [status, lines] = await handler(args);
        writeResult(args.result, status, lines);
        console.log([status, ...lines].join('\n'));
        process.exit(status === 'OK' || status === 'IGNORADO' ? 0 : 3);
    } catch (err) {
        const msg = err instanceof UserError ? err.message : `Erro inesperado: ${err.message}`;
        writeResult(args.result, 'ERRO', msg.split('\n'));
        console.error(msg);
        process.exit(err instanceof UserError ? 2 : 1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { decodeHex, readInput, hashPassword, serializeValue, buildEnv, renderEnv, validate, LAYOUT_KEYS };

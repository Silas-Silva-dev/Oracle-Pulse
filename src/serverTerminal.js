/**
 * SERVERTERMINAL.JS - Console de comandos no servidor do banco (tela "Terminal").
 *
 * Reaproveita exatamente os mesmos canais já usados pela tela Recuperação e pelos
 * backups — nada de novo em termos de acesso:
 *   os       shell do servidor (local: cmd/sh do painel; remoto: sessão SSH)
 *   sqlplus  sqlplus conectado AS SYSDBA (SET, ALTER, SELECT, STARTUP/SHUTDOWN...)
 *   rman     RMAN conectado ao target (BACKUP, RESTORE, CROSSCHECK, LIST...)
 *
 * Proteções (iguais às do resto do painel):
 *  - somente DBA (a rota usa requireDba);
 *  - toda execução é auditada (modo + 1ª linha do comando);
 *  - a senha do SYS nunca entra na linha de comando (vai por stdin) e é mascarada
 *    na saída e na auditoria (scrubSecrets);
 *  - execução síncrona com tempo-limite (backups longos continuam na tela Backup).
 */
const { config } = require('./config');
const { execOnServer, detectServerOs } = require('./osDisk');
const backupAdmin = require('./backupAdmin');
const collect = require('./recovery/collect');
const logger = require('./logger');

const MODES = ['os', 'sqlplus', 'rman'];
const MAX_COMMAND = 100000;      // ~100 KB de script
const MAX_OUTPUT = 200000;       // corta a saída exibida
const DEFAULT_TIMEOUT = 120000;  // 2 min
const MAX_TIMEOUT = 600000;      // 10 min (backups longos: usar a tela Backup)

/** O painel consegue lançar sqlplus/rman neste alvo? */
function automationReady(serverOs) {
    // Windows LOCAL (mesma máquina do banco): basta o SID; o exe vem do PATH.
    if (serverOs === 'windows' && !config.ssh.host) return !!config.oracleServer.sid;
    // Linux ou acesso remoto: precisa de ORACLE_HOME + ORACLE_SID.
    return config.oracleServer.rmanAutomationReady;
}

function clampTimeout(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULT_TIMEOUT;
    return Math.min(Math.max(Math.round(n), 1000), MAX_TIMEOUT);
}

/** Descrição do "onde" o comando roda, para a interface. */
function shellLabel(mode, serverOs) {
    if (mode === 'sqlplus') return config.oracleServer.usesPasswordAuth ? 'sqlplus AS SYSDBA (senha do SYS)' : 'sqlplus / AS SYSDBA (autenticação por SO)';
    if (mode === 'rman') return config.oracleServer.usesPasswordAuth ? 'rman target (senha do SYS)' : 'rman target / (autenticação por SO)';
    if (config.ssh.host) return `sessão SSH em ${config.ssh.host} (${serverOs})`;
    return serverOs === 'windows' ? 'cmd.exe (máquina do painel)' : '/bin/sh (máquina do painel)';
}

function clip(text) {
    const s = String(text == null ? '' : text);
    return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n... (saída truncada em ${MAX_OUTPUT} caracteres)` : s;
}

/** 1ª linha não vazia do comando, para a auditoria. */
function firstLine(command) {
    const l = String(command || '').split(/\r?\n/).map((x) => x.trim()).find((x) => x) || '';
    return backupAdmin.scrubSecrets(l).slice(0, 200);
}

/**
 * Executa um comando no servidor.
 * @param {object} p { mode, command, timeoutMs, onOutput }
 * @returns {Promise<{ok:boolean, code:number, output:string, mode:string, serverOs:string, shell:string}>}
 */
async function run({ mode, command, timeoutMs, onOutput } = {}) {
    if (!MODES.includes(mode)) throw badRequest(`Modo inválido (use ${MODES.join(', ')}).`);
    const text = String(command == null ? '' : command);
    if (!text.trim()) throw badRequest('Digite um comando para executar.');
    if (text.length > MAX_COMMAND) throw badRequest(`Comando muito grande (máx. ${MAX_COMMAND} caracteres).`);
    const t = clampTimeout(timeoutMs);
    const emit = typeof onOutput === 'function' ? (chunk) => onOutput(backupAdmin.scrubSecrets(String(chunk))) : null;

    if (config.demoMode) return demoRun(mode, text);

    const serverOs = await detectServerOs();
    const shell = shellLabel(mode, serverOs);

    if (mode !== 'os' && !automationReady(serverOs)) {
        throw badRequest(serverOs === 'windows'
            ? 'Defina DB_ORACLE_SID no .env (e DB_SYS_PASSWORD) para usar sqlplus/RMAN pelo painel.'
            : 'Defina DB_ORACLE_HOME e DB_ORACLE_SID no .env (e DB_SYS_PASSWORD, ou SSH_* para banco remoto) para usar sqlplus/RMAN pelo painel.');
    }

    let res;
    if (mode === 'os') {
        if (!config.ssh.host) {
            // Sem SSH, o comando roda na MÁQUINA DO PAINEL: só é "o servidor" quando o
            // painel está instalado no próprio servidor do banco.
            const panelOs = process.platform === 'win32' ? 'windows' : 'linux';
            if (serverOs !== panelOs) {
                throw badRequest(`O banco é ${serverOs} e o painel roda em ${panelOs}: configure o acesso SSH (SSH_* no .env) para abrir o terminal do servidor.`);
            }
        }
        const r = await execOnServer(text, { timeoutMs: t, onOutput: emit });
        res = { code: r.code, output: `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}` };
    } else if (mode === 'sqlplus') {
        const lines = text.split(/\r?\n/);
        const r = await collect.runSysdba(lines, { serverOs, timeoutMs: t, onOutput: emit });
        res = { code: r.code, output: r.output };
        // STARTUP/SHUTDOWN reiniciam a instância: fecha o pool para reconectar limpo.
        if (/\b(startup|shutdown)\b/i.test(text)) await closePoolSafe();
    } else {
        const { command: cmd, env, stdin } = backupAdmin.buildRmanRun(text.split(/\r?\n/), serverOs);
        const r = await execOnServer(cmd, { stdin, env, timeoutMs: t, onOutput: emit });
        res = { code: r.code, output: `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}` };
    }

    const output = clip(backupAdmin.scrubSecrets(res.output).replace(/^\s+$/, '').trim() || '(sem saída)');
    return { ok: res.code === 0, code: res.code, output, mode, serverOs, shell };
}

async function closePoolSafe() {
    try { await require('./db').closePool(); } catch (err) { logger.warn('Terminal: não foi possível fechar o pool após STARTUP/SHUTDOWN:', err.message); }
}

function badRequest(message) {
    const e = new Error(message);
    e.status = 400;
    return e;
}

// ==========================================================================
// DEMO — saída plausível, sem tocar em nada
// ==========================================================================
function demoRun(mode, command) {
    const out = [];
    const first = command.split(/\r?\n/).find((l) => l.trim()) || '';
    if (mode === 'sqlplus') {
        out.push('SQL*Plus: Release 19.0.0.0.0 - Production', 'Connected to:', 'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0', '');
        for (const raw of command.split(/\r?\n/)) {
            const l = raw.trim();
            if (!l) continue;
            if (/^set\b/i.test(l)) continue;
            else if (/^startup/i.test(l)) out.push('ORACLE instance started.', 'Database mounted.', /nomount/i.test(l) ? '' : (/mount/i.test(l) ? '' : 'Database opened.'));
            else if (/^shutdown/i.test(l)) out.push('Database closed.', 'Database dismounted.', 'ORACLE instance shut down.');
            else if (/^alter\b/i.test(l)) out.push('Database altered.');
            else if (/^select/i.test(l)) out.push('STATUS', '------------', 'OPEN', '');
            else out.push('(simulação DEMO)');
        }
    } else if (mode === 'rman') {
        out.push('Recovery Manager: Release 19.0.0.0.0 - Production', '', 'connected to target database: ORCL (DBID=1612345678)', '');
        if (/list backup/i.test(command)) out.push('List of Backup Sets', '===================', 'BS Key  Type LV Size       Device Type', '412     Full    12.40G     DISK');
        else if (/crosscheck/i.test(command)) out.push('crosschecked backup piece: found to be AVAILABLE');
        else if (/backup/i.test(command)) out.push('Starting backup at ' + new Date().toLocaleString('pt-BR'), 'Finished backup', 'Starting Control File and SPFILE Autobackup', 'Finished Control File and SPFILE Autobackup');
        else out.push('(simulação DEMO)');
        out.push('', 'Recovery Manager complete.');
    } else {
        out.push(`$ ${first}`, '(simulação DEMO — nenhum comando é executado no modo demonstração)');
    }
    return { ok: true, code: 0, output: out.join('\n'), mode, serverOs: 'linux', shell: shellLabel(mode, 'linux'), demo: true };
}

module.exports = { run, MODES, firstLine, automationReady, shellLabel };

'use strict';
// Terminal do servidor: roteia para o canal certo (SO / sqlplus / RMAN), audita e mascara a senha.
process.env.DEMO_MODE = 'false';
process.env.DB_ORACLE_HOME = '/u01/app/oracle/product/19.0.0/dbhome_1';
process.env.DB_ORACLE_SID = 'orcl';
process.env.DB_SYS_PASSWORD = 'Sys#Senha1';
process.env.DB_TNS_ALIAS = '';
process.env.SSH_HOST = 'db.exemplo.local';
process.env.SSH_USER = 'root';
process.env.SSH_PASSWORD = 'segredo';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SYS_PWD = process.env.DB_SYS_PASSWORD;

// ---- canais falsos -------------------------------------------------------
const calls = { exec: [], sysdba: [], rman: [], closePool: 0 };
let serverOs = 'linux';

const osDisk = {
    detectServerOs: async () => serverOs,
    execOnServer: async (command, opts = {}) => {
        calls.exec.push({ command, opts });
        if (opts.onOutput) opts.onOutput('linha de saída\n');
        return { code: 0, stdout: `saída de: ${command}`, stderr: '' };
    },
    psEncoded: (s) => `ENC(${s})`,
    closeSsh: () => {},
    getOsMemory: async () => ({}),
    readDiskUsage: async () => ({}),
};
inject('../src/osDisk', osDisk);

const scrubSecrets = (t) => (t == null ? t : String(t).split(SYS_PWD).join('********'));
inject('../src/backupAdmin', {
    scrubSecrets,
    buildRmanRun: (lines, os) => { calls.rman.push({ lines, os }); return { command: 'rman', env: null, stdin: `CONNECT TARGET sys/${SYS_PWD};\n${lines.join('\n')}\nEXIT;\n` }; },
});
inject('../src/recovery/collect', {
    runSysdba: async (lines, opts = {}) => {
        calls.sysdba.push({ lines, opts });
        if (opts.onOutput) opts.onOutput('SQL> ...\n');
        return { code: 0, output: `CONNECT sys/${SYS_PWD} AS SYSDBA\n${lines.join('\n')}\nEstado: OPEN`, serverOs: opts.serverOs };
    },
});
inject('../src/db', { closePool: async () => { calls.closePool++; } });

function inject(rel, exportsObj) {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

const terminal = require('../src/serverTerminal');

// ---- testes --------------------------------------------------------------
test('validação: modo e comando', async () => {
    await assert.rejects(terminal.run({ mode: 'hack', command: 'x' }), /Modo inválido/);
    await assert.rejects(terminal.run({ mode: 'os', command: '   ' }), /Digite um comando/);
    await assert.rejects(terminal.run({ mode: 'os', command: 'x'.repeat(100001) }), /muito grande/);
});

test('SO: roda o comando cru no servidor e devolve a saída', async () => {
    calls.exec = [];
    const r = await terminal.run({ mode: 'os', command: 'df -h /u01' });
    assert.equal(calls.exec.length, 1);
    assert.equal(calls.exec[0].command, 'df -h /u01', 'comando passado sem alteração');
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'os');
    assert.match(r.output, /saída de: df -h \/u01/);
    assert.match(r.shell, /SSH/);
});

test('sqlplus: conecta AS SYSDBA, uma linha por comando; STARTUP/SHUTDOWN fecham o pool', async () => {
    calls.sysdba = []; calls.closePool = 0;
    const r = await terminal.run({ mode: 'sqlplus', command: 'SET LINESIZE 200\nSELECT status FROM v$instance;' });
    assert.deepEqual(calls.sysdba[0].lines, ['SET LINESIZE 200', 'SELECT status FROM v$instance;']);
    assert.equal(calls.sysdba[0].opts.serverOs, 'linux');
    assert.equal(r.ok, true);
    assert.equal(calls.closePool, 0, 'sem reinício: pool intacto');

    await terminal.run({ mode: 'sqlplus', command: 'SHUTDOWN IMMEDIATE;\nSTARTUP MOUNT;' });
    assert.equal(calls.closePool, 1, 'STARTUP/SHUTDOWN reinicia: fecha o pool para reconectar');
});

test('RMAN: usa buildRmanRun e envia pela entrada padrão', async () => {
    calls.rman = []; calls.exec = [];
    const r = await terminal.run({ mode: 'rman', command: 'LIST BACKUP SUMMARY;' });
    assert.deepEqual(calls.rman[0].lines, ['LIST BACKUP SUMMARY;']);
    assert.equal(calls.exec[0].command, 'rman');
    assert.match(calls.exec[0].opts.stdin, /LIST BACKUP SUMMARY;/);
    assert.equal(r.ok, true);
});

test('a senha do SYS nunca aparece na saída', async () => {
    const r = await terminal.run({ mode: 'sqlplus', command: 'SELECT 1 FROM dual;' });
    assert.ok(!r.output.includes(SYS_PWD), 'saída mascarada');
    assert.match(r.output, /\*{4,}/);
    // E o resumo para a auditoria também mascara.
    assert.ok(!terminal.firstLine(`CONNECT sys/${SYS_PWD}@master`).includes(SYS_PWD));
});

test('SO: painel em SO diferente do servidor e sem SSH não abre o terminal', async () => {
    // Simula ausência de SSH mexendo só neste teste.
    const { config } = require('../src/config');
    const realHost = config.ssh.host;
    config.ssh.host = null;
    serverOs = process.platform === 'win32' ? 'linux' : 'windows';
    try {
        await assert.rejects(terminal.run({ mode: 'os', command: 'ls' }), /configure o acesso SSH/i);
    } finally {
        config.ssh.host = realHost;
        serverOs = 'linux';
    }
});

test('automationReady: Windows local basta o SID; Linux exige HOME+SID', () => {
    assert.equal(terminal.automationReady('windows'), true, 'win local: SID presente');
    assert.equal(terminal.automationReady('linux'), true, 'linux: HOME+SID presentes');
    assert.deepEqual(terminal.MODES, ['os', 'sqlplus', 'rman']);
});

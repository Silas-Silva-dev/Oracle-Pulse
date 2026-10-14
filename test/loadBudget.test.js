'use strict';
// Carga do painel sobre o banco e o servidor: quantas consultas/conexões SSH por minuto.
process.env.DEMO_MODE = 'false';
process.env.SSH_HOST = 'db.exemplo.local';
process.env.SSH_USER = 'root';
process.env.SSH_PASSWORD = 'segredo';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');

// Banco falso: conta as idas ao banco por consulta.
const calls = {};
const fakeDb = {
    runQuery: async (name) => { calls[name] = (calls[name] || 0) + 1; return name === 'defaultDataPath' ? [{ PATH: '/u01/oradata/ORCL/' }] : []; },
    tag: (s) => s,
};
require.cache[require.resolve('../src/db')] = { id: 'db', filename: require.resolve('../src/db'), loaded: true, exports: fakeDb };

// SSH falso: conta conexões e comandos.
class FakeSSH {
    constructor() { FakeSSH.made++; this.connected = false; this.connection = new EventEmitter(); }
    async connect() {
        FakeSSH.connects++;
        if (FakeSSH.refuse) throw Object.assign(new Error('connect ECONNREFUSED 26.0.0.1:22'), { level: 'client-socket' });
        this.connected = true;
    }
    isConnected() { return this.connected; }
    async execCommand(cmd, opts = {}) {
        FakeSSH.execs.push({ cmd, stdin: opts.stdin });
        if (FakeSSH.failNext) { FakeSSH.failNext = false; this.connected = false; throw new Error('Not connected to server'); }
        return { code: 0, stdout: `ok ${cmd}`, stderr: '' };
    }
    dispose() { FakeSSH.disposed++; this.connected = false; this.connection.emit('close'); }
}
Object.assign(FakeSSH, { made: 0, connects: 0, disposed: 0, execs: [], failNext: false });
const sshPath = require.resolve('node-ssh', { paths: [path.join(__dirname, '..')] });
require.cache[sshPath] = { id: 'node-ssh', filename: sshPath, loaded: true, exports: { NodeSSH: FakeSSH } };

const cache = require('../src/cache');
const dashboard = require('../src/dashboardService');
const osDisk = require('../src/osDisk');
const queries = require('../src/queries');

test('um minuto de Dashboard aberto (atualização a cada 5 s): cada consulta no seu ritmo', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    for (let s = 0; s < 60; s += 5) {
        await dashboard.collectCached();
        t.mock.timers.tick(5000);
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.sessionSummary, 12, 'sessões: a cada 5 s');
    assert.equal(calls.sqlCommands, 12);
    assert.ok(calls.waitClasses <= 4, `waitClasses ${calls.waitClasses}`);
    assert.ok(calls.systemMetrics <= 2, `systemMetrics ${calls.systemMetrics}`);
    assert.ok(calls.memoryUsage <= 2 && calls.sessionMemoryUsage <= 2 && calls.waitEvents <= 2);
    assert.equal(calls.topSql, 1, 'Top SQL (V$SQLSTATS): uma vez por minuto');
    assert.ok(calls.tablespaceUsage <= 1, `dba_free_space no máximo 1x/min (${calls.tablespaceUsage})`);
    // Antes: as 8 consultas a cada atualização (96/min) + tablespaces 12x + leituras de disco/FRA 3x = ~120/min.
    const total = Object.entries(calls).filter(([k]) => k !== 'defaultDataPath').reduce((s, [, n]) => s + n, 0);
    assert.ok(total <= 45, `total de consultas por minuto: ${total} ${JSON.stringify(calls)}`);
});

test('sem ninguém olhando: o amostrador (a cada 30 s) só lê o que histórico e alertas usam', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3600000 });
    for (const k of Object.keys(calls)) delete calls[k];
    for (let s = 0; s < 60; s += 30) {
        await dashboard.sample();
        t.mock.timers.tick(30000);
    }
    await new Promise((r) => setImmediate(r));
    for (const heavy of ['topSql', 'waitEvents', 'sessionMemoryUsage', 'systemMetrics', 'waitClasses']) assert.equal(calls[heavy], undefined, heavy);
    assert.deepEqual([calls.sessionSummary, calls.sqlCommands], [2, 2]);
    const total = Object.values(calls).reduce((s, n) => s + n, 0);
    assert.ok(total <= 12, `consultas por minuto sem tela aberta: ${total} ${JSON.stringify(calls)}`);
});

test('cache: uma coleta lenta em andamento é reaproveitada, não duplicada', async () => {
    let runs = 0;
    let release;
    const slow = () => { runs++; return new Promise((r) => { release = r; }); };
    const a = cache.cached('lenta', 10, slow);
    await new Promise((r) => setTimeout(r, 30)); // passou do TTL, ainda em andamento
    const b = cache.cached('lenta', 10, slow);
    assert.equal(runs, 1);
    release('v');
    assert.equal(await a, 'v');
    assert.equal(await b, 'v');
});

test('consultas do painel: Top SQL em V$SQLSTATS sem as do painel; resumo de sessões sem varrer V$SQL', () => {
    assert.match(queries.topSql, /FROM v\$sqlstats/);
    assert.match(queries.topSql, /LIKE '\/\* OraclePulse \*\/%'/);
    assert.match(queries.topSql, /pulse_cpu_seconds/);
    assert.doesNotMatch(queries.sqlCommands, /JOIN v\$sql/i);
    assert.match(queries.sqlCommands, /SELECT UPPER\(q\.sql_text\) FROM v\$sql q WHERE q\.sql_id = s\.sql_id AND ROWNUM = 1/);
    const realDb = jest_free_require('../src/db');
    assert.equal(realDb.tag('  SELECT 1 FROM dual'), '/* OraclePulse */ SELECT 1 FROM dual');
    assert.equal(realDb.tag(realDb.tag('SELECT 1 FROM dual')), '/* OraclePulse */ SELECT 1 FROM dual', 'não marca duas vezes');
});

/** Carrega o módulo real, ignorando o falso registrado no require.cache. */
function jest_free_require(rel) {
    const p = require.resolve(rel);
    const saved = require.cache[p];
    delete require.cache[p];
    try { return require(rel); } finally { require.cache[p] = saved; }
}

test('SSH: leituras curtas reaproveitam uma conexão; scripts usam conexão própria; queda reconecta', async () => {
    osDisk.closeSsh(); // a coleta do teste anterior já abriu a conexão compartilhada
    FakeSSH.connects = 0; FakeSSH.disposed = 0; FakeSSH.execs = [];
    for (let i = 0; i < 5; i++) {
        const r = await osDisk.execOnServer(`df -kP /u0${i}`);
        assert.equal(r.code, 0);
    }
    await Promise.all([osDisk.execOnServer('cat /proc/meminfo'), osDisk.execOnServer('uptime')]);
    assert.equal(FakeSSH.connects, 1, '7 leituras, 1 login SSH (antes: 7)');

    // Script com a senha pela entrada padrão (sqlplus/RMAN): conexão própria, fechada no fim.
    await osDisk.execOnServer('sqlplus -S /nolog', { stdin: 'CONNECT ...\nEXIT\n' });
    assert.equal(FakeSSH.connects, 2);
    assert.equal(FakeSSH.disposed, 1);

    // Conexão compartilhada caiu antes do comando: reconecta e o comando roda uma vez.
    FakeSSH.failNext = true;
    const before = FakeSSH.execs.length;
    const r = await osDisk.execOnServer('df -kP /u01');
    assert.equal(r.code, 0);
    assert.equal(FakeSSH.execs.length - before, 2, 'tentativa falha + execução');
    const after = FakeSSH.connects;
    await osDisk.execOnServer('df -kP /u02');
    await osDisk.execOnServer('df -kP /u03');
    assert.ok(FakeSSH.connects - after <= 1, 'volta a reaproveitar a conexão');

    osDisk.closeSsh();
});

test('SSH fora do ar (ex.: Windows sem OpenSSH): falha na hora por 60 s, com motivo claro, sem repetir logins', async (t) => {
    osDisk.closeSsh();
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 7200000 });
    FakeSSH.connects = 0;
    FakeSSH.refuse = true;
    try {
        const first = await osDisk.execOnServer('df -kP /u01');
        assert.equal(first.code, -1);
        assert.match(first.stderr, /recusou a conexão \(nenhum servidor SSH escutando\)/);
        assert.match(first.stderr, /OpenSSH Server/);
        assert.doesNotMatch(first.stderr, /senha|chave/i, 'falha de rede não é problema de senha');
        for (let i = 0; i < 5; i++) assert.equal((await osDisk.execOnServer('cat /proc/meminfo')).code, -1);
        assert.equal(FakeSSH.connects, 1, 'uma tentativa só, nas leituras seguintes falha na hora');
        t.mock.timers.tick(61000);
        FakeSSH.refuse = false;
        assert.equal((await osDisk.execOnServer('uptime')).code, 0, 'depois de 60 s tenta de novo');
        assert.equal(FakeSSH.connects, 2);
    } finally {
        FakeSSH.refuse = false;
        osDisk.closeSsh();
    }
});

test('SO do servidor: detectado uma vez e guardado', async () => {
    calls.defaultDataPath = 0;
    for (let i = 0; i < 5; i++) assert.equal(await osDisk.detectServerOs(), 'linux');
    assert.ok(calls.defaultDataPath <= 1, `consultas ao dicionário: ${calls.defaultDataPath}`);
});

/**
 * Smoke test da aplicação EMPACOTADA (installer\build\app), rodando com o
 * Node.js portátil que vai no instalador. O build.ps1 define OP_APP_DIR.
 *
 *  - modo DEMO: página, login (DBA e somente leitura), APIs principais;
 *  - modo LIVE com banco inacessível: o painel sobe e responde com erro
 *    tratado (não derruba o processo);
 *  - o binário nativo do oracledb (modo THICK) carrega neste Node.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const APP = process.env.OP_APP_DIR ? path.resolve(process.env.OP_APP_DIR) : null;
const SKIP = !APP && 'defina OP_APP_DIR (o installer\\build.ps1 faz isso)';

function hex(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    return out;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

// Cópias temporárias da app, removidas ao final (os servidores já foram parados).
const TMP_DIRS = [];
test.after(() => {
    for (const dir of TMP_DIRS) {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* melhor esforço */ }
    }
});

/** Cópia da app empacotada numa pasta temporária (como se fosse {app}). */
function installCopy() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-smoke-'));
    TMP_DIRS.push(dir);
    const skip = new Set(['runtime', 'service', '.env', 'logs'].map((d) => path.join(APP, d)));
    fs.cpSync(APP, dir, { recursive: true, filter: (src) => !skip.has(src) });
    return dir;
}

function writeEnv(dir, values) {
    const input = path.join(dir, 'input.txt');
    fs.writeFileSync(input, Object.entries(values).map(([k, v]) => `${k}=${hex(v)}`).join('\r\n'));
    const result = path.join(dir, 'result.txt');
    const r = spawnSync(process.execPath, [path.join(dir, 'tools', 'configure-env.js'), 'write',
        '--env', path.join(dir, '.env'), '--input', input, '--result', result, '--app', dir],
    { encoding: 'utf8', windowsHide: true });
    fs.unlinkSync(input);
    assert.equal(r.status, 0, `configure-env falhou: ${r.stderr}\n${fs.existsSync(result) ? fs.readFileSync(result, 'utf8') : ''}`);
}

function startServer(dir) {
    const child = spawn(process.execPath, ['server.js'], { cwd: dir, windowsHide: true, env: { ...process.env } });
    child.output = '';
    child.stdout.on('data', (d) => { child.output += d; });
    child.stderr.on('data', (d) => { child.output += d; });
    return child;
}

async function waitHttp(url, child, ms = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (child.exitCode !== null) throw new Error(`servidor encerrou (código ${child.exitCode}):\n${child.output}`);
        try {
            const r = await fetch(url);
            if (r.status === 200) return r;
        } catch { /* ainda subindo */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`servidor não respondeu em ${url}:\n${child.output}`);
}

async function api(base, method, route, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await r.json(); } catch { /* sem corpo JSON */ }
    return { status: r.status, json };
}

function stop(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
    });
}

test('modo DEMO: painel, login e APIs principais', { skip: SKIP, timeout: 120000 }, async () => {
    const dir = installCopy();
    const port = await freePort();
    writeEnv(dir, {
        PORT: String(port), DEMO_MODE: 'true', AUTH_USER: 'DBA', AUTH_PASS: 'Painel#2026',
        AUTH_VIEWER_USER: 'leitor', AUTH_VIEWER_PASS: 'Leitura#1',
    });
    const child = startServer(dir);
    try {
        const base = `http://127.0.0.1:${port}`;
        const home = await waitHttp(base + '/', child);
        const homeHtml = await home.text();
        assert.match(homeHtml, /<title>Oracle Pulse/);
        assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);

        // Ícones do painel (favicon .ico multi-tamanho + PNG 192 px).
        assert.match(homeHtml, /href="favicon\.ico\?v=\d+"/);
        const ico = await fetch(base + '/favicon.ico');
        assert.equal(ico.status, 200);
        const icoBytes = Buffer.from(await ico.arrayBuffer());
        assert.deepEqual([...icoBytes.subarray(0, 4)], [0, 0, 1, 0], 'favicon.ico com cabeçalho ICO');
        assert.equal(icoBytes.readUInt16LE(4), 4, 'favicon.ico com 4 tamanhos');
        const png = await fetch(base + '/favicon.png');
        assert.equal(png.status, 200);
        assert.equal(png.headers.get('content-type'), 'image/png');

        assert.equal((await api(base, 'GET', '/api/dashboard')).status, 401, 'API sem token deve ser 401');
        assert.equal((await api(base, 'POST', '/api/login', { body: { user: 'DBA', password: 'errada' } })).status, 401);

        const login = await api(base, 'POST', '/api/login', { body: { user: 'DBA', password: 'Painel#2026' } });
        assert.equal(login.status, 200);
        assert.equal(login.json.role, 'dba');
        const token = login.json.token;

        const health = await api(base, 'GET', '/api/health', { token });
        assert.equal(health.status, 200);
        assert.equal(health.json.mode, 'DEMO');

        for (const route of ['/api/dashboard', '/api/storage', '/api/storage/os-disk', '/api/sessions',
            '/api/backup/status', '/api/backup/config', '/api/audit', '/api/history']) {
            const r = await api(base, 'GET', route, { token });
            assert.equal(r.status, 200, `${route} -> ${r.status} ${JSON.stringify(r.json)}`);
            assert.equal(r.json.success, true, route);
        }

        // Storage em vários volumes (cenário DEMO: DADOS em /u01, /u02 e /u03).
        const vols = await api(base, 'GET', '/api/storage/os-disk', { token });
        assert.deepEqual(vols.json.data.volumes.map((v) => v.mount), ['/u01', '/u02', '/u03']);
        assert.deepEqual(vols.json.data.volumes.find((v) => v.mount === '/u03').currentFor, ['DADOS']);
        const cfg = await api(base, 'GET', '/api/storage/config', { token });
        const dadosTs = cfg.json.data.layout.tablespaces.find((t) => t.name === 'DADOS');
        assert.equal(dadosTs.currentDir, '/u03/oracle/oradata/ORCL/');
        assert.equal(dadosTs.suggestedName, 'dados16.dbf');
        assert.equal(cfg.json.data.basePath, '/u03/oracle/oradata/ORCL/');
        assert.ok(cfg.json.data.files.every((f) => f.DIR), 'cada datafile com o diretório');
        const addDefault = await api(base, 'POST', '/api/storage/add-file', { token, body: { tablespace: 'DADOS', sizeMb: 5000 } });
        assert.equal(addDefault.status, 200);
        assert.equal(addDefault.json.fullPath, '/u03/oracle/oradata/ORCL/dados16.dbf');
        const addCustom = await api(base, 'POST', '/api/storage/add-file', { token, body: { tablespace: 'DADOS', directory: '/u04/oradata/ORCL', fileName: 'dados16.dbf', sizeMb: 100 } });
        assert.equal(addCustom.json.fullPath, '/u04/oradata/ORCL/dados16.dbf');
        for (const [body, re] of [
            [{ tablespace: 'DADOS', directory: '/u02/oracle/oradata/ORCL', fileName: 'x.dbf', sizeMb: 60000 }, /Espaço insuficiente no volume \/u02/],
            [{ tablespace: 'DADOS', fileName: 'dados15.dbf', sizeMb: 100 }, /Já existe/],
            [{ tablespace: 'DADOS', directory: 'E:\\ORADATA', fileName: 'x.dbf', sizeMb: 100 }, /Linux/],
            [{ tablespace: 'DADOS', directory: "/u04/x'; DROP", fileName: 'x.dbf', sizeMb: 100 }, /não permitidos/],
            [{ tablespace: 'DADOS', fileName: '../../etc/x.dbf', sizeMb: 100 }, /absoluto|\.\.|inválido|permitidos/],
        ]) {
            const r = await api(base, 'POST', '/api/storage/add-file', { token, body });
            assert.equal(r.status, 400, JSON.stringify(body));
            assert.match(r.json.error, re);
        }
        const resize = await api(base, 'POST', '/api/storage/resize', { token, body: { fileName: '/u02/oracle/oradata/ORCL/dados07.dbf', newSizeMb: 33000 } });
        assert.equal(resize.status, 200, JSON.stringify(resize.json));

        const sql = await api(base, 'POST', '/api/sql/execute', { token, body: { sql: 'select 1 from dual' } });
        assert.equal(sql.status, 200);
        assert.equal(sql.json.results[0].type, 'rows');

        // Página Recuperação e relógio x NTP (DEMO).
        assert.match(homeHtml, /data-section="recovery"/);
        assert.match(homeHtml, /<script src="recovery\.js(\?v=[\w.]+)?"><\/script>/);
        assert.match(homeHtml, /id="clock-sync-btn"/);
        for (const asset of ['/recovery.js', '/recovery.css']) assert.equal((await fetch(base + asset)).status, 200, asset);
        const diag = await api(base, 'GET', '/api/recovery/diagnosis?refresh=1', { token });
        assert.equal(diag.status, 200, JSON.stringify(diag.json));
        assert.equal(diag.json.data.signals.state, 'OPEN');
        assert.ok(diag.json.data.report.findings.length > 0);
        const catalog = (await api(base, 'GET', '/api/recovery/playbooks', { token })).json.data;
        assert.equal(catalog.length, 22);
        for (const id of ['redo-multiplex', 'controlfile-multiplex', 'flashback-on']) assert.ok(catalog.some((p) => p.id === id), id);
        // Prontidão em DEMO: controlfile com uma cópia e Flashback desligado trazem o botão de solução.
        const ready = diag.json.data.report.readiness.items;
        assert.equal(ready.find((i) => i.id === 'cfmux').action.id, 'controlfile-multiplex');
        assert.equal(ready.find((i) => i.id === 'flashback').action.id, 'flashback-on');
        const look = await api(base, 'POST', '/api/recovery/lookup', { token, body: { text: 'ORA-00600: internal error code, arguments: [kcratr_scan_lastbwr]' } });
        assert.deepEqual(look.json.data.items[0].entry.playbooks.map((p) => p.id), ['crash-recovery']);
        const plan = await api(base, 'POST', '/api/recovery/plan', { token, body: { playbook: 'recompile-invalid', params: {} } });
        assert.equal(plan.status, 200);
        const run = await api(base, 'POST', '/api/recovery/execute', { token, body: { playbook: 'recompile-invalid', params: plan.json.data.params, hash: plan.json.data.hash } });
        assert.equal(run.status, 200, JSON.stringify(run.json));
        let job;
        for (let i = 0; i < 40; i++) {
            job = (await api(base, 'GET', `/api/recovery/job/${run.json.data.jobId}`, { token })).json.data;
            if (job.state !== 'running') break;
            await new Promise((r) => setTimeout(r, 300));
        }
        assert.equal(job.state, 'done', JSON.stringify(job));
        const clock = await api(base, 'GET', '/api/time/status', { token });
        assert.equal(clock.status, 200);
        assert.match(clock.json.data.server.localTime, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);

        // Proteção automática da FRA (DEMO): agendamento + guardião.
        for (const asset of ['/protection.js', '/protection.css']) assert.equal((await fetch(base + asset)).status, 200, asset);
        const prot = await api(base, 'GET', '/api/backup/protection', { token });
        assert.equal(prot.status, 200, JSON.stringify(prot.json));
        assert.equal(prot.json.data.ready.ok, true);
        const sched = await api(base, 'POST', '/api/backup/protection/schedule', { token, body: { schedule: { strategy: 'incremental', level0Day: 0, time: '01:00', archivelogHours: 4, destination: 'dir', directory: '/u04/backup' } } });
        assert.equal(sched.status, 200, JSON.stringify(sched.json));
        assert.deepEqual(sched.json.data.scheduleState.jobs.map((j) => j.job), ['level0', 'level1', 'archivelog']);
        const archOnly = await api(base, 'POST', '/api/backup/protection/schedule/preview', { token, body: { schedule: { strategy: 'archivelog', archivelogHours: 2, archKeepDays: 10, destination: 'fra' } } });
        assert.equal(archOnly.status, 200, JSON.stringify(archOnly.json));
        assert.deepEqual(archOnly.json.data.jobs.map((j) => j.job), ['archivelog'], 'somente archivelogs');
        assert.ok(archOnly.json.data.jobs[0].rman.includes("DELETE NOPROMPT BACKUP OF ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE-10';"));
        const fraSug = await api(base, 'GET', '/api/backup/config/fra-recommendation', { token });
        assert.equal(fraSug.status, 200, JSON.stringify(fraSug.json));
        assert.equal(fraSug.json.data.basis.backupsToFra, false, 'backups em diretório não entram na FRA');
        assert.equal((await api(base, 'POST', '/api/backup/protection/guard', { token, body: { guard: { enabled: true, targetPct: 70, growPct: 85, emergencyPct: 95, growStepPct: 20, diskReservePct: 10, maxSizeGb: 0, emergencyDir: '/u05/emerg', lastResort: true } } })).status, 200);
        assert.equal((await api(base, 'POST', '/api/backup/protection/guard/demo-spike', { token })).status, 200);
        const chk = await api(base, 'POST', '/api/backup/protection/guard/check', { token });
        assert.equal(chk.json.data.history[0].kind, 'grow', 'FRA em 96%: o guardião aumenta o limite');
        assert.ok(chk.json.data.decision.pct < 85, `FRA voltou abaixo do limite: ${chk.json.data.decision.pct}%`);
        const alertsNow = await api(base, 'GET', '/api/alerts', { token });
        assert.ok(alertsNow.json.data.some((a) => a.id === 'fraguard-action:grow'), 'ação do guardião vira notificação');

        const viewer = await api(base, 'POST', '/api/login', { body: { user: 'leitor', password: 'Leitura#1' } });
        assert.equal(viewer.json.role, 'viewer');
        const kill = await api(base, 'POST', '/api/sessions/kill', { token: viewer.json.token, body: { sid: 1, serial: 1 } });
        assert.equal(kill.status, 403, 'perfil somente leitura não executa ação de DBA');
        const viewerRun = await api(base, 'POST', '/api/recovery/execute', { token: viewer.json.token, body: { playbook: 'startup', params: {}, hash: 'x' } });
        assert.equal(viewerRun.status, 403, 'perfil somente leitura não executa recuperação');
        const viewerSync = await api(base, 'POST', '/api/time/sync', { token: viewer.json.token, body: { server: 'a.st1.ntp.br' } });
        assert.equal(viewerSync.status, 403, 'perfil somente leitura não ajusta o relógio');
        const viewerProt = await api(base, 'POST', '/api/backup/protection/guard/check', { token: viewer.json.token });
        assert.equal(viewerProt.status, 403, 'perfil somente leitura não aciona o guardião');

        // Terminal do servidor (DEMO): asset, info e os três modos; viewer bloqueado.
        assert.equal((await fetch(base + '/terminal.js')).status, 200);
        const tinfo = await api(base, 'GET', '/api/server/terminal/info', { token });
        assert.equal(tinfo.status, 200, JSON.stringify(tinfo.json));
        assert.equal(tinfo.json.data.demo, true);
        const tsql = await api(base, 'POST', '/api/server/terminal/exec', { token, body: { mode: 'sqlplus', command: 'SELECT status FROM v$instance;' } });
        assert.equal(tsql.status, 200, JSON.stringify(tsql.json));
        assert.match(tsql.json.data.output, /OPEN/);
        assert.equal((await api(base, 'POST', '/api/server/terminal/exec', { token, body: { mode: 'rman', command: 'LIST BACKUP SUMMARY;' } })).json.data.ok, true);
        assert.match((await api(base, 'POST', '/api/server/terminal/exec', { token, body: { mode: 'os', command: 'df -h' } })).json.data.output, /DEMO/);
        assert.equal((await api(base, 'POST', '/api/server/terminal/exec', { token, body: { mode: 'hack', command: 'x' } })).status, 400);
        assert.equal((await api(base, 'POST', '/api/server/terminal/exec', { token: viewer.json.token, body: { mode: 'os', command: 'ls' } })).status, 403, 'leitor não usa o terminal');

        // Sobre + atualização (DEMO): asset, info, verificação e a atualização simulada.
        assert.equal((await fetch(base + '/about.js')).status, 200);
        const about = await api(base, 'GET', '/api/about', { token });
        assert.equal(about.status, 200, JSON.stringify(about.json));
        assert.equal(about.json.data.name, 'Oracle Pulse');
        assert.match(about.json.data.version, /^\d+\.\d+\.\d+/);
        assert.equal((await api(base, 'GET', '/api/about', { token: viewer.json.token })).status, 200, 'leitor vê a página Sobre');
        const upchk = await api(base, 'GET', '/api/about/check-update?refresh=1', { token });
        assert.equal(upchk.status, 200, JSON.stringify(upchk.json));
        assert.equal(upchk.json.data.demo, true);
        assert.equal(upchk.json.data.newer, true);
        assert.equal((await api(base, 'POST', '/api/about/update', { token: viewer.json.token, body: { installPassword: 'SENHA-DEMO' } })).status, 403, 'leitor não atualiza');
        assert.equal((await api(base, 'POST', '/api/about/update', { token, body: {} })).status, 400, 'atualizar exige a senha');
        const upd = await api(base, 'POST', '/api/about/update', { token, body: { installPassword: 'SENHA-DEMO' } });
        assert.equal(upd.status, 200, JSON.stringify(upd.json));
        assert.equal(upd.json.data.demo, true, 'DEMO: simulação, nada é executado');

        assert.ok(fs.existsSync(path.join(dir, 'logs', 'audit.log')), 'auditoria gravada em logs\\audit.log');

        // "Atualizar Agora" ignora o cache; limpar os logs exige DBA + senha do DBA.
        assert.equal((await api(base, 'GET', '/api/backup/status?refresh=1', { token })).status, 200);
        assert.equal((await api(base, 'POST', '/api/audit/clear', { token: viewer.json.token, body: { password: 'Leitura#1' } })).status, 403, 'leitor não limpa logs');
        const wrongPass = await api(base, 'POST', '/api/audit/clear', { token, body: { password: 'errada' } });
        assert.equal(wrongPass.status, 403);
        assert.match(wrongPass.json.error, /Senha do DBA incorreta/);
        fs.writeFileSync(path.join(dir, 'logs', 'OraclePulse.out.log'), 'log do serviço\n');
        const cleared = await api(base, 'POST', '/api/audit/clear', { token, body: { password: 'Painel#2026' } });
        assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
        assert.ok(!fs.existsSync(path.join(dir, 'logs', 'OraclePulse.out.log')), 'logs do serviço apagados');
        const trail = await api(base, 'GET', '/api/audit', { token });
        assert.equal(trail.json.data[0].action, 'logs-limpos', 'a nova trilha começa pelo registro da limpeza');
        assert.equal(trail.json.data.length, 1);
    } finally {
        await stop(child);
    }
});

test('modo LIVE com banco inacessível: sobe e responde erro tratado', { skip: SKIP, timeout: 120000 }, async () => {
    const dir = installCopy();
    const port = await freePort();
    const dbPort = await freePort(); // porta livre = nada escutando
    writeEnv(dir, {
        PORT: String(port), DEMO_MODE: 'false', AUTH_USER: 'DBA', AUTH_PASS: 'Painel#2026',
        DB_HOST: '127.0.0.1', DB_PORT: String(dbPort), DB_SERVICE: 'orcl', DB_USER: 'monitor', DB_PASSWORD: "S3nha#'x",
    });
    const child = startServer(dir);
    try {
        const base = `http://127.0.0.1:${port}`;
        await waitHttp(base + '/', child);
        const login = await api(base, 'POST', '/api/login', { body: { user: 'DBA', password: 'Painel#2026' } });
        assert.equal(login.status, 200);
        const health = await api(base, 'GET', '/api/health', { token: login.json.token });
        assert.equal(health.status, 500);
        assert.equal(health.json.success, false);
        assert.ok(health.json.error, 'erro de conexão descrito na resposta');

        // Recuperação com o banco inacessível (falha REAL do node-oracledb): o
        // diagnóstico responde, classifica a falha e indica o procedimento.
        const diag = await api(base, 'GET', '/api/recovery/diagnosis?refresh=1', { token: login.json.token });
        assert.equal(diag.status, 200, JSON.stringify(diag.json));
        const conn = diag.json.data.signals.connection;
        assert.equal(conn.ok, false);
        assert.equal(conn.error.code, 'ORA-12541', `nada escutando na porta → sem listener: ${conn.error.message}`);
        const top = diag.json.data.report.findings[0];
        assert.equal(top.id, 'connect-failed');
        assert.equal(diag.json.data.report.recommended.id, 'listener-start');
        const clock = await api(base, 'GET', '/api/time/status', { token: login.json.token });
        assert.equal(clock.status, 200, 'relógio responde mesmo sem banco');
        assert.equal(clock.json.data.server, null);
        assert.ok(clock.json.data.serverError);
        await new Promise((r) => setTimeout(r, 2000));
        assert.equal(child.exitCode, null, `o processo não pode cair:\n${child.output}`);
        assert.match(child.output, /Modo: LIVE/);
    } finally {
        await stop(child);
    }
});

test('oracledb: binário nativo (modo THICK) carrega neste Node.js', { skip: SKIP }, () => {
    const code = "const o = require('oracledb');" +
        "try { o.initOracleClient({ libDir: 'C:\\\\pasta-inexistente-oracle' }); console.log('CARREGOU'); }" +
        'catch (e) { console.log(e.message); }';
    const r = spawnSync(process.execPath, ['-e', code], { cwd: APP, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    // NJS-045 = binário incompatível com o Node; DPI-1047 = binário OK, só falta o Oracle Client (esperado).
    assert.doesNotMatch(r.stdout, /NJS-045|NJS-067|was compiled against a different/);
    assert.match(r.stdout, /DPI-1047/);
});

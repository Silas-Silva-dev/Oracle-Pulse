/**
 * Endurecimento de segurança (auditoria 2026-10): login, cabeçalhos, erros,
 * caminho de log do agendamento e atualizador.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { config } = require('../src/config');
const auth = require('../src/auth');
const security = require('../src/security');
const schedule = require('../src/backupSchedule');
const updater = require('../src/updater');

function scrypt(pw) {
    const salt = crypto.randomBytes(16);
    return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}

function fakeRes() {
    const headers = {};
    return {
        headers, statusCode: 200, body: null, headersSent: false,
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        removeHeader(k) { delete headers[k.toLowerCase()]; },
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    };
}

// ---------------------------------------------------------------- login
test('login: só aceita texto; objetos/arrays não derrubam o hash', () => {
    const saved = { ...config.auth };
    try {
        Object.assign(config.auth, { user: 'dba1', passHash: scrypt('Senha-Forte-1'), viewerUser: null, viewerPassHash: null });
        assert.equal(auth.resolveRole('dba1', 'Senha-Forte-1'), 'dba');
        assert.equal(auth.resolveRole('dba1', { $ne: 1 }), null);
        assert.equal(auth.resolveRole(['dba1'], 'Senha-Forte-1'), null);
        assert.equal(auth.verifyPassword({}, config.auth.passHash), false);
    } finally {
        Object.assign(config.auth, saved);
    }
});

test('login: o hash é calculado mesmo com usuário inexistente (sem oráculo de tempo)', () => {
    const saved = { ...config.auth };
    const orig = crypto.scryptSync;
    let calls = 0;
    crypto.scryptSync = (...a) => { calls++; return orig(...a); };
    try {
        Object.assign(config.auth, { user: 'dba1', passHash: scrypt('Senha-Forte-1'), viewerUser: 'leitor', viewerPassHash: scrypt('Senha-Leitor-1') });
        calls = 0;
        auth.resolveRole('nao-existe', 'x');
        const unknownUser = calls;
        calls = 0;
        auth.resolveRole('dba1', 'senha-errada');
        assert.equal(unknownUser, calls, 'o mesmo número de scrypt para usuário inexistente e existente');
        assert.equal(unknownUser, 2, 'um scrypt por conta configurada');
    } finally {
        crypto.scryptSync = orig;
        Object.assign(config.auth, saved);
    }
});

// ---------------------------------------------------------------- cabeçalhos / erros
test('cabeçalhos: API sem cache, CSP libera só o arquivo exato do Chart.js', () => {
    const res = fakeRes();
    security.securityHeaders({ path: '/api/sessions', secure: false }, res, () => {});
    assert.equal(res.headers['cache-control'], 'no-store');
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@4\.5\.1\/dist\/chart\.umd\.min\.js(;|$)/);
    assert.doesNotMatch(csp, /script-src[^;]*cdnjs/, 'cdnjs não serve script nenhum: fora do script-src');
    assert.ok(res.headers['permissions-policy']);
    assert.equal(res.headers['strict-transport-security'], undefined, 'HSTS só sob HTTPS');

    const page = fakeRes();
    security.securityHeaders({ path: '/', secure: true }, page, () => {});
    assert.equal(page.headers['cache-control'], undefined);
    assert.match(page.headers['strict-transport-security'], /max-age=/);
});

test('index.html: Chart.js com versão fixa + SRI, igual à CSP', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const tag = /<script src="(https:\/\/cdn\.jsdelivr\.net[^"]+)"\s+integrity="(sha384-[^"]+)"\s+crossorigin="anonymous"><\/script>/.exec(html);
    assert.ok(tag, 'script do CDN precisa de integrity + crossorigin');
    assert.equal(tag[1], security.CHART_JS_URL);
    assert.doesNotMatch(html, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js">/, 'sem versão "latest" solta');
});

test('erros não tratados viram JSON genérico, sem stack trace', () => {
    const parse = fakeRes();
    security.jsonErrorHandler(Object.assign(new SyntaxError('Unexpected token } in JSON at position 9'), { status: 400 }), { method: 'POST', path: '/api/login' }, parse, () => {});
    assert.equal(parse.statusCode, 400);
    assert.deepEqual(parse.body, { success: false, error: 'Requisição inválida.' });

    const big = fakeRes();
    security.jsonErrorHandler(Object.assign(new Error('request entity too large'), { status: 413 }), { method: 'POST', path: '/api/login' }, big, () => {});
    assert.equal(big.statusCode, 413);

    const bug = fakeRes();
    security.jsonErrorHandler(new TypeError('x is not a function'), { method: 'GET', path: '/api/x' }, bug, () => {});
    assert.equal(bug.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(bug.body), /TypeError|is not a function|\\src\\|\/src\//);
});

// ---------------------------------------------------------------- log do agendamento (Linux/Windows)
test('log do agendamento: aceita só <base>/logs/<tarefa>_<data>.log (sem path traversal)', () => {
    const base = '/opt/oraclepulse';
    assert.equal(schedule.isSafeLinuxLogPath('/opt/oraclepulse/logs/full_20261015_010000.log', base), true);
    assert.equal(schedule.isSafeLinuxLogPath('/opt/oraclepulse/logs/archivelog_20261015_013000.log', base), true);
    for (const evil of [
        '/opt/oraclepulse/logs/../../../etc/shadow',
        '/opt/oraclepulse/logs/../../../root/.ssh/id_rsa',
        '/opt/oraclepulse/logs/full_20261015_010000.log/../../x',
        "/opt/oraclepulse/logs/full_20261015_010000.log'; id; '",
        '/etc/shadow',
    ]) {
        assert.equal(schedule.isSafeLinuxLogPath(evil, base), false, evil);
    }
    assert.equal(schedule.isSafeLinuxLogPath('/opt/oraclepulse/logs/full_20261015_010000.log', '/opt/../etc'), false);

    const dir = path.join(__dirname, 'tmp-logs', 'backup');
    assert.equal(schedule.isSafeWindowsLogPath(path.join(dir, 'full_20261015_010000.log'), dir), true);
    assert.equal(schedule.isSafeWindowsLogPath(path.join(dir, '..', '..', 'segredo.log'), dir), false);
    assert.equal(schedule.isSafeWindowsLogPath(`${dir}-irmao${path.sep}x.log`, dir), false, 'pasta irmã com o mesmo prefixo');
    assert.equal(schedule.isSafeWindowsLogPath(path.join(dir, 'full.status.json'), dir), false);
});

// ---------------------------------------------------------------- atualizador
test('atualizador: senha do dia não pode injetar comandos no .cmd (roda como SYSTEM)', async () => {
    assert.equal(updater.validInstallPassword('SENHA-DO-DIA-123'), true);
    assert.equal(updater.validInstallPassword('Ab1-x_y.z'), true);
    for (const evil of ['x" & calc & "', 'x%PATH%', 'a|b', 'a>b', 'a^b', 'a!b', 'linha\r\nnova', 'ç', '']) {
        assert.equal(updater.validInstallPassword(evil), false, JSON.stringify(evil));
    }
    await assert.rejects(updater.startUpdate({ installPassword: 'x" & calc & "' }), /caracteres inválidos/);
    assert.throws(() => updater.launchUpdater('C:\\x.exe', 'C:\\app', 'a" & calc & "'), /caracteres inválidos/);
});

test('atualizador: pasta temporária privada e única por atualização', () => {
    const a = updater.makeUpdateDir();
    const b = updater.makeUpdateDir();
    try {
        assert.notEqual(a, b);
        assert.ok(fs.statSync(a).isDirectory());
        assert.match(path.basename(a), /^OraclePulse-Update-.{6}$/);
    } finally {
        fs.rmSync(a, { recursive: true, force: true });
        fs.rmSync(b, { recursive: true, force: true });
    }
});

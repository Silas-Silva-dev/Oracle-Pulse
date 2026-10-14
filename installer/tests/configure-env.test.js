/**
 * Testes do installer/support/configure-env.js (gerador do .env do instalador).
 * Rodar:  node --test installer/tests
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Com OP_APP_DIR (definido pelo build.ps1) os testes rodam contra a árvore que
// vai dentro do instalador; sem ele, contra o repositório.
const REPO = path.resolve(__dirname, '..', '..');
const APP = process.env.OP_APP_DIR ? path.resolve(process.env.OP_APP_DIR) : REPO;
const TOOL = process.env.OP_APP_DIR
    ? path.join(APP, 'tools', 'configure-env.js')
    : path.join(REPO, 'installer', 'support', 'configure-env.js');
const dotenv = require(require.resolve('dotenv', { paths: [APP] }));
const ce = require(TOOL);

// Pastas temporárias dos testes, removidas ao final. Em makeApp, src/ é um
// junction para o código REAL: remove-se primeiro só o link (rmdir não segue
// junctions e falha em pasta real não vazia) e, se ele ainda existir por
// qualquer motivo, a pasta é deixada para trás em vez de arriscar o alvo.
const TMP_DIRS = [];
function tmpDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    TMP_DIRS.push(dir);
    return dir;
}
test.after(() => {
    for (const dir of TMP_DIRS) {
        const link = path.join(dir, 'src');
        try { fs.rmdirSync(link); } catch { /* sem junction */ }
        if (fs.existsSync(link)) continue;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* melhor esforço */ }
    }
});

/** Mesmo encoding que o Pascal do instalador usa (unidades UTF-16 em hex). */
function hex(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    return out;
}

function writeInput(dir, values) {
    const file = path.join(dir, 'input.txt');
    fs.writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${hex(v)}`).join('\r\n') + '\r\n');
    return file;
}

/** Pasta de app temporária: src/ aponta (junction) para o src real do repo. */
function makeApp() {
    const dir = tmpDir('op-cfg-');
    fs.symlinkSync(path.join(APP, 'src'), path.join(dir, 'src'), 'junction');
    return dir;
}

function run(args) {
    const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', windowsHide: true });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readResult(file) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.charCodeAt(0), 0xfeff, 'resultado deve ter BOM UTF-8');
    return text.slice(1).split(/\r\n/).filter(Boolean);
}

/** verifyPassword REAL da aplicação (carregada sem ler nenhum .env). */
function appVerifyPassword() {
    const prev = process.cwd();
    const empty = tmpDir('op-auth-');
    process.chdir(empty);
    try {
        return require(path.join(APP, 'src', 'auth.js')).verifyPassword;
    } finally {
        process.chdir(prev);
    }
}

const TRICKY = [
    'simples123', 'Senha#2024', 'com espaço', ' borda ', "aspa'simples", 'aspa"dupla', 'crase`x',
    'cifrão$HOME', 'barra\\no\\meio', 'termina\\', '\\', '#', '##', "'", '"', '`', "'começa", '"começa',
    'a=b=c', 'ponto;e,virgula', 'çãõé€😀', 'C:\\Program Files\\Oracle\\bin', 'D:\\oracle\\bin\\',
    "mix'\"", "mix'`", 'mix"`', '\\n literal', 'x #comentario', '  ', 'tab\there', 'sem#\\fim',
];

// Linhas bem formadas que um valor mal delimitado "engoliria" (todas têm aspas e #).
const BS = String.fromCharCode(92); // barra invertida, sem ambiguidade de escape
const ADVERSARIAL = {
    X1: ["'#a'", '#a'], X2: ['"#b"', '#b'], X3: ['`#c`', '#c'], X4: ['"it\'s #4"', "it's #4"],
    X5: ['\'say "hi" #5\'', 'say "hi" #5'], X6: ["a'b", "a'b"], X7: ['# só comentário', ''],
    X8: ["'x' # c'", 'x'], X9: [BS, BS], X10: [`"a${BS}b"`, `a${BS}b`],
};
const NL = String.fromCharCode(10);
const TAIL = Object.entries(ADVERSARIAL).map(([k, [repr]]) => `${k}=${repr}`).join(NL);

function assertContextFree(key, v, repr) {
    for (const before of ['', TAIL + NL]) {
        const parsed = dotenv.parse(`${before}${key}=${repr}${NL}${TAIL}${NL}Z=fim${NL}`);
        assert.equal(parsed[key], v, `valor ${JSON.stringify(v)} -> ${repr}`);
        assert.equal(parsed.Z, 'fim', `valor ${JSON.stringify(v)} -> ${repr} invadiu as linhas seguintes`);
        for (const [k, [, expected]] of Object.entries(ADVERSARIAL)) assert.equal(parsed[k], expected, `${k} após ${repr}`);
    }
}

test('linhas adversárias do teste são, elas mesmas, bem formadas', () => {
    const parsed = dotenv.parse(`${TAIL}${NL}Z=fim${NL}`);
    for (const [k, [, expected]] of Object.entries(ADVERSARIAL)) assert.equal(parsed[k], expected, k);
    assert.equal(parsed.Z, 'fim');
});

test('serializeValue: valores difíceis voltam idênticos em qualquer contexto (ou são recusados)', () => {
    let accepted = 0;
    for (const v of TRICKY) {
        let repr;
        try {
            repr = ce.serializeValue('K', v);
        } catch (err) {
            assert.match(err.message, /não consegue representar/, `valor ${JSON.stringify(v)}`);
            continue;
        }
        accepted++;
        assertContextFree('K', v, repr);
    }
    assert.ok(accepted >= TRICKY.length - 2, `aceitos ${accepted} de ${TRICKY.length}`);
});

test('serializeValue: só recusa o que o dotenv realmente não representa', () => {
    // Precisa de aspas (#, borda ou aspa inicial) E não pode tê-las (termina em "\" ou tem as 3 aspas).
    for (const v of ['sem#\\', 'a#b\\', "a'b\"c`d#", ' borda\\', "'#\\"]) {
        assert.throws(() => ce.serializeValue('K', v), /não consegue representar/, JSON.stringify(v));
    }
    assert.throws(() => ce.serializeValue('K', 'a\nb'), /quebra de linha/);
    for (const v of ['termina\\', 'D:\\oracle\\bin\\', "mix'\"", 'Senha#2024', ' borda ', "a'b\"c`d", "S3nha#'\"x", '\\', "'começa\\"]) {
        assert.doesNotThrow(() => ce.serializeValue('K', v), JSON.stringify(v));
    }
});

/** Força bruta: existe ALGUMA forma de escrita que volta igual em todos os contextos? */
function representableSomehow(v) {
    for (const c of [v, `'${v}'`, `"${v}"`, `\`${v}\``]) {
        try {
            assertContextFree('K', v, c);
            return true;
        } catch { /* tenta a próxima */ }
    }
    return false;
}

test('fuzz: 3000 valores aleatórios — aceitos fazem round-trip do arquivo inteiro; recusados são de fato irrepresentáveis', () => {
    const alphabet = "ab#'\"`\\ $=;:/@çé😀\t";
    let seed = 12345;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 3000; i++) {
        let v = '';
        const len = rnd(10);
        for (let j = 0; j < len; j++) v += alphabet[rnd(alphabet.length)];
        // Surrogates soltos do emoji não fazem sentido como senha digitada.
        if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v)) continue;
        let repr;
        try {
            repr = ce.serializeValue('K', v);
        } catch (err) {
            assert.match(err.message, /não consegue representar/);
            assert.equal(representableSomehow(v), false, `recusou ${JSON.stringify(v)}, mas havia forma válida`);
            rejected++;
            continue;
        }
        accepted++;
        assertContextFree('K', v, repr);
        const env = ce.buildEnv({}, { AUTH_USER: 'DBA', DB_PASSWORD: v, DEMO_MODE: 'true' });
        env.AUTH_PASS_HASH = 'scrypt$00$00';
        const back = dotenv.parse(ce.renderEnv(env));
        for (const [k, val] of Object.entries(env)) assert.equal(back[k], val, `${k}=${JSON.stringify(val)}`);
    }
    assert.ok(accepted > 1000 && rejected > 0, `aceitos ${accepted}, recusados ${rejected}`);
});

test('hashPassword gera hash aceito pelo src/auth.js da aplicação', () => {
    const verify = appVerifyPassword();
    for (const pwd of ['Senha#2024', 'çãõ 😀', "a'b\"c`d\\"]) {
        const h = ce.hashPassword(pwd);
        assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
        assert.equal(verify(pwd, h), true);
        assert.equal(verify(pwd + 'x', h), false);
    }
});

test('write (instalação nova): cria .env válido para a aplicação, com hash e senhas exatas', () => {
    const app = makeApp();
    const values = {
        PORT: '3123', DEMO_MODE: 'false',
        DB_HOST: '192.168.0.10', DB_PORT: '1521', DB_SERVICE: 'orcl', DB_USER: 'admin', DB_PASSWORD: `S3nha#'"x${String.fromCharCode(92)}fim`,
        AUTH_USER: 'DBA', AUTH_PASS: 'Painel#2026 ok',
        SSH_HOST: '192.168.0.10', SSH_USER: 'root', SSH_PASSWORD: 'Senha#2024', SSH_PORT: '22',
        ORACLE_CLIENT_PATH: 'C:\\Program Files\\Oracle\\instantclient_19_19',
    };
    const input = writeInput(app, values);
    const result = path.join(app, 'result.txt');
    const r = run(['write', '--env', path.join(app, '.env'), '--input', input, '--result', result, '--app', app]);
    assert.equal(r.code, 0, r.stderr);
    const lines = readResult(result);
    assert.equal(lines[0], 'OK');
    assert.ok(lines.includes('PORT=3123'));
    assert.ok(lines.includes('DEMO_MODE=false'));

    const raw = fs.readFileSync(path.join(app, '.env'), 'utf8');
    assert.notEqual(raw.charCodeAt(0), 0xfeff, '.env não pode ter BOM (dotenv leria a 1ª chave errada)');
    const env = dotenv.parse(raw);
    for (const k of ['PORT', 'DB_HOST', 'DB_PORT', 'DB_SERVICE', 'DB_USER', 'DB_PASSWORD', 'SSH_PASSWORD', 'ORACLE_CLIENT_PATH']) {
        assert.equal(env[k], values[k], k);
    }
    assert.equal(env.AUTH_PASS, undefined, 'senha em texto puro nunca vai para o .env');
    assert.equal(appVerifyPassword()('Painel#2026 ok', env.AUTH_PASS_HASH), true);
    // Todas as chaves do layout presentes (DB_PORT sempre definido: a app monta host:port/service).
    for (const k of ce.LAYOUT_KEYS) assert.ok(k in env, `chave ${k} ausente`);
    assert.ok(!fs.readdirSync(app).some((f) => f.startsWith('.env.bak')), 'sem backup na instalação nova');
});

test('write (reconfiguração): mantém o que não foi alterado, preserva extras e faz backup', () => {
    const app = makeApp();
    const envFile = path.join(app, '.env');
    const oldHash = ce.hashPassword('antiga');
    fs.writeFileSync(envFile, [
        'PORT=3000', 'DEMO_MODE=false', 'DB_USER=admin', 'DB_PASSWORD="Senha#2024"', 'DB_HOST=srv # comentário',
        'DB_PORT=1521', 'DB_SERVICE=orcl', 'AUTH_USER=DBA', `AUTH_PASS_HASH=${oldHash}`,
        'AUTH_VIEWER_USER=leitor', `AUTH_VIEWER_PASS_HASH=${ce.hashPassword('leitura')}`,
        'SESSION_SECRET=abc', 'ALERT_SWAP_PCT=30', 'ALERT_DISK_PCT=70',
    ].join('\n'));
    const input = writeInput(app, { DB_HOST: '10.0.0.5', AUTH_PASS: '', AUTH_VIEWER_USER: '' });
    const result = path.join(app, 'result.txt');
    const r = run(['write', '--env', envFile, '--input', input, '--result', result, '--app', app]);
    assert.equal(r.code, 0, r.stderr);
    const env = dotenv.parse(fs.readFileSync(envFile));
    assert.equal(env.DB_HOST, '10.0.0.5');
    assert.equal(env.DB_PASSWORD, 'Senha#2024');
    assert.equal(env.AUTH_PASS_HASH, oldHash, 'senha em branco mantém o hash atual');
    assert.equal(env.AUTH_VIEWER_USER, '');
    assert.equal(env.AUTH_VIEWER_PASS_HASH, '', 'sem usuário viewer, o hash dele é limpo');
    assert.equal(env.SESSION_SECRET, 'abc');
    assert.equal(env.ALERT_SWAP_PCT, '30');
    assert.equal(env.ALERT_DISK_PCT, '70');
    const backups = fs.readdirSync(app).filter((f) => f.startsWith('.env.bak-'));
    assert.equal(backups.length, 1);
    assert.match(fs.readFileSync(path.join(app, backups[0]), 'utf8'), /DB_HOST=srv # comentário/);
    assert.ok(readResult(result).some((l) => l.startsWith('BACKUP=')));
});

test('write: campos obrigatórios faltando -> ERRO e nenhum .env criado', () => {
    const app = makeApp();
    const input = writeInput(app, { PORT: '3000', DEMO_MODE: 'false', AUTH_USER: 'DBA', AUTH_PASS: 'x123456', DB_USER: 'admin' });
    const result = path.join(app, 'result.txt');
    const r = run(['write', '--env', path.join(app, '.env'), '--input', input, '--result', result, '--app', app]);
    assert.equal(r.code, 2);
    const lines = readResult(result);
    assert.equal(lines[0], 'ERRO');
    assert.ok(lines.some((l) => /DB_HOST/.test(l)));
    assert.ok(lines.some((l) => /DB_PASSWORD/.test(l)));
    assert.equal(fs.existsSync(path.join(app, '.env')), false);
});

test('write: modo DEMO dispensa os dados do banco; porta inválida é recusada', () => {
    const app = makeApp();
    const result = path.join(app, 'result.txt');
    let r = run(['write', '--env', path.join(app, '.env'), '--input',
        writeInput(app, { PORT: '70000', DEMO_MODE: 'true', AUTH_USER: 'DBA', AUTH_PASS: 'x123456' }), '--result', result]);
    assert.equal(r.code, 2);
    assert.ok(readResult(result).some((l) => /PORT/.test(l)));
    r = run(['write', '--env', path.join(app, '.env'), '--input',
        writeInput(app, { PORT: '3001', DEMO_MODE: 'true', AUTH_USER: 'DBA', AUTH_PASS: 'x123456' }), '--result', result, '--app', app]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readResult(result).slice(0, 3), ['OK', 'PORT=3001', 'DEMO_MODE=true']);
});

test('write: senha impossível de representar -> ERRO claro', () => {
    const app = makeApp();
    const result = path.join(app, 'result.txt');
    const r = run(['write', '--env', path.join(app, '.env'), '--input',
        writeInput(app, { PORT: '3000', DEMO_MODE: 'true', AUTH_USER: 'DBA', AUTH_PASS: 'x123456', SSH_PASSWORD: 'a#b\\' }), '--result', result]);
    assert.equal(r.code, 2);
    assert.match(readResult(result).join(' '), /SSH_PASSWORD.*não consegue representar/);
});

test('write --dry-run: valida sem gravar nada (nem .env nem backup)', () => {
    const app = makeApp();
    const envFile = path.join(app, '.env');
    const result = path.join(app, 'result.txt');
    let r = run(['write', '--dry-run', '--env', envFile, '--input',
        writeInput(app, { PORT: '3005', DEMO_MODE: 'true', AUTH_USER: 'DBA', AUTH_PASS: 'x123456' }), '--result', result]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readResult(result), ['OK', 'PORT=3005', 'DEMO_MODE=true']);
    assert.equal(fs.existsSync(envFile), false);

    fs.writeFileSync(envFile, 'PORT=3000\nDEMO_MODE=true\nAUTH_USER=DBA\nAUTH_PASS_HASH=scrypt$aa$bb\n');
    const before = fs.readFileSync(envFile, 'utf8');
    r = run(['write', '--dry-run', '--env', envFile, '--input', writeInput(app, { DEMO_MODE: 'false' }), '--result', result]);
    assert.equal(r.code, 2, 'sair do DEMO sem dados do banco deve falhar na validação');
    assert.match(readResult(result).join(' '), /DB_HOST/);
    assert.equal(fs.readFileSync(envFile, 'utf8'), before);
    assert.ok(!fs.readdirSync(app).some((f) => f.startsWith('.env.bak')));
});

test('info: lê porta e modo de um .env existente', () => {
    const dir = tmpDir('op-info-');
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3001 # painel\nDEMO_MODE=true\n');
    const result = path.join(dir, 'r.txt');
    const r = run(['info', '--env', path.join(dir, '.env'), '--result', result]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readResult(result), ['OK', 'PORT=3001', 'DEMO_MODE=true']);
    fs.writeFileSync(path.join(dir, '.env'), 'DEMO_MODE=false\n');
    run(['info', '--env', path.join(dir, '.env'), '--result', result]);
    assert.deepEqual(readResult(result), ['OK', 'PORT=3000', 'DEMO_MODE=false']);
});

test('check-db: DEMO é ignorado; banco inacessível falha rápido com orientação', () => {
    const dir = tmpDir('op-db-');
    const result = path.join(dir, 'r.txt');
    fs.writeFileSync(path.join(dir, '.env'), 'DEMO_MODE=true\n');
    let r = run(['check-db', '--env', path.join(dir, '.env'), '--result', result]);
    assert.equal(r.code, 0);
    assert.equal(readResult(result)[0], 'IGNORADO');

    fs.writeFileSync(path.join(dir, '.env'), 'DEMO_MODE=false\nDB_USER=admin\nDB_PASSWORD=x\nDB_HOST=127.0.0.1\nDB_PORT=1\nDB_SERVICE=orcl\n');
    const t0 = Date.now();
    r = run(['check-db', '--env', path.join(dir, '.env'), '--result', result, '--timeout', '25']);
    assert.equal(r.code, 3);
    const lines = readResult(result);
    assert.equal(lines[0], 'FALHA');
    assert.match(lines.join(' '), /127\.0\.0\.1:1\/orcl/);
    assert.match(lines.join(' '), /listener|escutando|Tempo esgotado/i);
    assert.ok(Date.now() - t0 < 30000);
});

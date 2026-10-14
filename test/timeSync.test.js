'use strict';
// Relógio do servidor x NTP: validação, pacote SNTP, scripts de sincronização.
process.env.DEMO_MODE = 'false';
process.env.NTP_SERVERS = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../src/timeSync');

test('validateNtpHost aceita nomes e IPv4, recusa injeção', () => {
    assert.equal(t.validateNtpHost('a.st1.ntp.br'), 'a.st1.ntp.br');
    assert.equal(t.validateNtpHost(' POOL.NTP.ORG '), 'pool.ntp.org');
    assert.equal(t.validateNtpHost('200.160.7.186'), '200.160.7.186');
    assert.equal(t.validateNtpHost('ntp-1.empresa.local'), 'ntp-1.empresa.local');
    for (const bad of ['', 'a b', "a.br'; rm -rf /", 'a.br;reboot', '$(id)', 'a..b', '-a.br', 'a.br\nx', '`x`']) {
        assert.throws(() => t.validateNtpHost(bad), t.TimeSyncError, JSON.stringify(bad));
    }
});

test('NTP_SERVERS: lista do .env, inválidos ignorados, padrão NTP.br', () => {
    assert.deepEqual(t.ntpServers(''), ['a.st1.ntp.br', 'b.st1.ntp.br', 'pool.ntp.org']);
    assert.deepEqual(t.ntpServers('ntp.local, 10.0.0.1;bad host ntp.local'), ['ntp.local', '10.0.0.1', 'bad', 'host']);
    assert.deepEqual(t.ntpServers("x'y"), ['a.st1.ntp.br', 'b.st1.ntp.br', 'pool.ntp.org']);
});

test('pacote SNTP: requisição v4 modo cliente e tempo NTP ida e volta', () => {
    const now = Date.UTC(2026, 9, 13, 20, 0, 0, 250);
    const req = t.buildSntpRequest(now);
    assert.equal(req.length, 48);
    assert.equal(req[0], 0x23, 'LI=0 VN=4 Mode=3');
    assert.ok(Math.abs(t.readNtpTime(req, 40) - now) < 1);
    const b = Buffer.alloc(8);
    const after2036 = Date.UTC(2040, 0, 1);
    t.writeNtpTime(b, 0, after2036);
    assert.ok(Math.abs(t.readNtpTime(b, 0) - after2036) < 1, 'era 1 do NTP (após 2036)');
});

function response({ t2, t3, stratum = 1, li = 0, mode = 4, ref = 'ONBR' }) {
    const b = Buffer.alloc(48);
    b[0] = (li << 6) | (4 << 3) | mode;
    b[1] = stratum;
    b.write(ref.padEnd(4, '\0'), 12, 'ascii');
    t.writeNtpTime(b, 32, t2);
    t.writeNtpTime(b, 40, t3);
    return b;
}

test('parseSntpResponse: deslocamento e atraso pela fórmula do RFC 4330', () => {
    // Relógio local 5 s atrás do NTP; 20 ms de rede em cada sentido; servidor leva 1 ms.
    const t1 = 1000000;
    const t2 = t1 + 5000 + 20;
    const t3 = t2 + 1;
    const t4 = t3 - 5000 + 20;
    const r = t.parseSntpResponse(response({ t2, t3 }), t1, t4);
    assert.ok(Math.abs(r.offsetMs - 5000) < 1, String(r.offsetMs));
    assert.ok(Math.abs(r.delayMs - 40) < 1, String(r.delayMs));
    assert.equal(r.stratum, 1);
    assert.equal(r.refId, 'ONBR');
    assert.throws(() => t.parseSntpResponse(response({ t2, t3, stratum: 0, ref: 'RATE' }), t1, t4), /Kiss-o'-Death RATE/);
    assert.throws(() => t.parseSntpResponse(response({ t2, t3, li: 3 }), t1, t4), /não está sincronizado/);
    assert.throws(() => t.parseSntpResponse(response({ t2, t3, mode: 3 }), t1, t4), /modo 3/);
    assert.throws(() => t.parseSntpResponse(Buffer.alloc(20), t1, t4), /curta/);
});

test('script Linux: usa o serviço existente e não aceita injeção', () => {
    const s = t.buildLinuxSyncScript('a.st1.ntp.br');
    assert.match(s, /^#!\/bin\/sh/);
    assert.match(s, /NTP='a\.st1\.ntp\.br'/);
    for (const part of ['chronyc -a makestep', 'ntpdate -u -b', 'sntp -S', 'ntpd -gq', 'timedatectl set-ntp true', 'chronyd -q', 'hwclock --systohc', 'say ERR NOROOT', 'sudo -n']) {
        assert.ok(s.includes(part), part);
    }
    assert.ok(!s.includes('${'), 'sem interpolação de shell com chaves');
    assert.throws(() => t.buildLinuxSyncScript("x'; reboot; '"), t.TimeSyncError);
    const step = t.buildLinuxStepScript(-563218.4);
    assert.match(step, /-v o="-563\.218"/);
    assert.match(step, /date -u -s "@\$NEW"/);
    assert.throws(() => t.buildLinuxStepScript(NaN));
    assert.throws(() => t.buildLinuxStepScript(1e13));
});

test('script Windows: ASCII, cabe no limite do cmd.exe e usa w32tm corretamente', () => {
    const s = t.buildWindowsSyncScript('a.st1.ntp.br');
    assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s), 'somente ASCII (o stdin do PowerShell usa a página OEM)');
    const encoded = require('../src/osDisk').psEncoded(s);
    assert.ok(encoded.length < 8000, `comando codificado com ${encoded.length} caracteres (limite do cmd.exe: 8191)`);
    assert.match(s, /w32tm \/config "\/manualpeerlist:\$ntp,0x8" \/syncfromflags:manual/);
    assert.match(s, /w32tm \/resync \/rediscover/);
    assert.doesNotMatch(s, /\/resync \/force/, '/force não existe no w32tm /resync');
    assert.match(s, /DomainRole -lt 4/, 'membro de domínio segue o DC');
    assert.match(s, /Say 'ERR' 'NOADMIN'/);
    assert.match(t.buildWindowsStepScript(-563218.4), /FromMilliseconds\(-563218\)/);
});

test('parseScriptOutput lê os marcadores e guarda o log', () => {
    const p = t.parseScriptOutput([
        '@@OP:STEP:chrony-add', '    200 OK', '@@OP:PERSIST:/etc/chrony.conf', '@@OP:STEP:hwclock',
        '@@OP:METHOD:chrony', '@@OP:RESULT:ok', '',
    ].join('\r\n'));
    assert.equal(p.method, 'chrony');
    assert.equal(p.result, 'ok');
    assert.deepEqual(p.persist, ['/etc/chrony.conf']);
    assert.equal(p.steps.length, 2);
    assert.deepEqual(p.log, ['    200 OK']);
    assert.equal(t.parseScriptOutput('@@OP:ERR:NOADMIN').error, 'NOADMIN');
});

test('formatOffset: legível e com sinal (positivo = servidor adiantado)', () => {
    assert.equal(t.formatOffset(12287), '+12,3 s');
    assert.equal(t.formatOffset(-563218), '−9 min 23 s');
    assert.equal(t.formatOffset(840), '+840 ms');
    assert.equal(t.formatOffset(26 * 3600000 + 5000), '+1 d 2 h');
    assert.equal(t.formatOffset(null), '--');
});

// Executa o script Linux num sh de verdade, com chronyc/systemctl etc. substituídos por stubs.
const SH = ['sh', 'C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe'].find((c) => {
    try { return spawnSync(c, ['-c', 'exit 0'], { windowsHide: true }).status === 0; } catch { return false; }
});

test('script Linux roda num sh real (chrony ativo, root)', { skip: !SH && 'sh não encontrado' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-sh-'));
    try {
        const stubs = {
            id: 'if [ "$1" = "-u" ]; then echo 0; else echo uid=0; fi',
            systemctl: 'if [ "$1" = is-active ] && [ "$3" = chronyd ]; then exit 0; fi; [ "$1" = is-active ] && exit 3; exit 0',
            chronyc: 'echo "200 OK ($*)"',
            pgrep: 'exit 1', hwclock: 'exit 0', sleep: 'exit 0', tee: 'cat >/dev/null',
        };
        for (const [n, body] of Object.entries(stubs)) fs.writeFileSync(path.join(dir, n), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        fs.writeFileSync(path.join(dir, 'sync.sh'), t.buildLinuxSyncScript('a.st1.ntp.br'));
        // Stubs primeiro; depois a pasta do próprio sh (no Git for Windows é a que tem sed/grep).
        const shDir = path.isAbsolute(SH) ? path.dirname(SH) : null;
        const env = { ...process.env, PATH: [dir, shDir, process.env.PATH].filter(Boolean).join(path.delimiter) };
        const r = spawnSync(SH, [path.join(dir, 'sync.sh')], { encoding: 'utf8', windowsHide: true, env });
        const p = t.parseScriptOutput(r.stdout);
        assert.equal(p.method, 'chrony', r.stdout + r.stderr);
        assert.equal(p.result, 'ok');
        assert.ok(r.stdout.includes('200 OK (-a makestep)'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

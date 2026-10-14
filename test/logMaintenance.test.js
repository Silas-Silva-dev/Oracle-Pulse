'use strict';
// "Limpar todos os logs": apaga só logs, numa pasta temporária (nunca a do projeto).
process.env.DEMO_MODE = 'false';
process.env.SSH_HOST = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { config } = require('../src/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op-logs-'));
config.paths.logs = tmp; // antes de carregar audit/fraGuard (eles fixam o caminho ao carregar)
const audit = require('../src/audit');
const logMaintenance = require('../src/logMaintenance');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('limpeza apaga auditoria, logs de backup, histórico do guardião e logs do serviço; mantém o resto', async () => {
    const put = (rel, text = 'x\n') => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text); };
    put('audit.log.1', '{"ts":"2026-01-01T00:00:00Z","action":"old"}\n');
    audit.record({ action: 'login', user: 'DBA', role: 'dba', ip: '127.0.0.1' });
    audit.record({ action: 'kill-session', user: 'DBA', role: 'dba', ip: '127.0.0.1' });
    await new Promise((r) => setTimeout(r, 100)); // appendFile assíncrono
    put('OraclePulse.out.log', 'a'.repeat(5000));
    put('OraclePulse.err.log');
    put('OraclePulse.out.log.1');
    put('fra-guard-history.json', '[]');
    put('backup/level0_20261014_090016.log', 'RMAN...');
    const keep = ['backup/level0.status.json', 'backup-protection.json', 'recovery-snapshot.json'];
    keep.forEach((f) => put(f, '{}'));

    assert.equal(audit.getRecent().length, 2);
    const r = await logMaintenance.clearAll();
    assert.equal(r.skipped.length, 0);
    assert.equal(r.remote, null, 'sem agendamento Linux: nada a limpar no servidor');
    assert.equal(r.files, 7);
    assert.ok(r.bytes >= 5000);
    assert.equal(audit.getRecent().length, 0, 'memória da trilha zerada');
    for (const f of ['audit.log', 'audit.log.1', 'OraclePulse.out.log', 'OraclePulse.err.log', 'OraclePulse.out.log.1', 'fra-guard-history.json', 'backup/level0_20261014_090016.log']) {
        assert.ok(!fs.existsSync(path.join(tmp, f)), `${f} apagado`);
    }
    for (const f of keep) assert.ok(fs.existsSync(path.join(tmp, f)), `${f} mantido`);

    // A trilha continua funcionando depois da limpeza
    audit.record({ action: 'logs-limpos', user: 'DBA', role: 'dba', ip: '127.0.0.1' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(audit.getRecent()[0].action, 'logs-limpos');
    assert.match(fs.readFileSync(path.join(tmp, 'audit.log'), 'utf8'), /logs-limpos/);
    assert.ok(logMaintenance.isLogFile('x.log.3') && !logMaintenance.isLogFile('x.json'));
});

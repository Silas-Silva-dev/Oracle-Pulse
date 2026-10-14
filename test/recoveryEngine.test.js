'use strict';
// Laudo (findings), procedimentos (planos), coletor (parser do sqlplus) e executor.
process.env.DEMO_MODE = 'false';
process.env.DB_ORACLE_HOME = '/u01/app/oracle/product/19.0.0/dbhome_1';
process.env.DB_ORACLE_SID = 'orcl';
process.env.DB_SYS_PASSWORD = 'Sys#Senha1';
process.env.DB_TNS_ALIAS = '';
process.env.SSH_HOST = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const demo = require('../src/recovery/demo');
const findings = require('../src/recovery/findings');
const pbs = require('../src/recovery/playbooks');
const collect = require('../src/recovery/collect');
const executor = require('../src/recovery/executor');
const kb = require('../src/recovery/knowledge');

const env = {
    indexInfo: async (o, n) => (n === 'IDX_PEDIDOS_CLIENTE' ? { indexType: 'NORMAL', tableOwner: o, tableName: 'PEDIDOS', partitions: [] } : null),
    diskFor: async () => ({ freeGB: 120 }),
    stamp: '20261013',
};

function scenario(name) {
    demo.setScenario(name);
    return demo.signals();
}

// --------------------------------------------------------------------- laudo
test('laudo: cada cenário recomenda o procedimento certo', () => {
    const want = { padrao: 'datafile-recover', queda: 'crash-recovery', parado: 'startup', fra: 'fra-free', redo: 'incomplete-recovery' };
    for (const [name, id] of Object.entries(want)) {
        const r = findings.evaluate(scenario(name));
        assert.equal(r.recommended && r.recommended.id, id, name);
        assert.equal(r.overall, name === 'padrao' ? 'warning' : 'critical', name);
    }
});

test('laudo: sem duplicidade nem mensagens complementares como problema próprio', () => {
    for (const name of Object.keys(demo.SCENARIOS)) {
        const r = findings.evaluate(scenario(name));
        for (const f of r.findings) {
            assert.ok(!kb.COMPANIONS.includes(f.code) || f.id.startsWith('state-') || f.id.startsWith('redo') || f.id.startsWith('recover'), `${name}: ${f.code} virou problema próprio`);
        }
        const ids = r.findings.map((f) => f.id);
        assert.equal(new Set(ids).size, ids.length, `${name}: ids repetidos`);
        const active = r.findings.filter((f) => f.status === 'active');
        const codes = active.filter((f) => f.id.startsWith('alert-')).map((f) => f.code);
        assert.equal(new Set(codes).size, codes.length, `${name}: o mesmo código do alert log apareceu duas vezes`);
    }
});

test('laudo: ORA-600 antigo (antes da última abertura) é histórico; queda atual traz a causa', () => {
    const padrao = findings.evaluate(scenario('padrao'));
    const old = padrao.findings.find((f) => f.code === 'ORA-00600');
    assert.equal(old.status, 'historical');
    assert.equal(old.playbooks.length, 0);
    const parado = findings.evaluate(scenario('parado'));
    const down = parado.findings.find((f) => f.id === 'state-down');
    assert.match(down.title, /ORA-00494/);
    assert.ok(!parado.findings.some((f) => f.status === 'active' && f.code === 'ORA-00494' && f.id !== 'state-down'));
    assert.equal(parado.readiness.score, null, 'sem controlfile montado não há nota parcial');
});

test('prontidão: agendamento e guardião da FRA entram na nota (só em ARCHIVELOG)', () => {
    const s = scenario('padrao');
    const ids = (r) => r.readiness.items.map((i) => i.id);
    assert.ok(!ids(findings.evaluate(s)).includes('fraguard'), 'sem informação de proteção não há item');
    s.protection = { scheduleInstalled: false, guardEnabled: true };
    const r = findings.evaluate(s);
    assert.equal(r.readiness.items.find((i) => i.id === 'scheduled').status, 'warn');
    assert.equal(r.readiness.items.find((i) => i.id === 'fraguard').status, 'ok');
    s.protection.scheduleInstalled = true;
    assert.ok(findings.evaluate(s).readiness.score >= r.readiness.score, 'instalar o agendamento não piora a nota');
});

test('laudo: erro dentro de job tem impacto restrito; corrupção só em índice sugere rebuild', () => {
    const r = findings.evaluate(scenario('padrao'));
    const job = r.findings.find((f) => f.code === 'ORA-03113');
    assert.equal(job.severity, 'low');
    assert.match(job.title, /em job agendado/);
    const corr = r.findings.find((f) => f.id === 'corruption');
    assert.equal(corr.playbooks[0].id, 'index-rebuild');
    assert.equal(corr.playbooks[0].params.index, 'VENDAS.IDX_PEDIDOS_CLIENTE');
    const fra = r.findings.find((f) => f.id === 'fra');
    assert.deepEqual(fra.playbooks.map((p) => p.params.mode), ['grow', 'cleanup']);
    assert.notEqual(fra.playbooks[0].label, fra.playbooks[1].label, 'botões com rótulos distintos');
});

test('laudo: banco inacessível sem SYSDBA vira problema de conexão com o procedimento certo', () => {
    const base = { state: 'UNKNOWN', connection: { ok: false, error: collect.classifyConnectError(new Error('NJS-503: connection to host 10.0.0.5 port 1521 could not be established. (CONNECTION_ID=x) connect ECONNREFUSED')) }, capabilities: { canSysdba: false } };
    const r = findings.evaluate(base);
    assert.equal(r.findings[0].id, 'connect-failed');
    assert.equal(r.findings[0].code, 'ORA-12541');
    assert.equal(r.recommended.id, 'listener-start');
    assert.match(r.findings[0].detail, /DB_SYS_PASSWORD/);
    const locked = findings.evaluate({ ...base, connection: { ok: false, error: collect.classifyConnectError(new Error('ORA-28000: the account is locked')) } });
    assert.equal(locked.recommended.id, 'unlock-account');
});

test('consulta cruzada: ORA-03113 aponta os problemas ativos do banco', () => {
    const s = scenario('padrao');
    const items = findings.lookupText('ORA-03113: end-of-file on communication channel', s, findings.evaluate(s));
    assert.equal(items[0].code, 'ORA-03113');
    assert.ok(items[0].related.some((r) => r.id === 'corruption'));
});

// --------------------------------------------------------------------- planos
test('planos: todos os procedimentos montam em todos os cenários, com hash estável', async () => {
    for (const name of Object.keys(demo.SCENARIOS)) {
        const s = scenario(name);
        for (const id of Object.keys(pbs.CATALOG)) {
            const params = id === 'index-rebuild' ? { index: 'VENDAS.IDX_PEDIDOS_CLIENTE' } : {};
            const p1 = await pbs.buildPlan(id, params, s, env);
            const p2 = await pbs.buildPlan(id, p1.params, s, env);
            assert.equal(p1.hash, p2.hash, `${name}/${id}: hash instável`);
            assert.ok(!('internal' in p1) || p1.internal.steps.length === p1.steps.length);
            if (!p1.executable) assert.ok(p1.blockers.length || p1.manualOnly, `${name}/${id}: não executável sem motivo`);
        }
    }
});

test('planos: recuperação após queda adapta-se ao estado e nunca derruba banco aberto', async () => {
    const s = scenario('queda');
    const p = await pbs.buildPlan('crash-recovery', {}, s, env);
    assert.ok(p.executable);
    assert.equal(p.confirm.level, 'ack');
    const st = p.internal.steps[0];
    assert.equal(st.channel, 'rman');
    assert.deepEqual(pbs.renderStep(st, 'DOWN'), ['RUN {', '  STARTUP MOUNT;', '  RECOVER DATABASE;', '  ALTER DATABASE OPEN;', '}']);
    assert.deepEqual(pbs.renderStep(st, 'STARTED'), ['RUN {', '  ALTER DATABASE MOUNT;', '  RECOVER DATABASE;', '  ALTER DATABASE OPEN;', '}']);
    assert.equal(pbs.renderStep(st, 'OPEN'), null, 'sem variante para banco aberto');
    const open = await pbs.buildPlan('crash-recovery', {}, scenario('padrao'), env);
    assert.equal(open.executable, false);
    const cf = await pbs.buildPlan('controlfile-restore', { mode: 'autobackup' }, scenario('queda'), env);
    assert.ok(cf.internal.steps.every((x) => !x.variants || x.variants.OPEN === undefined), 'controlfile nunca derruba banco aberto');
});

test('planos: recuperação incompleta protege o controlfile, aplica AUTO/CANCEL e exige o nome do banco', async () => {
    const p = await pbs.buildPlan('incomplete-recovery', {}, scenario('redo'), env);
    assert.equal(p.confirm.level, 'dbname');
    assert.equal(p.confirm.dbName, 'ORCL');
    assert.equal(p.playbook.dataLoss, true);
    const [protect, recover, open, backup] = p.internal.steps;
    assert.match(protect.lines[0], /BACKUP CONTROLFILE TO '\/u01\/oracle\/oradata\/ORCL\/op_ctl_20261013\.bkp' REUSE;/);
    assert.deepEqual(recover.lines, ['WHENEVER SQLERROR CONTINUE', 'RECOVER DATABASE UNTIL CANCEL;', 'AUTO', 'RECOVER DATABASE UNTIL CANCEL;', 'CANCEL']);
    assert.deepEqual(open.lines, ['ALTER DATABASE OPEN RESETLOGS;']);
    assert.equal(backup.channel, 'rman');
    const noBackup = await pbs.buildPlan('incomplete-recovery', { backupAfter: false, usingBackupControlfile: true }, scenario('redo'), env);
    assert.equal(noBackup.internal.steps.length, 3);
    assert.match(noBackup.internal.steps[1].lines[1], /UNTIL CANCEL USING BACKUP CONTROLFILE;/);
    assert.notEqual(noBackup.hash, p.hash);
});

test('planos: parâmetros vindos do usuário nunca viram SQL sem validação', async () => {
    const s = scenario('padrao');
    await assert.rejects(pbs.buildPlan('index-rebuild', { index: "VENDAS.X'; DROP TABLE T --" }, s, env), pbs.PlanError);
    await assert.rejects(pbs.buildPlan('index-rebuild', { index: 'VENDAS.NAO_EXISTE' }, s, env), /não encontrado/);
    await assert.rejects(pbs.buildPlan('datafile-recover', { fileNo: '21 OR 1=1' }, s, env), pbs.PlanError);
    await assert.rejects(pbs.buildPlan('datafile-recover', { fileNo: 999 }, s, env), /não existe/);
    await assert.rejects(pbs.buildPlan('redo-member', { member: "2|/tmp/x'; --" }, s, env), /membro de redo existente/);
    await assert.rejects(pbs.buildPlan('restore-database', { untilTime: "2026-10-13'; --" }, s, env), /Horário inválido/);
    await assert.rejects(pbs.buildPlan('controlfile-restore', { mode: 'autobackup', dbid: '12; x' }, scenario('queda'), env), /DBID inválido/);
    await assert.rejects(pbs.buildPlan('fra-free', { mode: 'grow', addGb: -5 }, s, env), /Aumento/);
    await assert.rejects(pbs.buildPlan('nao-existe', {}, s, env), (e) => e.status === 404);
    assert.throws(() => pbs.lit("/u01/a'b.dbf"), pbs.PlanError);
    assert.equal(pbs.ident('vendas'), '"VENDAS"');
    assert.throws(() => pbs.ident('a"b'), pbs.PlanError);
    const extra = await pbs.buildPlan('flush-shared-pool', { injetado: 'DROP' }, s, env);
    assert.deepEqual(extra.params, {}, 'parâmetros desconhecidos são descartados');
});

test('planos: troca de log determinística e FRA sem estourar o disco', async () => {
    const s = scenario('padrao');
    const m = await pbs.buildPlan('redo-member', {}, s, env);
    assert.equal(m.params.member, '2|/u02/oracle/oradata/ORCL/redo02b.log', 'escolhe o membro inválido');
    const sqls = m.internal.steps[0].statements.map((x) => x.sql);
    assert.equal(sqls.length, 1, 'um bloco só: espera o grupo ficar pronto e então recria');
    assert.match(sqls[0], /^DECLARE .*EXIT WHEN s <> 'CURRENT'.*ALTER SYSTEM CHECKPOINT/);
    assert.match(sqls[0], /EXIT WHEN \(s = 'UNUSED' OR \(s = 'INACTIVE' AND a = 'YES'\)\)/, 'ARCHIVELOG: espera o grupo ser arquivado');
    assert.match(sqls[0], /DBMS_SESSION\.SLEEP\(1\)/, '19c');
    assert.ok(sqls[0].indexOf("EXECUTE IMMEDIATE 'ALTER DATABASE DROP LOGFILE MEMBER ''/u02/oracle/oradata/ORCL/redo02b.log''';") > sqls[0].indexOf('RAISE_APPLICATION_ERROR'), 'só altera depois da verificação');
    assert.ok(sqls[0].includes("EXECUTE IMMEDIATE 'ALTER DATABASE ADD LOGFILE MEMBER ''/u02/oracle/oradata/ORCL/redo02b.log'' REUSE TO GROUP 2';"));
    const tooBig = await pbs.buildPlan('fra-free', { mode: 'grow', addGb: 200 }, s, { ...env, diskFor: async () => ({ freeGB: 50 }) });
    assert.equal(tooBig.executable, false);
    assert.match(tooBig.blockers[0], /encheria o disco/);
    const force = await pbs.buildPlan('fra-free', { mode: 'force', keepDays: 2 }, s, env);
    assert.equal(force.confirm.level, 'dbname');
    assert.match(force.internal.steps[0].lines[1], /DELETE NOPROMPT FORCE ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE-2';/);
});

test('planos: sem DB_ORACLE_HOME/SID o plano vira roteiro manual (sem bloquear o que roda pela conexão)', async () => {
    const s = { ...scenario('padrao'), capabilities: { automation: false, serverOs: 'linux' } };
    const rman = await pbs.buildPlan('block-recover', {}, s, env);
    assert.equal(rman.executable, false);
    assert.ok(rman.preconditions.some((p) => p.ok === false && /Execução no servidor/.test(p.label)));
    assert.match(rman.manual, /rman target sys\/<senha>/);
    assert.doesNotMatch(rman.manual, /Sys#Senha1/, 'a senha nunca aparece no roteiro');
    const viaConn = await pbs.buildPlan('datafile-recover', { fileNo: 21 }, s, env);
    assert.ok(viaConn.executable);
    assert.equal(viaConn.internal.steps[0].channel, 'sql');
    assert.deepEqual(viaConn.internal.steps[0].statements.map((x) => x.sql), ['ALTER DATABASE RECOVER AUTOMATIC DATAFILE 21', 'ALTER DATABASE DATAFILE 21 ONLINE']);
});

// --------------------------------------------------------------------- coletor
test('coletor: script SYSDBA com marcador por seção e saída do sqlplus real', () => {
    const script = collect.buildSysdbaScript();
    for (const s of collect.SECTIONS) {
        assert.ok(script.includes(`PROMPT @@OP:S:${s.key}`), s.key);
        assert.match(s.sql, /^SELECT 'R~'\|\|/, `${s.key}: linha começa com R~`);
        assert.ok(script.includes(`${s.sql};`));
    }
    // Saída REAL do sqlplus 11.2 em /nolog (sem conexão): todas as seções com SP2-0640.
    const real = fs.readFileSync(path.join(__dirname, 'fixtures', 'sqlplus-nolog.txt'), 'utf8');
    const sec = collect.parseSectionOutput(real);
    for (const s of collect.SECTIONS) assert.deepEqual(sec[s.key].errors, ['SP2-0640: Not connected'], s.key);
    assert.equal(collect.buildSignals(sec, {}).state, 'UNKNOWN');
});

test('coletor: saída de banco MONTADO vira sinais completos', () => {
    const out = [
        'Connected.',
        '@@OP:S:instance', 'R~orcl|~|MOUNTED|~|ACTIVE|~|19.0.0.0.0|~|srv1|~|2026-10-13 07:02:11|~|STOPPED|~|ALLOWED',
        '@@OP:S:version', 'R~Oracle Database 19c Standard Edition 2 Release 19.0.0.0.0 - Production',
        '@@OP:S:params', 'R~control_files|~|/u01/oradata/ORCL/control01.ctl, /u02/fra/ORCL/control02.ctl', 'R~undo_tablespace|~|UNDOTBS1',
        '@@OP:S:database', 'R~1612345678|~|ORCL|~|ARCHIVELOG|~|MOUNTED|~|PRIMARY|~|CURRENT|~|NO|~|NO|~|183920114|~|2025-02-10 09:12:44',
        '@@OP:S:datafiles',
        'R~1|~|SYSTEM|~|READ WRITE|~|SYSTEM|~||~|NO|~|YES|~|1024|~|/u01/oradata/ORCL/system01.dbf',
        'R~7|~|RECOVER|~|READ WRITE|~|DADOS|~|FILE NOT FOUND|~|YES|~|YES|~|32767|~|/u03/oradata/ORCL/dados|07.dbf',
        '@@OP:S:recover', 'R~7|~|OFFLINE|~|FILE NOT FOUND|~|183900000|~|2026-10-13 06:00:00',
        '@@OP:S:logs',
        'R~1|~|1|~|18451|~|CURRENT|~|NO|~|2|~|512|~||~|ONLINE|~|/u01/oradata/ORCL/redo01a.log',
        'R~1|~|1|~|18451|~|CURRENT|~|NO|~|2|~|512|~|INVALID|~|ONLINE|~|/u02/oradata/ORCL/redo01b.log',
        '@@OP:S:fra', 'R~/u02/fra|~|51200|~|46080|~|1024|~|300',
        '@@OP:S:backupfiles', 'R~1|~|2026-10-12 22:00:00', 'R~7|~|2026-10-11 22:00:00',
        '@@OP:S:backupsets', 'R~2026-10-13 05:00:00|~|2026-10-13 05:01:00|~|42',
        '@@OP:S:invalid', 'SELECT ...', '*', 'ERROR at line 1:', 'ORA-01219: database or pluggable database not open: queries allowed on fixed tables or views only',
        '@@OP:END',
    ].join('\n');
    const s = collect.buildSignals(collect.parseSectionOutput(out), { source: 'teste' });
    assert.equal(s.state, 'MOUNTED');
    assert.equal(s.edition, 'SE');
    assert.equal(s.database.dbid, '1612345678');
    assert.deepEqual(s.controlFileParam, ['/u01/oradata/ORCL/control01.ctl', '/u02/fra/ORCL/control02.ctl']);
    assert.equal(s.datafiles[1].name, '/u03/oradata/ORCL/dados|07.dbf', 'caminho com "|" preservado');
    assert.equal(s.recoverFiles[0].name, '/u03/oradata/ORCL/dados|07.dbf');
    assert.equal(s.logs.length, 1);
    assert.equal(s.logs[0].memberList.length, 2);
    assert.equal(s.logs[0].memberList[1].status, 'INVALID');
    assert.equal(s.fra.usedPct, 88);
    assert.equal(s.backups.lastDb, '2026-10-11 22:00:00', 'backup completo = o mais antigo entre os últimos de cada arquivo');
    assert.equal(s.invalid, null, 'seção com erro não inventa dados');
    assert.match(s.sectionErrors.invalid, /ORA-01219/);

    const idle = collect.buildSignals(collect.parseSectionOutput('Connected to an idle instance.\n@@OP:S:instance\nORA-01034: ORACLE not available\n'), {});
    assert.equal(idle.state, 'DOWN');
});

test('coletor: erros de conexão do node-oracledb viram estado provável', () => {
    const c = (m) => collect.classifyConnectError(new Error(m));
    assert.deepEqual([c('ORA-01034: ORACLE not available').state, c('ORA-01033: ORACLE initialization or shutdown in progress').state], ['DOWN', 'NOT_OPEN']);
    assert.equal(c('NJS-518: cannot connect to Oracle Database. Service "orcl" is not registered with the listener').code, 'ORA-12514');
    assert.equal(c('NJS-510: connection to host 10.0.0.1 port 1521 timed out').state, 'UNREACHABLE');
    assert.equal(c('ORA-00257: archiver error. Connect internal only, until freed.').code, 'ORA-00257');
});

// --------------------------------------------------------------------- executor
test('executor: avaliação da saída do RMAN/sqlplus', () => {
    const rman = { channel: 'rman', lines: [] };
    assert.equal(executor.evaluateStep(rman, 0, 'RMAN-08120: WARNING: archived log not deleted\nRecovery Manager complete.').ok, true, 'RMAN-08xxx é informativo');
    assert.equal(executor.evaluateStep(rman, 1, 'RMAN-03002: failure of recover command\nRMAN-06054: media recovery requesting unknown archived log').ok, false);
    // Fim normal do RECOVER com controlfile restaurado: RMAN-06054 + código de saída 1.
    const stack = 'RMAN-00571: ===\nRMAN-00569: === ERROR MESSAGE STACK FOLLOWS ===\nRMAN-03002: failure of recover command\nRMAN-06054: media recovery requesting unknown archived log for thread 1 with sequence 9';
    const tol = executor.evaluateStep({ ...rman, tolerate06054: true }, 1, stack);
    assert.equal(tol.ok, true);
    assert.equal(tol.warnings.length, 1);
    assert.equal(executor.evaluateStep({ ...rman, tolerate06054: true }, 1, `${stack}\nRMAN-06026: some targets not found`).ok, false, 'outro erro junto continua sendo falha');
    assert.equal(executor.evaluateStep(rman, 1, stack).ok, false, 'sem a tolerância, 06054 é falha');
    // Saída REAL do sqlplus: sem conexão, o RECOVER imprime "Media recovery complete." mas falhou.
    const real = fs.readFileSync(path.join(__dirname, 'fixtures', 'sqlplus-nolog-recover.txt'), 'utf8');
    const step = { channel: 'sqlplus', lines: ['WHENEVER SQLERROR CONTINUE', 'RECOVER DATABASE UNTIL CANCEL;', 'AUTO'], benign: ['ORA-00279', 'SP2-0042'] };
    const ev = executor.evaluateStep(step, 0, real);
    assert.equal(ev.ok, false);
    assert.deepEqual(ev.fatal, ['SP2-0640']);
    assert.deepEqual(executor.codesIn('ORA-1578, ORA-00600, TNS-12541, SP2-0640'), ['ORA-01578', 'ORA-00600', 'TNS-12541', 'SP2-0640']);
});

test('executor: script do sqlplus para em erro e mostra cada comando', () => {
    const s = executor.sqlplusScript({ channel: 'sqlplus', lines: ['ALTER DATABASE OPEN;'] }, ['STARTUP MOUNT;', 'ALTER DATABASE OPEN;']);
    assert.ok(s.includes('WHENEVER SQLERROR EXIT FAILURE'));
    assert.ok(s.includes('SET DEFINE OFF'));
    assert.deepEqual(s.slice(-4), ['PROMPT SQL> STARTUP MOUNT;', 'STARTUP MOUNT;', 'PROMPT SQL> ALTER DATABASE OPEN;', 'ALTER DATABASE OPEN;']);
    const cont = executor.sqlplusScript({ channel: 'sqlplus', lines: ['WHENEVER SQLERROR CONTINUE', 'RECOVER DATABASE UNTIL CANCEL;', 'AUTO'] }, ['WHENEVER SQLERROR CONTINUE', 'RECOVER DATABASE UNTIL CANCEL;', 'AUTO']);
    assert.ok(!cont.includes('WHENEVER SQLERROR EXIT FAILURE'));
    const i = cont.indexOf('RECOVER DATABASE UNTIL CANCEL;');
    assert.equal(cont[i + 1], 'AUTO', 'a resposta AUTO vem logo depois do RECOVER');
});

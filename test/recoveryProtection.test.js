'use strict';
// Procedimentos que resolvem os alertas de prontidão: redo/controlfile multiplexados e Flashback Database.
process.env.DEMO_MODE = 'false';
process.env.DB_ORACLE_HOME = 'D:\\oracle\\product\\19.0.0\\dbhome_1';
process.env.DB_ORACLE_SID = 'orcl';
process.env.DB_SYS_PASSWORD = 'Sys#Senha1';
process.env.DB_TNS_ALIAS = '';
process.env.SSH_HOST = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const pbs = require('../src/recovery/playbooks');
const findings = require('../src/recovery/findings');
const demo = require('../src/recovery/demo');

const env = { diskFor: async () => ({ freeGB: 100 }), stamp: '20261014' };
const D = 'D:\\ORACLE\\ORADATA\\ORCL\\';

/** O ambiente do print: Windows, tudo no D:, 3 grupos com 1 membro, 2 controlfiles no mesmo diretório. */
function winSignals(over = {}) {
    demo.setScenario('padrao');
    const base = demo.signals();
    return {
        ...base,
        serverOs: 'windows',
        capabilities: { ...base.capabilities, serverOs: 'windows', automation: true },
        edition: 'EE',
        instance: { ...base.instance, version: '19.0.0.0.0' },
        database: { ...base.database, name: 'ORCL', flashbackOn: 'NO', logMode: 'ARCHIVELOG' },
        params: { ...base.params, spfile: 'D:\\ORACLE\\PRODUCT\\19.0.0\\DBHOME_1\\DATABASE\\SPFILEORCL.ORA', db_recovery_file_dest: 'D:\\ORACLE\\FAST_RECOVERY_AREA', db_name: 'ORCL' },
        fra: { dest: 'D:\\ORACLE\\FAST_RECOVERY_AREA', limitMb: 29696, usedMb: 10512, reclaimableMb: 0, usedPct: 35.4 },
        datafiles: [
            { fileNo: 1, ts: 'SYSTEM', status: 'SYSTEM', name: `${D}SYSTEM01.DBF` },
            { fileNo: 2, ts: 'DADOS', status: 'ONLINE', name: `${D}DADOS1.DBF` },
        ],
        tempfiles: [{ fileNo: 1, ts: 'TEMP', status: 'ONLINE', name: `${D}TEMP01.DBF` }],
        logs: [1, 2, 3].map((g) => ({ group: g, thread: 1, sequence: 3090 + g, status: g === 3 ? 'CURRENT' : 'INACTIVE', archived: g === 3 ? 'NO' : 'YES', members: 1, sizeMb: 200, memberList: [{ status: null, type: 'ONLINE', path: `${D}REDO0${g}.LOG` }] })),
        controlfiles: [{ status: null, name: `${D}CONTROL01.CTL` }, { status: null, name: `${D}CONTROL02.CTL` }],
        controlFileParam: [`${D}CONTROL01.CTL`, `${D}CONTROL02.CTL`],
        ...over,
    };
}

const scriptOf = (plan) => plan.steps.map((s) => s.script || '').join('\n');

test('prontidão: os três itens trazem o procedimento que os resolve', () => {
    const r = findings.evaluate(winSignals());
    const item = (id) => r.readiness.items.find((i) => i.id === id);
    assert.equal(item('redomux').status, 'warn');
    assert.deepEqual(item('redomux').action, { id: 'redo-multiplex', label: 'Multiplexar agora' });
    assert.match(item('cfmux').detail, /mesmo diretório/);
    assert.equal(item('cfmux').action.id, 'controlfile-multiplex');
    assert.equal(item('flashback').action.id, 'flashback-on');
    // Standard Edition: sem botão de Flashback (o recurso não existe nela)
    const se = findings.evaluate(winSignals({ edition: 'SE' })).readiness.items.find((i) => i.id === 'flashback');
    assert.equal(se.action, undefined);
    assert.match(se.detail, /Enterprise Edition/);
});

test('redo: 2º membro de cada grupo, pasta criada antes, trocas de log; tudo com o banco no ar', async () => {
    const p = await pbs.buildPlan('redo-multiplex', {}, winSignals(), env);
    assert.equal(p.executable, true, p.blockers.join(' | '));
    assert.equal(p.playbook.downtime, false);
    // Só há o disco D: — a sugestão é a pasta do banco na FRA (diretório próprio), com aviso de mesmo disco.
    assert.equal(p.params.dir, 'D:\\ORACLE\\FAST_RECOVERY_AREA\\ORCL\\');
    assert.equal(p.preconditions.find((c) => c.label === 'Novos membros em outro disco').ok, null);
    assert.deepEqual(p.steps.map((s) => s.channel), ['mkdir', 'sql', 'sql']);
    const sql = scriptOf(p);
    // Cada grupo: espera ficar INATIVO e ARQUIVADO e só então recebe o membro (o archiver nunca lê o arquivo vazio).
    for (const g of [1, 2, 3]) {
        const block = p.internal.steps[1].statements[g - 1].sql;
        assert.match(block, new RegExp(`FROM v\\$log WHERE group# = ${g}; EXIT WHEN \\(s = 'UNUSED' OR \\(s = 'INACTIVE' AND a = 'YES'\\)\\)`), `grupo ${g}: espera`);
        assert.ok(block.includes(`EXECUTE IMMEDIATE 'ALTER DATABASE ADD LOGFILE MEMBER ''D:\\ORACLE\\FAST_RECOVERY_AREA\\ORCL\\REDO0${g}B.LOG'' TO GROUP ${g}';`), `grupo ${g}: membro`);
        assert.ok(block.indexOf('ADD LOGFILE MEMBER') > block.indexOf('RAISE_APPLICATION_ERROR'), `grupo ${g}: só depois da verificação`);
    }
    assert.match(sql, /FOR i IN 1\.\.3 LOOP EXECUTE IMMEDIATE 'ALTER SYSTEM SWITCH LOGFILE'/);
    // Banco só montado: não se aplica (exige trocas de log e arquivamento)
    assert.equal((await pbs.buildPlan('redo-multiplex', {}, winSignals({ state: 'MOUNTED' }), env)).executable, false);

    // Outro disco informado pelo DBA
    const e = await pbs.buildPlan('redo-multiplex', { dir: 'E:\\ORACLE\\REDO' }, winSignals(), env);
    assert.equal(e.preconditions.find((c) => c.label === 'Novos membros em outro disco').ok, true);
    assert.ok(scriptOf(e).includes("ADD LOGFILE MEMBER ''E:\\ORACLE\\REDO\\REDO01B.LOG'' TO GROUP 1"));
    assert.equal(e.steps[0].script, "New-Item -ItemType Directory -Force -Path 'E:\\ORACLE\\REDO'");

    // Mesmo diretório dos membros atuais: bloqueado
    const same = await pbs.buildPlan('redo-multiplex', { dir: D }, winSignals(), env);
    assert.equal(same.executable, false);
    assert.match(same.blockers.join(' '), /mesmo dos membros atuais/);
    // Caminho Linux num banco Windows: recusado
    await assert.rejects(pbs.buildPlan('redo-multiplex', { dir: '/u02/redo' }, winSignals(), env), /Windows/);
    // Nada a fazer quando todos os grupos já têm 2 membros
    const done = winSignals();
    done.logs = done.logs.map((g) => ({ ...g, memberList: [...g.memberList, { status: null, type: 'ONLINE', path: `E:\\ORACLE\\REDO\\REDO0${g.group}B.LOG` }] }));
    assert.match((await pbs.buildPlan('redo-multiplex', {}, done, env)).blockers.join(' '), /já têm 2 ou mais membros/);
    assert.equal(findings.evaluate(done).readiness.items.find((i) => i.id === 'redomux').status, 'ok');
});

test('controlfile: nova cópia em CONTROL_FILES (spfile), reinício em NOMOUNT, RMAN grava, abre — com confirmação forte', async () => {
    const p = await pbs.buildPlan('controlfile-multiplex', {}, winSignals(), env);
    assert.equal(p.executable, true, p.blockers.join(' | '));
    assert.equal(p.playbook.downtime, true);
    assert.equal(p.confirm.level, 'dbname', 'reinicia o banco: digitar o nome');
    assert.deepEqual(p.steps.map((s) => s.channel), ['mkdir', 'sqlplus', 'sqlplus', 'rman', 'sqlplus']);
    const target = 'D:\\ORACLE\\FAST_RECOVERY_AREA\\ORCL\\CONTROL03.CTL';
    const sql = scriptOf(p);
    assert.ok(sql.includes(`ALTER SYSTEM SET control_files = '${D}CONTROL01.CTL', '${D}CONTROL02.CTL', '${target}' SCOPE=SPFILE;`));
    assert.match(p.steps[2].script, /SHUTDOWN IMMEDIATE;\nSTARTUP NOMOUNT;/, 'com o banco aberto: parada limpa (não ABORT)');
    assert.ok(p.steps[3].script.includes(`RESTORE CONTROLFILE FROM '${D}CONTROL01.CTL';`));
    assert.match(p.steps[3].script, /ALTER DATABASE MOUNT;/);
    assert.match(p.steps[4].script, /ALTER DATABASE OPEN;/);
    assert.doesNotMatch(sql, /RESETLOGS/);

    // Depois de aplicado, o item de prontidão fica ok
    const after = winSignals({ controlFileParam: [`${D}CONTROL01.CTL`, `${D}CONTROL02.CTL`, target] });
    assert.equal(findings.evaluate(after).readiness.items.find((i) => i.id === 'cfmux').status, 'ok');

    // Sem SPFILE, em ASM ou no mesmo diretório: bloqueado
    const noSpfile = winSignals();
    noSpfile.params = { ...noSpfile.params, spfile: '' };
    assert.match((await pbs.buildPlan('controlfile-multiplex', {}, noSpfile, env)).blockers.join(' '), /PFILE/);
    assert.match((await pbs.buildPlan('controlfile-multiplex', {}, winSignals({ controlFileParam: ['+DATA/ORCL/CONTROLFILE/current.260.1'] }), env)).blockers.join(' '), /ASM/);
    assert.match((await pbs.buildPlan('controlfile-multiplex', { dir: D }, winSignals(), env)).blockers.join(' '), /já tem uma cópia/);
    // Banco fechado: não se aplica (o CONTROL_FILES é alterado com a instância no ar)
    assert.equal((await pbs.buildPlan('controlfile-multiplex', {}, winSignals({ state: 'DOWN' }), env)).executable, false);
});

test('Flashback Database: retenção + FLASHBACK ON com o banco aberto; edição, ARCHIVELOG e FRA conferidos', async () => {
    const p = await pbs.buildPlan('flashback-on', { retentionMin: 2880 }, winSignals(), env);
    assert.equal(p.executable, true, p.blockers.join(' | '));
    assert.equal(p.playbook.downtime, false);
    assert.equal(scriptOf(p), 'ALTER SYSTEM SET db_flashback_retention_target = 2880 SCOPE=BOTH;\nALTER DATABASE FLASHBACK ON;');
    const blocked = async (over, re) => assert.match((await pbs.buildPlan('flashback-on', {}, winSignals(over), env)).blockers.join(' '), re);
    await blocked({ edition: 'SE' }, /Enterprise Edition/);
    await blocked({ database: { ...winSignals().database, logMode: 'NOARCHIVELOG' } }, /ARCHIVELOG/);
    await blocked({ database: { ...winSignals().database, flashbackOn: 'YES' } }, /já está ativo/);
    await blocked({ fra: null, params: { ...winSignals().params, db_recovery_file_dest: '' } }, /FRA/);
    await blocked({ instance: { ...winSignals().instance, version: '11.1.0.7.0' } }, /11gR2/);
    await assert.rejects(pbs.buildPlan('flashback-on', { retentionMin: 10 }, winSignals(), env), /Janela de retenção/);
});

test('DEMO: aplicar os procedimentos muda o diagnóstico simulado', () => {
    demo.setScenario('padrao');
    const before = findings.evaluate(demo.signals()).readiness.items;
    assert.equal(before.find((i) => i.id === 'cfmux').status, 'warn');
    demo.apply('controlfile-multiplex', {});
    demo.apply('flashback-on', {});
    const after = findings.evaluate(demo.signals()).readiness.items;
    assert.equal(after.find((i) => i.id === 'cfmux').status, 'ok');
    assert.equal(after.find((i) => i.id === 'flashback').status, 'ok');
    demo.setScenario('padrao');
});

test('volumes: raiz por letra de unidade, montagem ou disk group', () => {
    assert.equal(pbs.volumeRoot('D:\\ORACLE\\X.LOG'), 'D:');
    assert.equal(pbs.volumeRoot('/u02/oradata/redo.log'), '/u02');
    assert.equal(pbs.volumeRoot('+FRA/ORCL/x'), '+FRA');
    const s = winSignals({ datafiles: [{ fileNo: 9, ts: 'DADOS', status: 'ONLINE', name: 'E:\\ORADATA\\ORCL\\DADOS9.DBF' }] });
    assert.deepEqual(pbs.suggestMirrorDir(s, [`${D}REDO01.LOG`], { sub: 'REDO_B' }), { dir: 'E:\\ORADATA\\ORCL\\', otherVolume: true });
});

// ------------------------------------------------------------------ o caso do cliente (alert log em português)
const alertLog = require('../src/recovery/alertLog');
const FRA_DIR = 'D:\\ORACLE\\FAST_RECOVERY_AREA\\ORCL\\';
const ADD_TEXT = [
    '2026-10-14T14:15:30.100000-03:00',
    `Completed: ALTER DATABASE ADD LOGFILE MEMBER '${FRA_DIR}REDO02B.LOG' TO GROUP 2`,
].join('\n');
const errText = (path) => [
    '2026-10-14T14:16:46.000000-03:00',
    'Errors in file D:\\ORACLE\\diag\\rdbms\\orcl\\orcl\\trace\\orcl_arc3_1392.trc:',
    'ORA-00313: a abertura falhou para os membros do grupo 2 de log do thread 1',
    `ORA-00312: log on-line 2 do thread 1: '${path}'`,
    'ORA-27046: tamanho do arquivo não é um múltiplo do tamanho do bloco lógico',
    '2026-10-14T14:16:47.000000-03:00',
    'Errors in file D:\\ORACLE\\diag\\rdbms\\orcl\\orcl\\trace\\orcl_arc0_1360.trc:',
    'ORA-00313: a abertura falhou para os membros do grupo 2 de log do thread 1',
].join('\n');

/** Sinais do cliente depois de multiplexar: grupo 2 com o membro novo na FRA. */
function afterAdd(text, newStatus = null) {
    const records = alertLog.parseAlertText(text);
    const s = winSignals();
    s.logs = s.logs.map((g) => (g.group !== 2 ? g : { ...g, memberList: [...g.memberList, { status: newStatus, type: 'ONLINE', path: `${FRA_DIR}REDO02B.LOG` }] }));
    s.alert = { ...s.alert, days: 7, records, groups: alertLog.groupErrors(records), lifecycle: alertLog.lifecycle(records) };
    return s;
}

test('alert log em português: grupo, membro e arquivos reconhecidos (não só em inglês)', () => {
    const [r] = alertLog.parseAlertText(errText(`${FRA_DIR}REDO02B.LOG`));
    assert.deepEqual(r.logs, [{ group: 2, thread: 1, path: `${FRA_DIR}REDO02B.LOG` }]);
    assert.deepEqual(r.redoGroups, [{ group: 2, thread: 1 }]);
    const pt = alertLog.parseAlertText([
        '2026-10-14T10:00:00.000000-03:00',
        "ORA-01110: arquivo de dados 5: 'D:\\ORACLE\\ORADATA\\ORCL\\DADOS2.DBF'",
        'ORA-01157: não é possível identificar/bloquear arquivo de dados 7 - consulte o arquivo de análise DBWR',
        "ORA-00202: arquivo de controle: 'D:\\ORACLE\\ORADATA\\ORCL\\CONTROL02.CTL'",
        'ORA-01578: bloco de dados ORACLE corrompido (arquivo nº 11, bloco nº 48213)',
    ].join('\n'))[0];
    assert.deepEqual(pt.files.map((f) => f.fileNo), [5, 7]);
    assert.deepEqual(pt.controlfiles, ['D:\\ORACLE\\ORADATA\\ORCL\\CONTROL02.CTL']);
    assert.deepEqual(pt.blocks, [{ fileNo: 11, block: 48213 }]);
    const en = alertLog.parseAlertText(['2026-10-14T10:00:00.000000-03:00', "ORA-00312: online log 3 thread 1: '/u01/redo03.log'", 'ORA-01578: ORACLE data block corrupted (file # 4, block # 99)'].join('\n'))[0];
    assert.deepEqual([en.logs[0].group, en.logs[0].path, en.blocks[0].block], [3, '/u01/redo03.log', 99]);
    const add = alertLog.parseAlertText(ADD_TEXT)[0];
    assert.equal(add.event, 'redo-member-added');
    assert.deepEqual(add.addedMembers, [{ path: `${FRA_DIR}REDO02B.LOG`, group: 2 }]);
});

test('ORA-00313 no membro recém-adicionado: aviso esperado (baixo), sem botão de recriar/limpar', () => {
    const r = findings.evaluate(afterAdd(`${ADD_TEXT}\n${errText(`${FRA_DIR}REDO02B.LOG`)}`));
    const f = r.findings.find((x) => x.id === 'redo-member-added');
    assert.ok(f, JSON.stringify(r.findings.map((x) => x.id)));
    assert.equal(f.severity, 'low');
    assert.equal(f.status, 'historical', 'o membro novo já está válido');
    assert.equal(f.playbooks.length, 0);
    assert.match(f.detail, /arquivou pelo membro original/);
    assert.ok(!r.findings.some((x) => x.code === 'ORA-00313' && x.id !== 'redo-member-added'), 'sem o alerta CRÍTICO genérico');
    assert.ok(!r.findings.some((x) => x.id.startsWith('redo-member-2')), 'sem "membro inválido" para recriar');

    // Ainda INVALID (o grupo não voltou a ser o corrente): aviso ativo, baixo
    const pending = findings.evaluate(afterAdd(`${ADD_TEXT}\n${errText(`${FRA_DIR}REDO02B.LOG`)}`, 'INVALID')).findings.find((x) => x.id === 'redo-member-added');
    assert.deepEqual([pending.status, pending.severity], ['active', 'low']);
    // Adicionado sem erro e ainda INVALID: "aguardando o primeiro uso", não "inválido"
    const quiet = findings.evaluate(afterAdd(ADD_TEXT, 'INVALID'));
    assert.match(quiet.findings.find((x) => x.id === 'redo-member-added').title, /aguardando o primeiro uso/);
    assert.ok(!quiet.findings.some((x) => x.id.startsWith('redo-member-2')));
});

test('erro no membro ORIGINAL depois da inclusão continua sendo problema real', () => {
    const r = findings.evaluate(afterAdd(`${ADD_TEXT}\n${errText(`${D}REDO02.LOG`)}`));
    const real = r.findings.find((x) => x.id === `redo-member-2-${D}REDO02.LOG`);
    assert.ok(real, JSON.stringify(r.findings.map((x) => x.id)));
    assert.equal(real.playbooks[0].id, 'redo-member');
    assert.ok(!r.findings.some((x) => x.id === 'redo-member-added' && x.status === 'historical' && x.code === 'ORA-00313'), 'não é escondido como aviso esperado');
});

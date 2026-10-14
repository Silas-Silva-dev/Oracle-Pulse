'use strict';
// Base de conhecimento de erros e leitura do alert log.
process.env.DEMO_MODE = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const kb = require('../src/recovery/knowledge');
const alertLog = require('../src/recovery/alertLog');
const { CATALOG } = require('../src/recovery/playbooks');

test('base: toda entrada é completa e só aponta procedimentos que existem', () => {
    const sev = ['critical', 'high', 'medium', 'low', 'info'];
    const all = { ...kb.ERRORS, ...kb.RMAN_ERRORS };
    for (const [code, e] of Object.entries(all)) {
        assert.match(code, /^(ORA|RMAN)-\d{5}$/, code);
        assert.ok(e.title && e.meaning, `${code} sem título/significado`);
        assert.ok(kb.CATEGORIES[e.category], `${code}: categoria ${e.category}`);
        assert.ok(sev.includes(e.severity), `${code}: severidade ${e.severity}`);
        for (const p of e.playbooks) assert.ok(CATALOG[p], `${code} aponta para procedimento inexistente: ${p}`);
    }
    for (const a of kb.ORA600_ARGS) for (const p of a.playbooks) assert.ok(CATALOG[p], `ORA-600 ${a.re}: ${p}`);
    for (const ph of kb.PHRASES) for (const p of ph.playbooks) assert.ok(CATALOG[p], `frase ${ph.code}: ${p}`);
    assert.ok(Object.keys(kb.ERRORS).length >= 80, 'base cobre os erros mais comuns');
});

test('ORA-00600: o primeiro argumento define o tratamento', () => {
    const k = kb.lookup('ORA-00600', 'kcratr_scan_lastbwr');
    assert.equal(k.generic, false);
    assert.deepEqual(k.playbooks, ['crash-recovery']);
    assert.deepEqual(kb.lookup('ORA-00600', '4194').playbooks, ['undo-recreate']);
    assert.ok(kb.lookup('ORA-00600', 'kdsgrp1').playbooks.includes('index-rebuild'));
    assert.deepEqual(kb.lookup('ORA-00600', 'kccpb_sanity_check_2').playbooks, ['controlfile-restore']);
    const unknown = kb.lookup('ORA-00600', 'qksfoo_bar1');
    assert.equal(unknown.generic, true);
    assert.equal(unknown.title, 'Erro interno do Oracle');
    assert.equal(kb.firstArg('ORA-00600: internal error code, arguments: [kcratr_nab_less_than_odr], [1], [2]', 'ORA-00600'), 'kcratr_nab_less_than_odr');
    assert.equal(kb.firstArg('ORA 600 [kdsgrp1]', 'ORA-00600'), 'kdsgrp1');
    assert.equal(kb.firstArg('ORA-07445: exception encountered: core dump [kghalo()+120] [SIGSEGV]', 'ORA-07445'), 'kghalo()+120');
});

test('consulta de texto livre: normaliza códigos e reconhece frases', () => {
    const r = kb.analyzeText('TNS-12541: TNS:no listener\nora-1578 no bloco\nRMAN-6054 ao final');
    assert.deepEqual(r.map((x) => x.code), ['ORA-12541', 'ORA-01578', 'RMAN-06054']);
    assert.ok(r.every((x) => x.known));
    const ph = kb.analyzeText('preciso fazer um recover database until cancel');
    assert.equal(ph[0].code, 'RECOVER UNTIL CANCEL');
    assert.deepEqual(ph[0].entry.playbooks, ['incomplete-recovery']);
    assert.equal(kb.analyzeText('ORA-99999: inexistente')[0].known, false);
    assert.equal(kb.analyzeText('nada aqui').length, 0);
    assert.equal(kb.lookup('ORA-03113').correlate, true, 'ORA-03113 é sintoma: cruza com o diagnóstico');
});

const ALERT_19C = [
    '2026-10-13T07:02:11.123456-03:00',
    'Starting ORACLE instance (normal) (OS id: 1834)',
    '2026-10-13T07:03:00.000000-03:00',
    'Completed: ALTER DATABASE MOUNT',
    '2026-10-13T07:03:05.000000-03:00',
    'Errors in file /u01/app/oracle/diag/rdbms/orcl/orcl/trace/orcl_ora_1902.trc  (incident=48121):',
    'ORA-00600: internal error code, arguments: [kcratr_scan_lastbwr], [], [], [], [], [], [], [], [], [], [], []',
    '2026-10-13T07:03:06.000000-03:00',
    'ORA-600 signalled during: ALTER DATABASE OPEN...',
    '2026-10-13T07:20:00.000000-03:00',
    'Completed: ALTER DATABASE OPEN',
    '2026-10-13T09:00:00.000000-03:00',
    'Errors in file /u01/.../orcl_ora_7781.trc  (incident=48377):',
    'ORA-01578: ORACLE data block corrupted (file # 11, block # 48213)',
    "ORA-01110: data file 11: '/u02/oracle/oradata/ORCL/indices01.dbf'",
    '2026-10-13T10:00:00.000000-03:00',
    'Errors in file /u01/.../orcl_lgwr_1957.trc:',
    'ORA-00313: open failed for members of log group 2 of thread 1',
    "ORA-00312: online log 2 thread 1: '/u02/oracle/oradata/ORCL/redo02b.log'",
    'ORA-27037: unable to obtain file status',
    '2026-10-13T11:00:00.000000-03:00',
    'Errors in file /u01/.../orcl_j000_5512.trc:',
    'ORA-12012: error on auto execute of job "VENDAS"."SYNC"',
    'ORA-03113: end-of-file on communication channel',
    '2026-10-13T12:00:00.000000-03:00',
    'ORA-1652: unable to extend temp segment by 128 in tablespace TEMP',
    '2026-10-13T12:30:00.000000-03:00',
    'CKPT (ospid: 2817): terminating the instance due to ORA error 494',
    '2026-10-13T12:30:04.000000-03:00',
    'Instance terminated by CKPT, pid = 2817',
    '2026-10-13T12:31:00.000000-03:00',
    'Thread 1 advanced to log sequence 18452 (LGWR switch)',
].join('\n');

test('alert log 12.2+: registros, códigos, objetos citados e ciclo de vida', () => {
    const recs = alertLog.parseAlertText(ALERT_19C);
    assert.ok(!recs.some((r) => /Thread 1 advanced/.test(r.text)), 'linhas sem erro/evento são ignoradas');
    const ora600 = recs.find((r) => r.codes.some((c) => c.code === 'ORA-00600'));
    assert.deepEqual(ora600.codes, [{ code: 'ORA-00600', arg: 'kcratr_scan_lastbwr' }]);
    assert.equal(ora600.incident, 48121);
    assert.equal(ora600.time, '2026-10-13 07:03:05');
    assert.equal(ora600.epoch, Date.parse('2026-10-13T07:03:05-03:00'));
    assert.ok(!recs.some((r) => /signalled during/.test(r.text) && r.codes.length), '"signalled during" não conta de novo');
    const corr = recs.find((r) => r.blocks.length);
    assert.deepEqual(corr.blocks, [{ fileNo: 11, block: 48213 }]);
    assert.deepEqual(corr.files, [{ fileNo: 11, path: '/u02/oracle/oradata/ORCL/indices01.dbf' }]);
    const redo = recs.find((r) => r.logs.length);
    assert.deepEqual(redo.logs, [{ group: 2, thread: 1, path: '/u02/oracle/oradata/ORCL/redo02b.log' }]);
    assert.ok(recs.some((r) => r.codes.some((c) => c.code === 'ORA-01652')), 'ORA-1652 sem zero à esquerda é normalizado');

    const lc = alertLog.lifecycle(recs);
    assert.equal(lc.lastStartup.time, '2026-10-13 07:02:11');
    assert.equal(lc.lastOpen.time, '2026-10-13 07:20:00');
    assert.equal(lc.lastCrash.time, '2026-10-13 12:30:04');
    assert.equal(lc.lastCrash.crashCode, 'ORA-00494', 'herda o código do registro irmão da queda');

    const groups = alertLog.groupErrors(recs);
    const g3113 = groups.find((g) => g.code === 'ORA-03113');
    assert.equal(g3113.jobCount, 1, 'erro dentro de job agendado');
    assert.deepEqual(g3113.with, ['ORA-12012']);
    assert.ok(groups.find((g) => g.code === 'ORA-00313').with.includes('ORA-27037'));
});

test('alert log 11g/12.1 (data por extenso) e filtro por período', () => {
    const text = [
        'Tue Oct 13 07:02:11 2026',
        'Starting ORACLE instance (normal)',
        'Wed Oct 14 08:15:00 2026',
        "ORA-00202: control file: '/u01/oradata/ORCL/control01.ctl'",
        'ORA-00205: error in identifying control file, check alert log for more info',
    ].join('\n');
    const recs = alertLog.parseAlertText(text);
    assert.equal(recs.length, 2);
    assert.equal(recs[1].time, '2026-10-14 08:15:00');
    assert.deepEqual(recs[1].controlfiles, ['/u01/oradata/ORCL/control01.ctl']);
    assert.deepEqual(recs[1].codes.map((c) => c.code), ['ORA-00202', 'ORA-00205']);
    const since = new Date(2026, 9, 14, 0, 0, 0).getTime();
    assert.equal(alertLog.parseAlertText(text, { sinceEpoch: since }).length, 1);
});

test('linhas de V$DIAG_ALERT_EXT viram os mesmos registros', () => {
    const recs = alertLog.parseAlertRows([
        { ts: '2026-10-13T09:00:00.000-03:00', text: 'ORA-01578: ORACLE data block corrupted (file # 7, block # 99)\nORA-01110: data file 7: \'/u01/x.dbf\'' },
        { ts: '2026-10-13T09:05:00.000-03:00', text: 'Completed: ALTER DATABASE OPEN' },
        { ts: '2026-10-13T09:06:00.000-03:00', text: 'Thread 1 advanced' },
    ]);
    assert.equal(recs.length, 2);
    assert.deepEqual(recs[0].blocks, [{ fileNo: 7, block: 99 }]);
    assert.equal(recs[1].event, 'open');
});

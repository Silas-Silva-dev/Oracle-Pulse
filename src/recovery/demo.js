/**
 * DEMO.JS - Diagnósticos simulados da tela Recuperação (DEMO_MODE=true).
 *
 * Cada cenário monta os mesmos sinais que o coletor real e um alert log em
 * TEXTO (formato 19c), lido pelo parser real — assim o modo DEMO exercita o
 * mesmo caminho do diagnóstico de verdade. Executar o procedimento certo
 * "conserta" o cenário (e grava o evento no alert log simulado).
 */
const { demoDatafiles } = require('../mockData');
const alertLog = require('./alertLog');

const SCENARIOS = {
    padrao: 'Banco aberto com problemas variados',
    queda: 'Queda de energia: banco não abre (ORA-600)',
    parado: 'Instância parada (storage travou)',
    fra: 'FRA cheia: archiver travado (ORA-00257)',
    redo: 'Redo corrente perdido: banco não abre',
};

const TRACE = '/u01/app/oracle/diag/rdbms/orcl/orcl/trace';
const demo = { scenario: 'padrao', fixed: new Set(), extra: [], fraAddGb: 0, startedAt: Date.now() };

function isoLocal(ms) {
    const d = new Date(ms);
    const off = -d.getTimezoneOffset();
    const p = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
    const tz = `${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000${tz}`;
}

function setScenario(name) {
    if (!SCENARIOS[name]) throw new Error('Cenário desconhecido.');
    demo.scenario = name;
    demo.fixed.clear();
    demo.extra = [];
    demo.fraAddGb = 0;
    demo.startedAt = Date.now();
}

const H = 3600000;
const D = 24 * H;

/** Alert log (texto) do cenário, com os eventos dos procedimentos já executados. */
function alertText(now) {
    const t0 = demo.startedAt;
    const entries = [];
    const at = (ms, ...lines) => entries.push({ ms, lines });
    const sc = demo.scenario;

    // Histórico comum: queda de energia 3 dias atrás, recuperada pelo DBA.
    at(now - 3 * D - 5 * H, 'Starting ORACLE instance (normal) (OS id: 1834)');
    at(now - 3 * D - 5 * H + 40000, 'Completed: ALTER DATABASE MOUNT /* db agent *//* {0:0:247} */');
    at(now - 3 * D - 5 * H + 42000, 'Beginning crash recovery of 1 threads');
    at(now - 3 * D - 5 * H + 47000,
        `Errors in file ${TRACE}/orcl_ora_1902.trc  (incident=48121):`,
        'ORA-00600: internal error code, arguments: [kcratr_scan_lastbwr], [], [], [], [], [], [], [], [], [], [], []');
    at(now - 3 * D - 4 * H, 'ALTER DATABASE RECOVER  database', 'Media Recovery Start', 'Media Recovery Complete (orcl)', 'Completed: ALTER DATABASE RECOVER  database');
    at(now - 3 * D - 4 * H + 60000, 'Completed: ALTER DATABASE OPEN');

    if (sc === 'padrao') {
        at(now - 2 * D - 3 * H,
            `Errors in file ${TRACE}/orcl_j000_5512.trc:`,
            'ORA-12012: error on auto execute of job "VENDAS"."SYNC_FILIAIS"',
            'ORA-03113: end-of-file on communication channel');
        at(now - 2 * D, 'ORA-01555 caused by SQL statement below (SQL ID: 7h35uxf5uhmm1, Query Duration=1849 sec, SCN: 0x0000.0abc1234):');
        at(now - 30 * H, `Errors in file ${TRACE}/orcl_ora_6620.trc:`, 'ORA-00060: Deadlock detected. More info in file ' + `${TRACE}/orcl_ora_6620.trc.`);
        at(now - 26 * H, 'ORA-19815: WARNING: db_recovery_file_dest_size of 53687091200 bytes is 85.12% used, and has 7996178432 remaining bytes available.');
        if (!demo.fixed.has('corruption')) {
            for (const [h, blk] of [[20, 48213], [9, 48213], [2, 48214]]) {
                at(now - h * H,
                    'Hex dump of (file 11, block ' + blk + ') in trace file ' + `${TRACE}/orcl_ora_7781.trc`,
                    `Corrupt block relative dba: 0x02c0bc55 (file 11, block ${blk})`,
                    'Bad check value found during multiblock buffer read',
                    `Errors in file ${TRACE}/orcl_ora_7781.trc  (incident=48377):`,
                    `ORA-01578: ORACLE data block corrupted (file # 11, block # ${blk})`,
                    "ORA-01110: data file 11: '/u02/oracle/oradata/ORCL/indices01.dbf'");
            }
        }
        if (!demo.fixed.has('df21')) {
            at(now - 7 * H,
                `Errors in file ${TRACE}/orcl_dbw0_2210.trc:`,
                'ORA-01116: error in opening database file 21',
                "ORA-01110: data file 21: '/u03/oracle/oradata/ORCL/dados15.dbf'",
                'ORA-27072: File I/O error',
                'Automatic datafile offline due to write error on',
                "file 21: '/u03/oracle/oradata/ORCL/dados15.dbf'");
        }
        if (!demo.fixed.has('redo02b')) {
            at(now - 4 * H,
                `Errors in file ${TRACE}/orcl_lgwr_1957.trc:`,
                'ORA-00313: open failed for members of log group 2 of thread 1',
                "ORA-00312: online log 2 thread 1: '/u02/oracle/oradata/ORCL/redo02b.log'",
                'ORA-27037: unable to obtain file status');
        }
    }
    if (sc === 'queda') {
        at(t0 - 20 * 60000, 'Starting ORACLE instance (normal) (OS id: 4410)');
        at(t0 - 19 * 60000, 'Completed: ALTER DATABASE MOUNT');
        at(t0 - 19 * 60000 + 2000, 'Beginning crash recovery of 1 threads');
        at(t0 - 18 * 60000,
            `Errors in file ${TRACE}/orcl_ora_4471.trc  (incident=50112):`,
            'ORA-00600: internal error code, arguments: [kcratr_scan_lastbwr], [], [], [], [], [], [], [], [], [], [], []',
            'Aborting crash recovery due to error 600',
            'ORA-600 signalled during: ALTER DATABASE OPEN...');
    }
    if (sc === 'parado') {
        at(t0 - 40 * 60000,
            'ORA-00494: enqueue [CF] held for too long (more than 900 seconds) by \'inst 1, osid 2817\'',
            'System state dump requested by (instance=1, osid=2817 (CKPT)), summary=[abnormal instance termination].');
        at(t0 - 40 * 60000 + 5000, 'CKPT (ospid: 2817): terminating the instance due to ORA error 494');
        at(t0 - 40 * 60000 + 9000, 'Instance terminated by CKPT, pid = 2817');
    }
    if (sc === 'fra' && !demo.fixed.has('fra')) {
        for (const m of [55, 31, 6]) {
            at(t0 - m * 60000,
                `Errors in file ${TRACE}/orcl_arc1_3301.trc:`,
                'ORA-19809: limit exceeded for recovery files',
                'ORA-19804: cannot reclaim 52428800 bytes disk space from 53687091200 bytes limit',
                'ARC1: Error 19809 Creating archive log file to \'/u01/app/oracle/fast_recovery_area/ORCL/archivelog\'',
                'ORA-16038: log 3 sequence# 18452 cannot be archived',
                'ORA-00257: archiver error. Connect internal only, until freed.');
        }
    }
    if (sc === 'redo') {
        at(t0 - 25 * 60000, 'Starting ORACLE instance (normal) (OS id: 5520)');
        at(t0 - 24 * 60000, 'Completed: ALTER DATABASE MOUNT');
        at(t0 - 24 * 60000 + 3000,
            `Errors in file ${TRACE}/orcl_lgwr_5531.trc:`,
            'ORA-00313: open failed for members of log group 1 of thread 1',
            "ORA-00312: online log 1 thread 1: '/u01/oracle/oradata/ORCL/redo01.log'",
            'ORA-27037: unable to obtain file status',
            'Linux-x86_64 Error: 2: No such file or directory');
        at(t0 - 24 * 60000 + 3500, 'ORA-313 signalled during: ALTER DATABASE OPEN...');
    }
    for (const e of demo.extra) at(e.ms, ...e.lines);
    // Um alert log real é cronológico.
    entries.sort((a, b) => a.ms - b.ms);
    return entries.map((e) => [isoLocal(e.ms), ...e.lines].join('\n')).join('\n') + '\n';
}

function stateOf() {
    const sc = demo.scenario;
    if (['queda', 'parado', 'redo'].includes(sc) && !demo.fixed.has('opened')) {
        if (sc === 'parado') return 'DOWN';
        return 'MOUNTED';
    }
    return 'OPEN';
}

function datafiles(state) {
    return demoDatafiles().map((r) => {
        const sys = r.TABLESPACE_NAME === 'SYSTEM';
        let status = sys ? 'SYSTEM' : 'ONLINE';
        if (demo.scenario === 'padrao' && r.FILE_ID === 21 && !demo.fixed.has('df21')) status = 'RECOVER';
        return {
            fileNo: r.FILE_ID, status, enabled: 'READ WRITE', ts: r.TABLESPACE_NAME, hdrError: null,
            recover: status === 'RECOVER' ? 'YES' : 'NO',
            fuzzy: state === 'MOUNTED' ? 'YES' : 'NO',
            sizeMb: r.SIZE_MB, name: r.FILE_NAME,
        };
    });
}

/** Sinais do cenário atual (mesmo formato de collect.buildSignals + alert). */
function signals() {
    const now = Date.now();
    const state = stateOf();
    const sc = demo.scenario;
    const dfs = state === 'DOWN' ? [] : datafiles(state);
    const recoverFiles = [];
    if (sc === 'padrao' && !demo.fixed.has('df21')) {
        recoverFiles.push({ fileNo: 21, onlineStatus: 'OFFLINE', error: null, change: '183920114', time: isoLocal(now - 7 * H).slice(0, 19).replace('T', ' '), name: '/u03/oracle/oradata/ORCL/dados15.dbf', ts: 'DADOS' });
    }

    const logs = state === 'DOWN' ? [] : [1, 2, 3].map((g) => ({
        group: g, thread: 1, sequence: 18450 + g,
        status: sc === 'redo' && !demo.fixed.has('opened') ? (g === 1 ? 'CURRENT' : 'INACTIVE') : (g === 3 ? 'CURRENT' : 'INACTIVE'),
        archived: g === 3 ? 'NO' : 'YES', members: 2, sizeMb: 512,
        memberList: [
            { status: sc === 'redo' && g === 1 && !demo.fixed.has('opened') ? 'INVALID' : null, type: 'ONLINE', path: `/u01/oracle/oradata/ORCL/redo0${g}.log` },
            { status: (sc === 'padrao' && g === 2 && !demo.fixed.has('redo02b')) || (sc === 'redo' && g === 1 && !demo.fixed.has('opened')) ? 'INVALID' : null, type: 'ONLINE', path: `/u02/oracle/oradata/ORCL/redo0${g}b.log` },
        ],
    }));

    const fraLimitMb = (50 + demo.fraAddGb) * 1024;
    let fraUsedMb = 44.6 * 1024;
    if (sc === 'fra') fraUsedMb = 50 * 1024;
    if (demo.fixed.has('fra-clean')) fraUsedMb *= 0.55;
    const fra = state === 'DOWN' ? null : { dest: '/u01/app/oracle/fast_recovery_area', limitMb: fraLimitMb, usedMb: Math.round(fraUsedMb), reclaimableMb: 512, files: 412, usedPct: Math.round(((fraUsedMb - 512) / fraLimitMb) * 1000) / 10 };

    const corruptionActive = sc === 'padrao' && !demo.fixed.has('corruption');
    const recent = (h) => isoLocal(now - h * H).slice(0, 19).replace('T', ' ');
    const byFile = {};
    for (const d of dfs) byFile[d.fileNo] = recent(26);

    // Depois de "Multiplexar o controlfile" (DEMO), a 2ª cópia fica em /u02.
    const cfList = ['/u01/oracle/oradata/ORCL/control01.ctl', ...(demo.fixed.has('cfmux') ? ['/u02/oracle/oradata/ORCL/control02.ctl'] : [])];
    const base = {
        at: new Date(now).toISOString(),
        source: state === 'OPEN' ? 'conexão do painel (DEMO)' : 'sqlplus SYSDBA no servidor (DEMO)',
        serverOs: 'linux',
        connection: state === 'OPEN' ? { ok: true, error: null } : { ok: false, error: state === 'DOWN'
            ? { code: 'ORA-01034', state: 'DOWN', message: 'ORA-01034: ORACLE not available' }
            : { code: 'ORA-01033', state: 'NOT_OPEN', message: 'ORA-01033: ORACLE initialization or shutdown in progress' } },
        state,
        instance: state === 'DOWN' ? null : { name: 'orcl', status: state === 'OPEN' ? 'OPEN' : 'MOUNTED', dbStatus: 'ACTIVE', version: '19.0.0.0.0', host: 'srv-oracle01', startup: recent(state === 'OPEN' ? 76 : 0.4), archiver: sc === 'fra' && !demo.fixed.has('fra') ? 'FAILED' : 'STARTED', logins: 'ALLOWED' },
        database: state === 'DOWN' ? null : { dbid: '1612345678', name: 'ORCL', logMode: 'ARCHIVELOG', openMode: state === 'OPEN' ? 'READ WRITE' : 'MOUNTED', role: 'PRIMARY', controlfileType: 'CURRENT', flashbackOn: demo.fixed.has('flashback') ? 'YES' : 'NO', forceLogging: 'NO', currentScn: '183933412', resetlogsTime: '2025-02-10 09:12:44' },
        edition: 'EE',
        banner: 'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production',
        params: { control_files: cfList.join(', '), undo_tablespace: 'UNDOTBS1', undo_management: 'AUTO', db_block_checksum: 'TYPICAL', db_name: 'ORCL', spfile: '/u01/app/oracle/product/19.0.0/dbhome_1/dbs/spfileorcl.ora', db_recovery_file_dest: '/u01/app/oracle/fast_recovery_area' },
        diag: { 'Diag Trace': TRACE },
        datafiles: dfs,
        recoverFiles,
        tempfiles: state === 'DOWN' ? [] : [{ fileNo: 1, status: 'ONLINE', ts: 'TEMP', sizeMb: 4096, name: '/u01/oracle/oradata/ORCL/temp01.dbf' }],
        logs,
        controlfiles: state === 'DOWN' ? [] : cfList.map((name) => ({ status: null, name })),
        controlFileParam: cfList,
        corruption: corruptionActive ? [{ fileNo: 11, block: 48213, blocks: 2, change: '0', type: 'CHECKSUM' }] : [],
        corruptSegments: corruptionActive ? [{ fileNo: 11, block: 48213, segment: { owner: 'VENDAS', name: 'IDX_PEDIDOS_CLIENTE', type: 'INDEX', partition: null } }] : [],
        archiveDests: sc === 'fra' && !demo.fixed.has('fra') ? [{ id: 1, status: 'ERROR', error: 'ORA-19809: limit exceeded for recovery files', destination: 'USE_DB_RECOVERY_FILE_DEST' }] : [],
        fra,
        backups: state === 'DOWN' ? {} : { byFile, lastDb: recent(26), newestAny: recent(26), allCovered: true, lastArch: recent(5), lastControlfile: recent(5), sets: 38 },
        rmanConfig: { 'CONTROLFILE AUTOBACKUP': 'ON', 'RETENTION POLICY': 'TO RECOVERY WINDOW OF 7 DAYS' },
        undoSegs: [{ ts: 'UNDOTBS1', status: 'ONLINE', count: 10 }],
        invalid: state === 'OPEN' ? (demo.fixed.has('invalid') || sc !== 'padrao' ? { total: 0, sys: 0, byOwner: [] } : { total: 3, sys: 0, byOwner: [{ owner: 'VENDAS', count: 3 }] }) : null,
        defaultTemp: 'TEMP',
        sectionErrors: {},
    };

    const records = alertLog.parseAlertText(alertText(now), { sinceEpoch: now - 7 * D });
    base.alert = {
        path: `${TRACE}/alert_orcl.log`, source: `arquivo ${TRACE}/alert_orcl.log (DEMO)`, error: null, days: 7,
        records: records.slice(-300), groups: alertLog.groupErrors(records), lifecycle: alertLog.lifecycle(records),
    };
    base.snapshot = { dbid: '1612345678', dbName: 'ORCL', instance: 'orcl', alertLog: base.alert.path, controlFiles: base.controlFileParam, at: new Date(now - D).toISOString() };
    base.capabilities = { automation: true, passwordAuth: true, remote: true, serverOs: 'linux', sysdbaUsed: state !== 'OPEN', canSysdba: true };
    base.demo = { scenario: demo.scenario, scenarios: SCENARIOS };
    return base;
}

/** Efeito simulado de um procedimento concluído. */
function apply(id, params = {}) {
    const now = Date.now();
    const ev = (...lines) => demo.extra.push({ ms: now, lines });
    switch (id) {
        case 'startup':
        case 'crash-recovery':
            demo.fixed.add('opened');
            if (id === 'crash-recovery') ev('ALTER DATABASE RECOVER  database', 'Media Recovery Complete (orcl)');
            ev('Completed: ALTER DATABASE OPEN');
            break;
        case 'incomplete-recovery':
        case 'open-resetlogs':
        case 'restore-database':
            demo.fixed.add('opened');
            ev('RESETLOGS after incomplete recovery UNTIL CHANGE 183920114', 'Completed: ALTER DATABASE OPEN RESETLOGS');
            ev('Completed: ALTER DATABASE OPEN');
            break;
        case 'datafile-recover':
        case 'datafile-restore':
            if (Number(params.fileNo) === 21) demo.fixed.add('df21');
            break;
        case 'block-recover':
        case 'index-rebuild':
            demo.fixed.add('corruption');
            break;
        case 'fra-free':
            if (params.mode === 'grow') demo.fraAddGb += Number(params.addGb) || 10;
            else demo.fixed.add('fra-clean');
            demo.fixed.add('fra');
            ev('Archiver process freed from errors. No longer stopped');
            break;
        case 'redo-member':
            demo.fixed.add('redo02b');
            break;
        case 'recompile-invalid':
            demo.fixed.add('invalid');
            break;
        case 'controlfile-multiplex':
            demo.fixed.add('cfmux');
            ev('Completed: ALTER DATABASE MOUNT', 'Completed: ALTER DATABASE OPEN');
            break;
        case 'flashback-on':
            demo.fixed.add('flashback');
            ev('Flashback Database Enabled at SCN 183933500', 'Completed: ALTER DATABASE FLASHBACK ON');
            break;
        default:
            break;
    }
}

/** Saída simulada de um passo (texto parecido com o do sqlplus/RMAN). */
function stepOutput(stepDef, script) {
    const text = (script || []).join('\n');
    if (stepDef.channel === 'rman') {
        const out = ['Recovery Manager: Release 19.0.0.0.0 - Production', '', 'connected to target database: ORCL (DBID=1612345678)', ''];
        if (/VALIDATE/.test(text)) out.push('Starting validate at ' + new Date().toLocaleString('pt-BR'), 'channel ORA_DISK_1: starting validation of datafile', 'List of Datafiles', '=================', 'File Status Marked Corrupt Empty Blocks Blocks Examined High SCN', '11   FAILED 0              2401         262144          183920110', 'Finished validate');
        if (/PREVIEW/.test(text)) out.push('List of Backup Sets', '===================', 'Key     TY LV S Device Type Completion Time', '412     B  F  A DISK        ' + new Date(Date.now() - 26 * H).toLocaleString('pt-BR'), 'Media recovery start SCN is 183812201', 'Recovery must be done beyond SCN 183812201 to clear datafile fuzziness');
        if (/RECOVER CORRUPTION LIST/.test(text)) out.push('Starting recover at ...', 'channel ORA_DISK_1: restoring block(s) from datafile copy', 'starting media recovery', 'media recovery complete, elapsed time: 00:00:03', 'Finished recover');
        if (/RESTORE (DATAFILE|DATABASE)(?! PREVIEW)(?!.*VALIDATE)/.test(text)) out.push('Starting restore at ...', 'channel ORA_DISK_1: restoring datafile(s)', 'channel ORA_DISK_1: restore complete, elapsed time: 00:01:12', 'Finished restore');
        if (/RECOVER (DATABASE|DATAFILE)/.test(text)) out.push('Starting recover at ...', 'starting media recovery', 'archived log for thread 1 with sequence 18449 is already on disk', 'media recovery complete, elapsed time: 00:00:41', 'Finished recover');
        if (/DELETE/.test(text)) out.push('released channel: ORA_DISK_1', 'deleted archived log', 'Deleted 37 objects');
        if (/BACKUP/.test(text) && !/VALIDATE/.test(text)) out.push('Starting backup at ...', 'channel ORA_DISK_1: starting compressed full datafile backup set', 'Finished backup', 'Starting Control File and SPFILE Autobackup', 'Finished Control File and SPFILE Autobackup');
        if (/ALTER DATABASE OPEN/.test(text)) out.push('Statement processed');
        out.push('', 'Recovery Manager complete.');
        return out.join('\n');
    }
    if (stepDef.channel === 'lsnrctl') return 'Starting /u01/app/oracle/product/19.0.0/dbhome_1/bin/tnslsnr: please wait...\nThe command completed successfully';
    if (stepDef.channel === 'os') return 'Servico OracleServiceORCL iniciado.';
    if (stepDef.channel === 'mkdir') return `Pasta pronta: ${stepDef.dir}`;
    const lines = (stepDef.statements ? stepDef.statements.map((s) => s.sql) : script || []);
    const out = [];
    for (const l of lines) {
        if (/^(SET |WHENEVER |PROMPT )/i.test(l) || !l.trim()) continue;
        if (/^STARTUP/i.test(l)) out.push('ORACLE instance started.', '', 'Total System Global Area 4932501504 bytes', 'Database mounted.', ...(/MOUNT|NOMOUNT/i.test(l) ? [] : ['Database opened.']));
        else if (/^RECOVER DATABASE UNTIL CANCEL/i.test(l)) out.push('ORA-00279: change 183920114 generated at ' + new Date().toLocaleString('pt-BR') + ' needed for thread 1', 'ORA-00289: suggestion : /u01/app/oracle/fast_recovery_area/ORCL/archivelog/o1_mf_1_18451_.arc', 'Specify log: {<RET>=suggested | filename | AUTO | CANCEL}');
        else if (/^(AUTO|CANCEL)$/i.test(l)) out.push(l.toUpperCase() === 'CANCEL' ? 'Media recovery cancelled.' : 'Log applied.');
        else if (/^SELECT/i.test(l)) out.push(/Invalidos/.test(l) ? 'Invalidos restantes: 0' : 'Estado: OPEN');
        else if (/^@\?/.test(l)) out.push('TIMESTAMP', 'COMP_TIMESTAMP UTLRP_BGN', 'PL/SQL procedure successfully completed.', 'COMP_TIMESTAMP UTLRP_END');
        else if (/^(BEGIN|DECLARE)/i.test(l)) out.push('PL/SQL procedure successfully completed.');
        else if (/^ALTER SYSTEM/i.test(l)) out.push('System altered.');
        else if (/^ALTER (INDEX|TABLE|TABLESPACE|USER)/i.test(l) || /^ANALYZE/i.test(l)) out.push(/^ALTER INDEX/i.test(l) ? 'Index altered.' : /^ANALYZE/i.test(l) ? 'Table analyzed.' : /^ALTER USER/i.test(l) ? 'User altered.' : 'Tablespace altered.');
        else if (/^(CREATE|DROP) /i.test(l)) out.push(/TABLESPACE/i.test(l) ? `Tablespace ${/^CREATE/i.test(l) ? 'created' : 'dropped'}.` : 'Done.');
        else out.push('Database altered.');
    }
    return out.join('\n');
}

module.exports = { SCENARIOS, setScenario, signals, apply, stepOutput, current: () => demo.scenario };

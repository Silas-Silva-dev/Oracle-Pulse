/**
 * MOCKDATA.JS - Dados simulados para o modo DEMO (DEMO_MODE=true).
 * Estrutura espelha exatamente o retorno das queries reais para que o
 * frontend funcione sem um banco Oracle conectado.
 */
/** Datafiles simulados (mesmo formato da query datafilesList). */
function demoDatafiles() {
    const U1 = '/u01/oracle/oradata/ORCL/';
    const U2 = '/u02/oracle/oradata/ORCL/';
    const U3 = '/u03/oracle/oradata/ORCL/';
    const rows = [];
    let id = 0;
    let change = 1000;
    const add = (ts, dir, name, size) => {
        id += 1;
        change += 5000;
        rows.push({ TABLESPACE_NAME: ts, FILE_NAME: dir + name, FILE_ID: id, SIZE_MB: size, AUTOEXTENSIBLE: 'YES', MAX_SIZE_MB: 32767, CREATION_CHANGE: change });
    };
    add('SYSTEM', U1, 'system01.dbf', 1024);
    add('SYSAUX', U1, 'sysaux01.dbf', 2048);
    add('UNDOTBS1', U1, 'undotbs01.dbf', 4096);
    add('USERS', U1, 'users01.dbf', 5000);
    for (let i = 1; i <= 15; i++) {
        if (i === 7) add('INDICES', U2, 'indices01.dbf', 32767);
        if (i === 13) add('INDICES', U2, 'indices02.dbf', 20480);
        add('DADOS', i <= 6 ? U1 : i <= 12 ? U2 : U3, `dados${String(i).padStart(2, '0')}.dbf`, 32767);
    }
    return rows.sort((a, b) => a.TABLESPACE_NAME.localeCompare(b.TABLESPACE_NAME) || a.FILE_ID - b.FILE_ID);
}

const demoClock = require('./demoClock');

module.exports = {
    // Getter: a hora do "servidor" anda (e reflete a sincronização NTP simulada).
    get instanceStatus() {
        return [{
            INSTANCE_NAME: 'ORCL_DEMO', HOST_NAME: 'localhost', VERSION: '19.3.0.0.0',
            STATUS: 'OPEN', STARTUP_TIME: '01/01/2026 08:00:00',
            CURRENT_TIME: demoClock.formatted(), UPTIME_MINUTES: 1440,
        }];
    },
    sessionSummary: [{ STATUS: 'ACTIVE', COUNT: 12 }, { STATUS: 'INACTIVE', COUNT: 45 }],
    // Inclui MAX_MB (faltava antes e quebrava a tela de Storage em DEMO)
    tablespaceUsage: [
        { TABLESPACE_NAME: 'DADOS', TOTAL_MB: 491505, FREE_MB: 11505, USED_MB: 480000, USED_PCT: 97.66, MAX_MB: 491505 },
        { TABLESPACE_NAME: 'SYSTEM', TOTAL_MB: 1024, FREE_MB: 154, USED_MB: 870, USED_PCT: 85, MAX_MB: 2048 },
        { TABLESPACE_NAME: 'INDICES', TOTAL_MB: 53247, FREE_MB: 9247, USED_MB: 44000, USED_PCT: 82.63, MAX_MB: 65534 },
        { TABLESPACE_NAME: 'SYSAUX', TOTAL_MB: 2048, FREE_MB: 610, USED_MB: 1438, USED_PCT: 70.21, MAX_MB: 32767 },
        { TABLESPACE_NAME: 'USERS', TOTAL_MB: 5000, FREE_MB: 3200, USED_MB: 1800, USED_PCT: 36, MAX_MB: 32768 },
    ],
    topSql: [
        { SQL_ID: '7w1m6z9y', CPU_SECONDS: 15.4, ELAPSED_SECONDS: 22.1, EXECUTIONS: 1200, SQL_SNIPPET: 'SELECT * FROM HR.EMPLOYEES WHERE dept_id = :1', PULSE_CPU_SECONDS: 0.9, TOTAL_CPU_SECONDS: 412.6 },
        { SQL_ID: '3a2b1c0d', CPU_SECONDS: 8.2, ELAPSED_SECONDS: 12.7, EXECUTIONS: 540, SQL_SNIPPET: 'UPDATE FINANCEIRO SET status = :1 WHERE id = :2', PULSE_CPU_SECONDS: 0.9, TOTAL_CPU_SECONDS: 412.6 },
    ],
    topSqlByElapsed: [
        { SQL_ID: '7w1m6z9y', ELAPSED_SECONDS: 22.1, CPU_SECONDS: 15.4, EXECUTIONS: 1200, BUFFER_GETS: 98000, SQL_SNIPPET: 'SELECT * FROM HR.EMPLOYEES WHERE dept_id = :1' },
    ],
    waitEvents: [
        { EVENT: 'db file sequential read', TOTAL_WAITS: 90000, TIME_WAITED_SECONDS: 4.5 },
        { EVENT: 'log file sync', TOTAL_WAITS: 12000, TIME_WAITED_SECONDS: 1.8 },
    ],
    memoryUsage: [{ TOTAL_CONFIG_MB: 4096, TOTAL_USED_MB: 2850, USED_PCT: 69.5, SGA_MB: 2048, PGA_MB: 802 }],
    sessionMemoryUsage: [
        { SID: 12, SERIAL: 3345, USERNAME: 'HR', PROGRAM: 'SQL Developer', SGA_MB: 12, PGA_MB: 45 },
        { SID: 33, SERIAL: 9981, USERNAME: 'APP', PROGRAM: 'app.exe', SGA_MB: 8, PGA_MB: 30 },
    ],
    sqlCommands: [{
        BLOCKED_SESSIONS: 0, SELECTS: 12, INSERTS: 4, UPDATES: 2, DELETES: 0,
        INSERT_WITH_SELECT: 1, UPDATE_WITH_SELECT: 0, DELETE_WITH_SELECT: 0,
        CTE: 2, MERGE: 0, OTHERS: 5,
    }],
    waitClasses: [
        { LABEL: 'User I/O', VALUE: 4200 }, { LABEL: 'System I/O', VALUE: 1800 },
        { LABEL: 'Commit', VALUE: 900 }, { LABEL: 'Concurrency', VALUE: 300 },
    ],
    systemMetrics: [
        { LABEL: 'Database Wait Time Ratio', VALUE: 23.5 },
        { LABEL: 'Database CPU Time Ratio', VALUE: 76.5 },
        { LABEL: 'Response Time Per Txn', VALUE: 1.2 },
    ],
    sessionDetails: [],
    longRunningSessions: [
        { SID: 88, SERIAL: 1122, USERNAME: 'APP', PROGRAM: 'app.exe', STATUS: 'ACTIVE', SQL_ID: '7w1m6z9y', SECONDS_RUNNING: 320, EVENT: 'db file sequential read' },
    ],
    // Banco que cresceu para outros discos: DADOS começou em /u01, passou por /u02
    // e o arquivo mais recente está em /u03 (destino atual de um novo datafile).
    datafilesList: demoDatafiles(),
    datafilesListBasic: demoDatafiles().map(({ CREATION_CHANGE, ...rest }) => rest),
    tempfilesList: [
        { TABLESPACE_NAME: 'TEMP', FILE_NAME: '/u01/oracle/oradata/ORCL/temp01.dbf', SIZE_MB: 8192 },
    ],
    asmDiskgroups: [],
    defaultDataPath: [{ PATH: '/u03/oracle/oradata/ORCL/' }],
    fullSqlText: [{ SQL_FULLTEXT: 'SELECT * FROM HR.EMPLOYEES WHERE dept_id = :1 ORDER BY hire_date' }],
    sqlPlan: [
        { PLAN_TABLE_OUTPUT: 'Plan hash value: 1234567890' },
        { PLAN_TABLE_OUTPUT: '-------------------------------------------------------' },
        { PLAN_TABLE_OUTPUT: '| Id | Operation         | Name      | Rows | Cost |' },
        { PLAN_TABLE_OUTPUT: '-------------------------------------------------------' },
        { PLAN_TABLE_OUTPUT: '|  0 | SELECT STATEMENT  |           |      |  42  |' },
        { PLAN_TABLE_OUTPUT: '|  1 |  TABLE ACCESS FULL| EMPLOYEES | 1200 |  42  |' },
        { PLAN_TABLE_OUTPUT: '-------------------------------------------------------' },
    ],
    archivelogMode: [{ NAME: 'ORCL', LOG_MODE: 'ARCHIVELOG', OPEN_MODE: 'READ WRITE', DATABASE_ROLE: 'PRIMARY' }],
    rmanBackups: [
        { SESSION_KEY: 101, INPUT_TYPE: 'DB FULL', STATUS: 'COMPLETED', START_TIME: '16/06/2026 02:00', END_TIME: '16/06/2026 02:38', ELAPSED_MINUTES: 38, OUTPUT_BYTES_DISPLAY: '12.40G' },
        { SESSION_KEY: 102, INPUT_TYPE: 'ARCHIVELOG', STATUS: 'COMPLETED', START_TIME: '16/06/2026 14:00', END_TIME: '16/06/2026 14:03', ELAPSED_MINUTES: 3, OUTPUT_BYTES_DISPLAY: '850M' },
    ],
    rmanOutputBySession: [
        { OUTPUT: 'Recovery Manager: Release 19.0.0.0.0' },
        { OUTPUT: 'connected to target database: ORCL (DBID=1735444553)' },
        { OUTPUT: 'Starting backup at 16/06/2026 02:00' },
        { OUTPUT: 'channel ORA_DISK_1: starting full datafile backup set' },
        { OUTPUT: 'channel ORA_DISK_1: backup set complete, elapsed time: 00:37:50' },
        { OUTPUT: 'Finished backup at 16/06/2026 02:38' },
        { OUTPUT: '[DEMO] Log simulado do v$rman_output.' },
    ],
    lastDbBackupEnd: [{ END_ISO: null }],
    // Getter: reflete as ações simuladas do guardião da FRA (src/demoFra.js).
    get fraUsage() { return require('./demoFra').rows(); },
    recoveryParams: [
        { NAME: 'db_recovery_file_dest', VALUE: '/u01/app/oracle/fast_recovery_area' },
        { NAME: 'db_recovery_file_dest_size', VALUE: '52428800000' },
    ],
    redoStats: [{ REDO_BYTES: 8000000000, UPTIME_SEC: 86400 }], // ~8 GB/dia
    dbSize: [{ DB_SIZE_GB: 45 }],
    rmanConfig: [
        { NAME: 'RETENTION POLICY', VALUE: 'TO RECOVERY WINDOW OF 7 DAYS' },
        { NAME: 'ARCHIVELOG DELETION POLICY', VALUE: 'TO NONE' },
        { NAME: 'BACKUP OPTIMIZATION', VALUE: 'ON' },
        { NAME: 'CONTROLFILE AUTOBACKUP', VALUE: 'ON' },
    ],

    // Memória / advisors (modo ASMM: sga_target + pga_aggregate_target definidos)
    memoryParams: [
        { NAME: 'memory_target', VALUE_MB: 0 },
        { NAME: 'memory_max_target', VALUE_MB: 0 },
        { NAME: 'sga_max_size', VALUE_MB: 2560 },
        { NAME: 'sga_target', VALUE_MB: 2560 },
        { NAME: 'pga_aggregate_target', VALUE_MB: 1235 },
        { NAME: 'pga_aggregate_limit', VALUE_MB: 2470 },
    ],
    pgaAdvice: [
        { TARGET_MB: 309, FACTOR: 0.25, CACHE_HIT_PCT: 72, OVERALLOC: 18 },
        { TARGET_MB: 617, FACTOR: 0.5, CACHE_HIT_PCT: 84, OVERALLOC: 6 },
        { TARGET_MB: 1235, FACTOR: 1.0, CACHE_HIT_PCT: 91, OVERALLOC: 2 },
        { TARGET_MB: 1853, FACTOR: 1.5, CACHE_HIT_PCT: 98, OVERALLOC: 0 },
        { TARGET_MB: 2470, FACTOR: 2.0, CACHE_HIT_PCT: 99, OVERALLOC: 0 },
        { TARGET_MB: 3705, FACTOR: 3.0, CACHE_HIT_PCT: 100, OVERALLOC: 0 },
    ],
    sgaAdvice: [
        { SIZE_MB: 1280, FACTOR: 0.5, ESTD_DB_TIME: 18400, DB_TIME_FACTOR: 1.42, PHYSICAL_READS: 9800000 },
        { SIZE_MB: 1920, FACTOR: 0.75, ESTD_DB_TIME: 14600, DB_TIME_FACTOR: 1.13, PHYSICAL_READS: 6400000 },
        { SIZE_MB: 2560, FACTOR: 1.0, ESTD_DB_TIME: 12950, DB_TIME_FACTOR: 1.0, PHYSICAL_READS: 5100000 },
        { SIZE_MB: 3200, FACTOR: 1.25, ESTD_DB_TIME: 12100, DB_TIME_FACTOR: 0.934, PHYSICAL_READS: 4200000 },
        { SIZE_MB: 3840, FACTOR: 1.5, ESTD_DB_TIME: 11850, DB_TIME_FACTOR: 0.915, PHYSICAL_READS: 3950000 },
        { SIZE_MB: 5120, FACTOR: 2.0, ESTD_DB_TIME: 11760, DB_TIME_FACTOR: 0.908, PHYSICAL_READS: 3880000 },
    ],
    memoryAdvice: [],
};

// Função (não é query): usada pelos cenários simulados da tela Recuperação.
Object.defineProperty(module.exports, 'demoDatafiles', { value: demoDatafiles, enumerable: false });

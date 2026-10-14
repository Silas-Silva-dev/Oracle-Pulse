/**
 * COLLECT.JS - Coleta dos sinais de saúde/recuperação do banco.
 *
 * Um ÚNICO conjunto de consultas (SECTIONS) roda por dois transportes:
 *  - conexão normal do painel (banco ABERTO): uma conexão avulsa, sem o pool,
 *    para refletir o estado real mesmo logo após quedas;
 *  - sqlplus como SYSDBA no servidor (banco MONTADO, NOMOUNT ou PARADO), via
 *    SSH (Linux) ou local (Windows), igual ao RMAN da tela de Backup.
 * Cada consulta devolve UMA coluna: 'R~' + campos separados por '|~|'. Assim
 * as duas saídas são lidas pelo mesmo parser.
 *
 * O alert log é lido do arquivo (tail) quando há acesso ao SO do servidor;
 * senão, por V$DIAG_ALERT_EXT.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { oracledb, tag } = require('../db');
const { detectServerOs, execOnServer, psEncoded } = require('../osDisk');
const backupAdmin = require('../backupAdmin');
const alertLog = require('./alertLog');
const logger = require('../logger');

const SEP = "||'|~|'||";
const ALERT_TAIL_BYTES = 1500000;

/** Estados em que cada seção funciona: N = NOMOUNT, M = MOUNT, O = OPEN. */
const SECTIONS = [
    { key: 'instance', when: 'NMO', sql: `SELECT 'R~'||instance_name${SEP}status${SEP}database_status${SEP}version${SEP}host_name${SEP}TO_CHAR(startup_time,'YYYY-MM-DD HH24:MI:SS')${SEP}archiver${SEP}logins AS l FROM v$instance` },
    { key: 'version', when: 'NMO', sql: `SELECT 'R~'||banner AS l FROM v$version WHERE banner LIKE 'Oracle%'` },
    { key: 'params', when: 'NMO', sql: `SELECT 'R~'||name${SEP}value AS l FROM v$parameter WHERE name IN ('control_files','db_recovery_file_dest','db_recovery_file_dest_size','undo_tablespace','undo_management','db_block_checksum','db_block_checking','db_lost_write_protect','db_name','db_unique_name','db_create_file_dest','log_archive_dest_1','spfile')` },
    { key: 'diag', when: 'NMO', sql: `SELECT 'R~'||name${SEP}value AS l FROM v$diag_info WHERE name IN ('Diag Trace','ADR Home')` },
    { key: 'database', when: 'MO', sql: `SELECT 'R~'||dbid${SEP}name${SEP}log_mode${SEP}open_mode${SEP}database_role${SEP}controlfile_type${SEP}flashback_on${SEP}force_logging${SEP}TO_CHAR(current_scn)${SEP}TO_CHAR(resetlogs_time,'YYYY-MM-DD HH24:MI:SS') AS l FROM v$database` },
    { key: 'datafiles', when: 'MO', sql: `SELECT 'R~'||d.file#${SEP}d.status${SEP}d.enabled${SEP}t.name${SEP}h.error${SEP}h.recover${SEP}h.fuzzy${SEP}ROUND(d.bytes/1048576)${SEP}d.name AS l FROM v$datafile d JOIN v$tablespace t ON t.ts# = d.ts# LEFT JOIN v$datafile_header h ON h.file# = d.file# ORDER BY d.file#` },
    { key: 'recover', when: 'MO', sql: `SELECT 'R~'||file#${SEP}online_status${SEP}error${SEP}TO_CHAR(change#)${SEP}TO_CHAR(time,'YYYY-MM-DD HH24:MI:SS') AS l FROM v$recover_file` },
    { key: 'tempfiles', when: 'MO', sql: `SELECT 'R~'||t.file#${SEP}t.status${SEP}ts.name${SEP}ROUND(t.bytes/1048576)${SEP}t.name AS l FROM v$tempfile t JOIN v$tablespace ts ON ts.ts# = t.ts# ORDER BY t.file#` },
    { key: 'logs', when: 'MO', sql: `SELECT 'R~'||l.group#${SEP}l.thread#${SEP}l.sequence#${SEP}l.status${SEP}l.archived${SEP}l.members${SEP}ROUND(l.bytes/1048576)${SEP}f.status${SEP}f.type${SEP}f.member AS l FROM v$log l JOIN v$logfile f ON f.group# = l.group# ORDER BY l.group#, f.member` },
    { key: 'controlfiles', when: 'MO', sql: `SELECT 'R~'||status${SEP}name AS l FROM v$controlfile` },
    { key: 'corruption', when: 'MO', sql: `SELECT 'R~'||file#${SEP}block#${SEP}blocks${SEP}TO_CHAR(corruption_change#)${SEP}corruption_type AS l FROM v$database_block_corruption ORDER BY file#, block#` },
    { key: 'archdest', when: 'MO', sql: `SELECT 'R~'||dest_id${SEP}status${SEP}error${SEP}destination AS l FROM v$archive_dest WHERE status <> 'INACTIVE'` },
    { key: 'fra', when: 'MO', sql: `SELECT 'R~'||name${SEP}ROUND(space_limit/1048576)${SEP}ROUND(space_used/1048576)${SEP}ROUND(space_reclaimable/1048576)${SEP}number_of_files AS l FROM v$recovery_file_dest` },
    { key: 'backupfiles', when: 'MO', sql: `SELECT 'R~'||file#${SEP}TO_CHAR(MAX(completion_time),'YYYY-MM-DD HH24:MI:SS') AS l FROM (SELECT bd.file#, bd.completion_time FROM v$backup_datafile bd WHERE bd.file# > 0 AND EXISTS (SELECT 1 FROM v$backup_piece bp WHERE bp.set_stamp = bd.set_stamp AND bp.set_count = bd.set_count AND bp.status = 'A') UNION ALL SELECT file#, completion_time FROM v$datafile_copy WHERE status = 'A' AND file# > 0) GROUP BY file#` },
    { key: 'backupsets', when: 'MO', sql: `SELECT 'R~'||TO_CHAR(MAX(CASE WHEN bs.backup_type = 'L' THEN bs.completion_time END),'YYYY-MM-DD HH24:MI:SS')${SEP}TO_CHAR(MAX(CASE WHEN bs.controlfile_included = 'YES' THEN bs.completion_time END),'YYYY-MM-DD HH24:MI:SS')${SEP}COUNT(*) AS l FROM v$backup_set bs WHERE EXISTS (SELECT 1 FROM v$backup_piece bp WHERE bp.set_stamp = bs.set_stamp AND bp.set_count = bs.set_count AND bp.status = 'A')` },
    { key: 'rmanconf', when: 'MO', sql: `SELECT 'R~'||name${SEP}value AS l FROM v$rman_configuration` },
    { key: 'undosegs', when: 'O', sql: `SELECT 'R~'||tablespace_name${SEP}status${SEP}COUNT(*) AS l FROM dba_rollback_segs GROUP BY tablespace_name, status` },
    { key: 'invalid', when: 'O', sql: `SELECT 'R~'||owner${SEP}COUNT(*) AS l FROM dba_objects WHERE status = 'INVALID' GROUP BY owner ORDER BY COUNT(*) DESC` },
    { key: 'defaulttemp', when: 'O', sql: `SELECT 'R~'||property_value AS l FROM database_properties WHERE property_name = 'DEFAULT_TEMP_TABLESPACE'` },
];

// ==========================================================================
// Transporte 1: sqlplus como SYSDBA no servidor
// ==========================================================================

/** Script sqlplus (sem a linha CONNECT, que vem do backupAdmin) com marcadores por seção. */
function buildSysdbaScript(sections = SECTIONS) {
    const lines = [
        'SET PAGESIZE 0', 'SET LINESIZE 32767', 'SET TRIMSPOOL ON', 'SET TRIMOUT ON', 'SET HEADING OFF',
        'SET FEEDBACK OFF', 'SET VERIFY OFF', 'SET ECHO OFF', 'SET TAB OFF', 'SET SQLBLANKLINES ON',
        'WHENEVER SQLERROR CONTINUE',
    ];
    for (const s of sections) {
        lines.push(`PROMPT @@OP:S:${s.key}`, `${s.sql};`);
    }
    lines.push('PROMPT @@OP:END');
    return lines;
}

/** Lê a saída do sqlplus em { secao: { rows: [[campos]], errors: [] } }. */
function parseSectionOutput(text) {
    const sections = { _connect: { rows: [], errors: [] } };
    let cur = '_connect';
    let idle = false;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        const marker = /^@@OP:S:(\w+)$/.exec(line.trim());
        if (marker) {
            cur = marker[1];
            sections[cur] = { rows: [], errors: [] };
            continue;
        }
        if (line.trim() === '@@OP:END') { cur = '_end'; sections[cur] = { rows: [], errors: [] }; continue; }
        if (line.startsWith('R~')) {
            sections[cur].rows.push(line.slice(2).split('|~|'));
            continue;
        }
        if (/Connected to an idle instance/i.test(line)) idle = true;
        const e = /\b(ORA|SP2|TNS)-(\d{4,5})\b:?\s*(.*)$/.exec(line);
        if (e) sections[cur].errors.push(`${e[1]}-${e[2]}: ${e[3]}`.trim());
    }
    sections._idle = idle;
    return sections;
}

/** Executa um script sqlplus SYSDBA no servidor e devolve a saída higienizada. */
async function runSysdba(lines, opts = {}) {
    const serverOs = opts.serverOs || await detectServerOs();
    const { args, connectLine } = backupAdmin.sqlplusInvocation(serverOs);
    const { command, env } = backupAdmin.buildServerCommand('sqlplus', args, serverOs);
    const script = [];
    if (connectLine) script.push(connectLine);
    script.push(...lines, 'EXIT');
    const r = await execOnServer(command, { stdin: script.join('\n') + '\n', env, onOutput: opts.onOutput, timeoutMs: opts.timeoutMs });
    const output = backupAdmin.scrubSecrets(`${r.stdout}\n${r.stderr}`);
    return { code: r.code, output, serverOs };
}

// ==========================================================================
// Transporte 2: conexão do painel (banco aberto)
// ==========================================================================

async function openDirectConnection() {
    const opts = {
        user: config.db.isSys ? 'SYS' : config.db.user,
        password: config.db.password,
        connectString: config.db.connectString,
        connectTimeout: 15,
    };
    if (config.db.isSys) opts.privilege = oracledb.SYSDBA;
    return oracledb.getConnection(opts);
}

async function runSectionsViaConnection(conn, sections) {
    const out = {};
    for (const s of sections) {
        try {
            conn.callTimeout = 20000;
            const r = await conn.execute(tag(s.sql));
            out[s.key] = { rows: (r.rows || []).map((row) => String(row.L || row.l || '').replace(/^R~/, '').split('|~|')), errors: [] };
        } catch (err) {
            out[s.key] = { rows: [], errors: [String(err.message || err).split('\n')[0]] };
        }
    }
    return out;
}

/** Segmentos afetados por blocos corrompidos (DBA_EXTENTS) — só com o banco aberto. */
async function mapCorruptSegments(conn, blocks) {
    const result = [];
    for (const b of blocks.slice(0, 15)) {
        try {
            conn.callTimeout = 20000;
            const r = await conn.execute(
                `SELECT owner, segment_name, segment_type, partition_name FROM dba_extents
                  WHERE file_id = :f AND :b BETWEEN block_id AND block_id + blocks - 1 AND ROWNUM = 1`,
                { f: b.fileNo, b: b.block });
            const row = r.rows && r.rows[0];
            result.push({
                fileNo: b.fileNo, block: b.block,
                segment: row ? { owner: row.OWNER, name: row.SEGMENT_NAME, type: row.SEGMENT_TYPE, partition: row.PARTITION_NAME || null } : null,
            });
        } catch (err) {
            result.push({ fileNo: b.fileNo, block: b.block, segment: null, error: err.message });
        }
    }
    return result;
}

/** Dados de um índice para o REBUILD (tipo, tabela, partições). null se não existe. */
async function indexInfo(owner, name) {
    if (config.demoMode) {
        return { indexType: 'NORMAL', tableOwner: owner, tableName: name.replace(/^IDX_|_IDX$/g, '').split('_')[0] || 'TABELA', partitions: [] };
    }
    const conn = await openDirectConnection();
    try {
        const r = await conn.execute(
            `SELECT table_owner, table_name, index_type, partitioned FROM dba_indexes WHERE owner = :o AND index_name = :n`,
            { o: owner, n: name });
        const row = r.rows && r.rows[0];
        if (!row) return null;
        let partitions = [];
        if (row.PARTITIONED === 'YES') {
            const p = await conn.execute(
                `SELECT partition_name FROM dba_ind_partitions WHERE index_owner = :o AND index_name = :n ORDER BY partition_position`,
                { o: owner, n: name });
            partitions = (p.rows || []).map((x) => x.PARTITION_NAME);
        }
        return { indexType: row.INDEX_TYPE, tableOwner: row.TABLE_OWNER, tableName: row.TABLE_NAME, partitions };
    } finally {
        try { await conn.close(); } catch { /* ignore */ }
    }
}

// ==========================================================================
// Conversão seções → sinais
// ==========================================================================

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const nz = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
const joinRest = (row, from) => row.slice(from).join('|~|');

function buildSignals(sec, meta = {}) {
    const rows = (k) => (sec[k] && sec[k].rows) || [];
    const sectionErrors = {};
    for (const [k, v] of Object.entries(sec)) {
        if (k.startsWith('_') || !v || !v.errors || !v.errors.length) continue;
        sectionErrors[k] = v.errors[0];
    }

    const inst = rows('instance')[0];
    const instance = inst ? {
        name: nz(inst[0]), status: nz(inst[1]), dbStatus: nz(inst[2]), version: nz(inst[3]),
        host: nz(inst[4]), startup: nz(inst[5]), archiver: nz(inst[6]), logins: nz(inst[7]),
    } : null;

    let state = 'UNKNOWN';
    if (instance) {
        const st = (instance.status || '').toUpperCase();
        state = st.startsWith('OPEN') ? 'OPEN' : st === 'MOUNTED' ? 'MOUNTED' : st === 'STARTED' ? 'STARTED' : 'UNKNOWN';
    } else if (sec._idle || /ORA-0*1034|ORA-27101/.test(JSON.stringify(sec.instance || sec._connect || {}))) {
        state = 'DOWN';
    }

    const dbr = rows('database')[0];
    const database = dbr ? {
        dbid: nz(dbr[0]), name: nz(dbr[1]), logMode: nz(dbr[2]), openMode: nz(dbr[3]), role: nz(dbr[4]),
        controlfileType: nz(dbr[5]), flashbackOn: nz(dbr[6]), forceLogging: nz(dbr[7]), currentScn: nz(dbr[8]), resetlogsTime: nz(dbr[9]),
    } : null;

    const banner = (rows('version')[0] || [])[0] || '';
    const edition = /Enterprise/i.test(banner) ? 'EE' : banner ? (/Express/i.test(banner) ? 'XE' : 'SE') : null;

    const params = {};
    for (const r of rows('params')) params[r[0]] = nz(joinRest(r, 1));
    const diag = {};
    for (const r of rows('diag')) diag[r[0]] = nz(joinRest(r, 1));

    const datafiles = rows('datafiles').map((r) => ({
        fileNo: num(r[0]), status: nz(r[1]), enabled: nz(r[2]), ts: nz(r[3]), hdrError: nz(r[4]),
        recover: nz(r[5]), fuzzy: nz(r[6]), sizeMb: num(r[7]), name: nz(joinRest(r, 8)),
    }));
    const recoverFiles = rows('recover').map((r) => {
        const fileNo = num(r[0]);
        const df = datafiles.find((d) => d.fileNo === fileNo);
        return { fileNo, onlineStatus: nz(r[1]), error: nz(r[2]), change: nz(r[3]), time: nz(r[4]), name: df ? df.name : null, ts: df ? df.ts : null };
    });
    const tempfiles = rows('tempfiles').map((r) => ({ fileNo: num(r[0]), status: nz(r[1]), ts: nz(r[2]), sizeMb: num(r[3]), name: nz(joinRest(r, 4)) }));

    const logMap = new Map();
    for (const r of rows('logs')) {
        const group = num(r[0]);
        if (!logMap.has(group)) {
            logMap.set(group, { group, thread: num(r[1]), sequence: num(r[2]), status: nz(r[3]), archived: nz(r[4]), members: num(r[5]), sizeMb: num(r[6]), memberList: [] });
        }
        logMap.get(group).memberList.push({ status: nz(r[7]), type: nz(r[8]), path: nz(joinRest(r, 9)) });
    }
    const logs = [...logMap.values()];

    const controlfiles = rows('controlfiles').map((r) => ({ status: nz(r[0]), name: nz(joinRest(r, 1)) }));
    const corruption = rows('corruption').map((r) => ({ fileNo: num(r[0]), block: num(r[1]), blocks: num(r[2]), change: nz(r[3]), type: nz(r[4]) }));
    const archiveDests = rows('archdest').map((r) => ({ id: num(r[0]), status: nz(r[1]), error: nz(r[2]), destination: nz(joinRest(r, 3)) }));
    const fr = rows('fra')[0];
    const fra = fr && nz(fr[0]) ? (() => {
        const limitMb = num(fr[1]) || 0;
        const usedMb = num(fr[2]) || 0;
        const reclaimMb = num(fr[3]) || 0;
        return { dest: nz(fr[0]), limitMb, usedMb, reclaimableMb: reclaimMb, files: num(fr[4]), usedPct: limitMb ? Math.round(((usedMb - reclaimMb) / limitMb) * 1000) / 10 : null };
    })() : null;

    const byFile = {};
    for (const r of rows('backupfiles')) byFile[num(r[0])] = nz(r[1]);
    const bs = rows('backupsets')[0] || [];
    const covered = datafiles.length > 0 && datafiles.every((d) => byFile[d.fileNo]);
    const lastDb = covered ? datafiles.map((d) => byFile[d.fileNo]).sort()[0] : null;
    const newestAny = Object.values(byFile).sort().pop() || null;
    const backups = { byFile, lastDb, newestAny, allCovered: covered, lastArch: nz(bs[0]), lastControlfile: nz(bs[1]), sets: num(bs[2]) || 0 };

    const rmanConfig = {};
    for (const r of rows('rmanconf')) rmanConfig[r[0]] = nz(joinRest(r, 1));
    const undoSegs = rows('undosegs').map((r) => ({ ts: nz(r[0]), status: nz(r[1]), count: num(r[2]) }));
    const invalidRows = rows('invalid').map((r) => ({ owner: nz(r[0]), count: num(r[1]) }));
    // Seção que falhou (ex.: ORA-01219 com o banco só montado) = "sem dados", nunca "zero".
    const invalid = sec.invalid && !(sec.invalid.errors || []).length ? {
        total: invalidRows.reduce((a, r) => a + (r.count || 0), 0),
        sys: invalidRows.filter((r) => ['SYS', 'SYSTEM'].includes(r.owner)).reduce((a, r) => a + (r.count || 0), 0),
        byOwner: invalidRows.slice(0, 8),
    } : null;

    const controlFileParam = params.control_files ? params.control_files.split(/\s*,\s*/).map((s) => s.replace(/^"|"$/g, '')).filter(Boolean) : [];

    return {
        at: new Date().toISOString(),
        source: meta.source || 'unknown',
        serverOs: meta.serverOs || null,
        connection: meta.connection || { ok: true, error: null },
        state, instance, database, edition, banner: banner || null,
        params, diag, datafiles, recoverFiles, tempfiles, logs, controlfiles, controlFileParam,
        corruption, corruptSegments: [], archiveDests, fra, backups, rmanConfig, undoSegs, invalid,
        defaultTemp: nz((rows('defaulttemp')[0] || [])[0]),
        sectionErrors,
    };
}

// ==========================================================================
// Erro de conexão → estado provável
// ==========================================================================

const CONNECT_ERROR_MAP = [
    { re: /ORA-0*1034|ORA-27101/, code: 'ORA-01034', state: 'DOWN' },
    { re: /ORA-0*1033/, code: 'ORA-01033', state: 'NOT_OPEN' },
    { re: /ORA-12528|NJS-521/, code: 'ORA-12528', state: 'NOT_OPEN' },
    { re: /ORA-12514|NJS-518/, code: 'ORA-12514', state: 'DOWN?' },
    { re: /ORA-12505|NJS-519/, code: 'ORA-12505', state: 'DOWN?' },
    { re: /ORA-12541|NJS-503|ECONNREFUSED/, code: 'ORA-12541', state: 'UNREACHABLE' },
    { re: /ORA-12170|NJS-510|NJS-511|ETIMEDOUT|EHOSTUNREACH/, code: 'ORA-12170', state: 'UNREACHABLE' },
    { re: /ORA-0*0257/, code: 'ORA-00257', state: 'OPEN' },
    { re: /ORA-0*1017/, code: 'ORA-01017', state: 'OPEN?' },
    { re: /ORA-28000/, code: 'ORA-28000', state: 'OPEN?' },
    { re: /ORA-28001/, code: 'ORA-28001', state: 'OPEN?' },
    { re: /ORA-0*0020|ORA-0*0018/, code: 'ORA-00020', state: 'OPEN' },
    { re: /ORA-12560/, code: 'ORA-12560', state: 'DOWN?' },
];

function classifyConnectError(err) {
    const msg = String((err && err.message) || err || '');
    const hit = CONNECT_ERROR_MAP.find((m) => m.re.test(msg));
    return { code: hit ? hit.code : null, state: hit ? hit.state : 'UNKNOWN', message: msg.split('\n')[0].slice(0, 400) };
}

// ==========================================================================
// Alert log
// ==========================================================================

const SNAPSHOT_FILE = () => path.join(config.paths.logs, 'recovery-snapshot.json');

function readSnapshot() {
    try { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE(), 'utf8')); } catch { return null; }
}

/** Guarda o que é útil numa emergência (DBID, controlfiles, alert log) enquanto o banco está saudável. */
function writeSnapshot(signals, alertPath) {
    if (!signals.database || !signals.database.dbid) return;
    const snap = {
        dbid: signals.database.dbid,
        dbName: signals.database.name,
        instance: signals.instance ? signals.instance.name : null,
        diagTrace: signals.diag['Diag Trace'] || null,
        alertLog: alertPath || null,
        controlFiles: signals.controlFileParam,
        at: new Date().toISOString(),
    };
    const prev = readSnapshot();
    if (prev && prev.dbid === snap.dbid && prev.alertLog === snap.alertLog && JSON.stringify(prev.controlFiles) === JSON.stringify(snap.controlFiles)) return;
    try {
        fs.mkdirSync(config.paths.logs, { recursive: true });
        fs.writeFileSync(SNAPSHOT_FILE(), JSON.stringify(snap, null, 2));
    } catch (err) {
        logger.warn('Não foi possível gravar o snapshot de recuperação:', err.message);
    }
}

function alertPathFor(signals, serverOs) {
    if (process.env.DB_ALERT_LOG) return process.env.DB_ALERT_LOG;
    const trace = signals.diag && signals.diag['Diag Trace'];
    const inst = (signals.instance && signals.instance.name) || config.oracleServer.sid;
    if (trace && inst) return `${trace.replace(/[\\/]+$/, '')}${serverOs === 'windows' ? '\\' : '/'}alert_${inst}.log`;
    const snap = readSnapshot();
    return snap && snap.alertLog ? snap.alertLog : null;
}

/** Lê o final do alert log do servidor (local: fs; SSH Linux: tail; SSH Windows: Get-Content). */
async function readAlertTail(filePath, serverOs) {
    if (!filePath || /['\r\n`$]/.test(filePath)) throw new Error('caminho do alert log desconhecido ou inválido');
    if (!config.ssh.host) {
        const fd = fs.openSync(filePath, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            const len = Math.min(size, ALERT_TAIL_BYTES);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, size - len);
            return buf.toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    }
    const r = serverOs === 'windows'
        ? await execOnServer(psEncoded(`$ProgressPreference='SilentlyContinue'; Get-Content -LiteralPath '${filePath}' -Tail 15000`))
        : await execOnServer(`tail -c ${ALERT_TAIL_BYTES} '${filePath}'`);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'falha ao ler').trim().split('\n')[0].slice(0, 300));
    return r.stdout;
}

async function readAlertViaView(conn, days) {
    conn.callTimeout = 25000;
    const r = await conn.execute(
        `SELECT TO_CHAR(originating_timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS ts, message_text AS text
           FROM v$diag_alert_ext
          WHERE originating_timestamp > SYSTIMESTAMP - NUMTODSINTERVAL(:d, 'DAY')
            AND (message_text LIKE '%ORA-%' OR message_text LIKE 'Starting ORACLE instance%'
                 OR message_text LIKE 'Completed: ALTER DATABASE OPEN%' OR message_text LIKE '%terminating the instance%'
                 OR message_text LIKE 'Instance terminated%' OR message_text LIKE 'Shutting down instance%'
                 OR message_text LIKE '%crash recovery%' OR message_text LIKE 'Corrupt block%'
                 OR UPPER(message_text) LIKE 'COMPLETED: ALTER DATABASE ADD LOGFILE MEMBER%')
            AND ROWNUM <= 3000`,
        { d: days }, { fetchArraySize: 500 });
    return (r.rows || []).map((row) => ({ ts: row.TS, text: row.TEXT }));
}

// ==========================================================================
// Coleta completa
// ==========================================================================

/**
 * @param {object} opts { allowSysdba: bool (só DBA), days: number }
 * @returns {Promise<object>} signals (+ alert)
 */
async function collect(opts = {}) {
    const days = Math.min(Math.max(parseInt(opts.days, 10) || 7, 1), 30);
    const sinceEpoch = Date.now() - days * 86400000;
    // Em paralelo: com o host fora do ar, os dois esperam o timeout de rede.
    const [osRes, connRes] = await Promise.allSettled([detectServerOs(), openDirectConnection()]);
    const serverOs = osRes.status === 'fulfilled' ? osRes.value : null;

    let signals = null;
    const conn = connRes.status === 'fulfilled' ? connRes.value : null;
    const connectError = conn ? null : classifyConnectError(connRes.reason);

    const automation = config.oracleServer.rmanAutomationReady;
    try {
        if (conn) {
            const sec = await runSectionsViaConnection(conn, SECTIONS);
            signals = buildSignals(sec, { source: 'conexão do painel', serverOs });
            if (signals.corruption.length) signals.corruptSegments = await mapCorruptSegments(conn, signals.corruption);
        } else if (opts.allowSysdba && automation) {
            const r = await runSysdba(buildSysdbaScript(), { serverOs, timeoutMs: 120000 });
            const sec = parseSectionOutput(r.output);
            signals = buildSignals(sec, { source: 'sqlplus SYSDBA no servidor', serverOs });
            const connErrors = (sec._connect.errors || []).concat(sec.instance ? sec.instance.errors : []);
            if (signals.state === 'UNKNOWN' && connErrors.length) signals.sysdbaError = connErrors.slice(0, 3).join(' · ');
            if (r.code !== 0 && !sec.instance) signals.sysdbaError = signals.sysdbaError || r.output.trim().split('\n').slice(-3).join(' ').slice(0, 400);
        } else {
            signals = buildSignals({}, { source: 'conexão do painel (falhou)', serverOs });
        }
        signals.connection = connectError ? { ok: false, error: connectError } : { ok: true, error: null };
        if (connectError && signals.state === 'UNKNOWN') {
            if (connectError.state === 'DOWN') signals.state = 'DOWN';
            signals.probableState = connectError.state;
        }

        // ---- alert log
        const alertPath = alertPathFor(signals, serverOs);
        let records = null;
        let alertSource = null;
        let alertError = null;
        if (alertPath) {
            try {
                const text = await readAlertTail(alertPath, serverOs);
                records = alertLog.parseAlertText(text, { sinceEpoch });
                alertSource = `arquivo ${alertPath}`;
            } catch (err) {
                alertError = `alert log (${alertPath}): ${err.message}`;
            }
        }
        if (!records && conn) {
            try {
                records = alertLog.parseAlertRows(await readAlertViaView(conn, days), { sinceEpoch });
                alertSource = 'V$DIAG_ALERT_EXT';
                alertError = null;
            } catch (err) {
                alertError = (alertError ? alertError + ' · ' : '') + `V$DIAG_ALERT_EXT: ${err.message.split('\n')[0]}`;
            }
        }
        records = records || [];

        // Blocos citados no alert log que ainda não estão em V$DATABASE_BLOCK_CORRUPTION
        const alertBlocks = [];
        for (const r of records) for (const b of r.blocks) {
            if (!signals.corruption.some((c) => c.fileNo === b.fileNo && b.block >= c.block && b.block < c.block + (c.blocks || 1))
                && !alertBlocks.some((x) => x.fileNo === b.fileNo && x.block === b.block)) alertBlocks.push(b);
        }
        if (conn && alertBlocks.length) {
            const mapped = await mapCorruptSegments(conn, alertBlocks);
            signals.corruptSegments.push(...mapped.map((m) => ({ ...m, fromAlert: true })));
        }

        signals.alert = {
            path: alertPath, source: alertSource, error: alertError, days,
            records: records.slice(-300),
            groups: alertLog.groupErrors(records),
            lifecycle: alertLog.lifecycle(records),
        };
        if (signals.database) writeSnapshot(signals, alertPath);
        signals.snapshot = readSnapshot();
        signals.capabilities = {
            automation,
            passwordAuth: config.oracleServer.usesPasswordAuth,
            remote: !!config.ssh.host,
            serverOs,
            sysdbaUsed: signals.source.startsWith('sqlplus'),
            canSysdba: !!opts.allowSysdba && automation,
        };
        return signals;
    } finally {
        if (conn) { try { await conn.close(); } catch { /* ignore */ } }
    }
}

/** Estado da instância agora (para o executor): OPEN|MOUNTED|STARTED|DOWN|UNKNOWN. */
async function probeState() {
    if (config.oracleServer.rmanAutomationReady) {
        const r = await runSysdba(buildSysdbaScript(SECTIONS.filter((s) => s.key === 'instance')), { timeoutMs: 60000 });
        const sig = buildSignals(parseSectionOutput(r.output), {});
        if (sig.state !== 'UNKNOWN') return sig.state;
    }
    let conn = null;
    try {
        conn = await openDirectConnection();
        const r = await conn.execute(`SELECT status AS s FROM v$instance`);
        const st = String((r.rows[0] || {}).S || '').toUpperCase();
        return st.startsWith('OPEN') ? 'OPEN' : st === 'MOUNTED' ? 'MOUNTED' : 'UNKNOWN';
    } catch (err) {
        const c = classifyConnectError(err);
        return c.state === 'DOWN' ? 'DOWN' : 'UNKNOWN';
    } finally {
        if (conn) { try { await conn.close(); } catch { /* ignore */ } }
    }
}

module.exports = {
    SECTIONS,
    collect,
    probeState,
    runSysdba,
    openDirectConnection,
    indexInfo,
    readSnapshot,
    // puros (testes)
    buildSysdbaScript,
    parseSectionOutput,
    buildSignals,
    classifyConnectError,
    alertPathFor,
};

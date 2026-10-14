/**
 * FRAGUARD.JS - Guardião da FRA: impede que o banco pare por falta de espaço
 * na Fast Recovery Area, mesmo com o tamanho subdimensionado.
 *
 * A cada minuto mede o uso EFETIVO da FRA (usado − reciclável), o ritmo de
 * crescimento (previsão de quando enche) e o espaço do disco. Conforme o nível,
 * executa UMA ação por vez, na ordem mais segura:
 *
 *   atenção (≥ alvo ou enche em < 3 h)   backup dos archives sem backup + limpeza
 *   alerta  (≥ aumentar ou enche em < 30 min)
 *                                         aumenta o limite da FRA (se o disco tiver
 *                                         espaço além da reserva) → backup → despejo
 *   emergência (≥ emergência ou archiver travado)
 *                                         aumenta → despeja os archives num diretório
 *                                         de OUTRO disco (backup compactado, mantém a
 *                                         recuperação) → backup → ÚLTIMO RECURSO:
 *                                         apaga archives antigos sem backup (o banco
 *                                         continua no ar, mas a recuperação fica
 *                                         comprometida até o próximo backup completo)
 *
 * Tudo é auditado, vira histórico e notificação. A decisão (decide) é pura.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const db = require('./db');
const backupAdmin = require('./backupAdmin');
const backupSchedule = require('./backupSchedule');
const storage = require('./storage');
const alerts = require('./alerts');
const audit = require('./audit');
const logger = require('./logger');
const demoFra = require('./demoFra');

const TICK_MS = 60000;
const TICK_BUSY_MS = 15000;       // com um backup RMAN em andamento a FRA enche em minutos
const SCHEDULE_CHECK_MS = 10 * 60000;
const HISTORY_MAX = 200;
const HISTORY_FILE = () => path.join(config.paths.logs, config.demoMode ? 'fra-guard-history.demo.json' : 'fra-guard-history.json');

const ACTION_LABEL = {
    'backup-archivelog': 'Backup dos archivelogs sem backup',
    cleanup: 'Limpeza (obsoletos, expirados e archives já copiados)',
    grow: 'Aumento do limite da FRA',
    dump: 'Archives despejados no diretório de emergência',
    'force-delete': 'ÚLTIMO RECURSO: archives antigos apagados sem backup',
};

// Intervalo mínimo entre repetições da mesma ação e "quarentena" após falha (min).
const COOLDOWN = { 'backup-archivelog': 15, cleanup: 60, grow: 3, dump: 10, 'force-delete': 10 };
const COOLDOWN_EMERGENCY = { 'backup-archivelog': 5, cleanup: 15, grow: 2, dump: 5, 'force-delete': 5 };
const FAIL_QUARANTINE = { 'backup-archivelog': 30, cleanup: 60, grow: 10, dump: 20, 'force-delete': 15 };

// ==========================================================================
// Decisão (pura)
// ==========================================================================

/**
 * Quanto aumentar o limite. O disco precisa continuar com a reserva livre:
 * o novo limite não pode passar de (usado efetivo + livre no disco − reserva).
 * @returns {{addGb:number,newGb:number}|{reason:string}}
 */
function growAmount(m, g) {
    if (!m.disk || !Number.isFinite(m.disk.freeGB) || !Number.isFinite(m.disk.totalGB)) return { reason: 'espaço do disco da FRA desconhecido' };
    const limitGb = m.limitMb / 1024;
    const effGb = Math.max(0, m.usedMb - m.reclaimMb) / 1024;
    const reserveGb = Math.max((m.disk.totalGB * g.diskReservePct) / 100, 2);
    const maxByDisk = effGb + m.disk.freeGB - reserveGb;
    const step = Math.max((limitGb * g.growStepPct) / 100, 5);
    const toTarget = effGb / (g.targetPct / 100) - limitGb;
    let want = limitGb + Math.max(step, toTarget);
    want = Math.min(want, maxByDisk);
    if (g.maxSizeGb > 0) want = Math.min(want, g.maxSizeGb);
    const newGb = Math.floor(want);
    if (newGb - limitGb < 1) {
        if (g.maxSizeGb > 0 && limitGb >= g.maxSizeGb - 1) return { reason: `teto de ${g.maxSizeGb} GB atingido` };
        return { reason: `sem espaço no disco (livre ${Math.round(m.disk.freeGB)} GB, reserva ${Math.round(reserveGb)} GB)` };
    }
    return { addGb: Math.round((newGb - limitGb) * 10) / 10, newGb };
}

/**
 * Ritmo de crescimento (MB/min) pelos últimos ~15 min, ignorando quedas (limpezas).
 * minMinutes menor durante um backup RMAN: o ritmo dele aparece em segundos.
 */
function growthRate(samples, minMinutes = 4) {
    if (!samples || samples.length < 3) return null;
    let start = samples.length - 1;
    while (start > 0 && samples[start - 1].effMb <= samples[start].effMb) start--;
    const tail = samples.slice(start);
    const first = tail[0];
    const last = tail[tail.length - 1];
    const minutes = (last.t - first.t) / 60000;
    if (minutes < minMinutes) return null;
    const rate = (last.effMb - first.effMb) / minutes;
    return rate > 0 ? rate : 0;
}

/**
 * @param m   medição: { limitMb, usedMb, reclaimMb, archiver, unbackedMb, rateMbMin, disk, emergencyDisk }
 * @param g   configurações do guardião
 * @param ctx { now, last: {acao: epoch}, failed: {acao: epoch}, automation, backupDest }
 */
function decide(m, g, ctx) {
    const now = ctx.now || Date.now();
    const effMb = Math.max(0, m.usedMb - m.reclaimMb);
    const pct = m.limitMb ? (effMb / m.limitMb) * 100 : 0;
    const etaMin = m.rateMbMin > 0 ? (m.limitMb - effMb) / m.rateMbMin : null;
    const stuck = m.archiver === 'FAILED';

    let level = 'ok';
    if (stuck || pct >= g.emergencyPct) level = 'emergency';
    else if (pct >= g.growPct || (etaMin != null && etaMin < 30)) level = 'grow';
    else if (pct >= g.targetPct || (etaMin != null && etaMin < 180)) level = 'act';

    // Backups em diretório próprio liberam a FRA por inteiro; dentro da FRA só
    // compactam — por isso, nesse caso, o despejo no diretório de emergência vem antes.
    const toDir = ctx.backupDest === 'dir';
    const order = {
        ok: [],
        act: ['backup-archivelog', 'cleanup'],
        grow: toDir ? ['grow', 'backup-archivelog', 'dump', 'cleanup'] : ['grow', 'dump', 'backup-archivelog', 'cleanup'],
        emergency: ['grow', 'dump', 'backup-archivelog', 'force-delete', 'cleanup'],
    }[level];
    const cool = level === 'emergency' ? COOLDOWN_EMERGENCY : COOLDOWN;

    const skipped = [];
    for (const kind of order) {
        const why = blockedReason(kind, { m, g, ctx, level, now, cool });
        if (why) { skipped.push({ kind, label: ACTION_LABEL[kind], why }); continue; }
        const action = { kind, label: ACTION_LABEL[kind] };
        if (kind === 'grow') Object.assign(action, growAmount(m, g));
        if (kind === 'force-delete') action.keepMinutes = ctx.last['force-delete'] && now - ctx.last['force-delete'] < 3600000 ? 15 : 60;
        return { level, pct, etaMin, stuck, action, skipped };
    }
    return { level, pct, etaMin, stuck, action: null, skipped };
}

function blockedReason(kind, { m, g, ctx, level, now, cool }) {
    const last = ctx.last[kind];
    if (last && now - last < cool[kind] * 60000) return `executado há ${Math.round((now - last) / 60000)} min`;
    const failed = ctx.failed[kind];
    if (failed && now - failed < FAIL_QUARANTINE[kind] * 60000) return `falhou há ${Math.round((now - failed) / 60000)} min`;
    const needsRman = ['backup-archivelog', 'cleanup', 'dump', 'force-delete'].includes(kind);
    if (needsRman && !ctx.automation) return 'RMAN não configurado (DB_ORACLE_HOME/DB_ORACLE_SID)';
    switch (kind) {
        case 'backup-archivelog':
            if (m.unbackedMb < 64) return 'não há archives sem backup';
            // Na emergência (≥ limite) não há folga na FRA para gravar o backup nela mesma.
            if (ctx.backupDest !== 'dir' && level === 'emergency') return 'o backup iria para a própria FRA, que está cheia';
            return null;
        case 'grow': {
            const r = growAmount(m, g);
            return r.reason || null;
        }
        case 'dump':
            if (!g.emergencyDir) return 'diretório de emergência não configurado';
            if (m.unbackedMb < 64) return 'não há archives sem backup para mover';
            if (m.emergencyDisk && Number.isFinite(m.emergencyDisk.freeGB) && m.emergencyDisk.freeGB < Math.max(1, (m.unbackedMb * 0.6) / 1024)) return 'sem espaço no diretório de emergência';
            return null;
        case 'force-delete':
            if (!g.lastResort) return 'último recurso desligado';
            return null;
        default:
            return null;
    }
}

// ==========================================================================
// Medição
// ==========================================================================

const SEP = "||'|~|'||";
const MEASURE_SQL = `SELECT 'R~'||f.name${SEP}ROUND(f.space_limit/1048576)${SEP}ROUND(f.space_used/1048576)${SEP}ROUND(f.space_reclaimable/1048576)`
    + `${SEP}(SELECT archiver FROM v$instance)${SEP}(SELECT log_mode FROM v$database)`
    + `${SEP}(SELECT ROUND(NVL(SUM(a.blocks*a.block_size),0)/1048576) FROM v$archived_log a WHERE a.deleted = 'NO' AND a.status = 'A' AND a.backup_count = 0 AND a.is_recovery_dest_file = 'YES')`
    + `${SEP}(SELECT value FROM v$parameter WHERE name = 'spfile')`
    // backup RMAN gravando agora (longops atualizado nos últimos 10 min)
    + `${SEP}(SELECT COUNT(*) FROM v$session_longops o WHERE o.opname LIKE 'RMAN%' AND o.totalwork > 0 AND o.sofar < o.totalwork AND o.last_update_time > SYSDATE - 10/1440)`
    + ' AS l FROM v$recovery_file_dest f';

function parseMeasure(line) {
    const f = String(line || '').replace(/^R~/, '').split('|~|');
    const n = (v) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : 0);
    return { dest: f[0] || null, limitMb: n(f[1]), usedMb: n(f[2]), reclaimMb: n(f[3]), archiver: f[4] || null, logMode: f[5] || null, unbackedMb: n(f[6]), spfile: f[7] || null, rmanBusy: n(f[8]) > 0 };
}

async function measureDb() {
    if (config.demoMode) return { ...demoFra.state, logMode: 'ARCHIVELOG', spfile: 'spfileorcl.ora', via: 'demo' };
    // 1) conexão do painel (pool)
    try {
        const conn = await db.getConnection();
        try {
            conn.callTimeout = 30000;
            const r = await conn.execute(db.tag(MEASURE_SQL));
            return { ...parseMeasure((r.rows[0] || {}).L), via: 'pool' };
        } finally {
            try { await conn.close(); } catch { /* ignore */ }
        }
    } catch (err) {
        // 2) com o archiver travado (ORA-00257) só SYSDBA conecta
        if (!config.oracleServer.rmanAutomationReady) throw err;
        const collect = require('./recovery/collect');
        const out = await collect.runSysdba(['SET PAGESIZE 0', 'SET LINESIZE 32767', 'SET HEADING OFF', 'SET FEEDBACK OFF', `${MEASURE_SQL};`], { timeoutMs: 60000 });
        const line = out.output.split(/\r?\n/).find((l) => l.startsWith('R~'));
        if (!line) throw new Error(`não foi possível medir a FRA (${err.message.split('\n')[0]})`);
        return { ...parseMeasure(line), via: 'sysdba' };
    }
}

const diskCache = new Map();
async function diskFor(dir) {
    if (!dir) return null;
    const hit = diskCache.get(dir);
    if (hit && Date.now() - hit.at < 120000) return hit.value;
    const value = await storage.getDiskForPath(dir).catch((e) => ({ error: e.message }));
    const disk = value && !value.error ? { freeGB: Number(value.freeGB), totalGB: Number(value.totalGB), usedPct: value.usedPct } : null;
    diskCache.set(dir, { at: Date.now(), value: disk });
    return disk;
}

// ==========================================================================
// Ações
// ==========================================================================

async function runSql(sql) {
    try {
        await db.executeAdmin(sql);
        return { ok: true, output: `SQL> ${sql}\nOK` };
    } catch (err) {
        if (!config.oracleServer.rmanAutomationReady) throw err;
        const collect = require('./recovery/collect');
        const r = await collect.runSysdba(['WHENEVER SQLERROR EXIT FAILURE', `${sql};`], { timeoutMs: 60000 });
        const bad = /\b(ORA|SP2)-\d{4,5}\b/.test(r.output);
        return { ok: r.code === 0 && !bad, output: r.output };
    }
}

function actionRman(action, settings) {
    const g = settings.guard;
    // "Somente archivelogs": sem backup do banco no RMAN, a retenção é por dias (já nas linhas
    // da tarefa de archivelog) — o DELETE OBSOLETE não tem referência para decidir.
    const archOnly = settings.schedule.strategy === 'archivelog';
    const obsolete = archOnly ? [] : ['DELETE NOPROMPT OBSOLETE;'];
    switch (action.kind) {
        case 'backup-archivelog':
            return [...backupSchedule.rmanLines('archivelog', settings.schedule), ...obsolete];
        case 'cleanup':
            return ['CROSSCHECK ARCHIVELOG ALL;', 'DELETE NOPROMPT EXPIRED ARCHIVELOG ALL;', 'CROSSCHECK BACKUP;', 'DELETE NOPROMPT EXPIRED BACKUP;',
                ...(archOnly ? backupSchedule.rmanLines('archivelog', settings.schedule).slice(-1) : obsolete),
                'DELETE NOPROMPT ARCHIVELOG ALL BACKED UP 1 TIMES TO DEVICE TYPE DISK;'];
        case 'dump':
            return [`BACKUP AS COMPRESSED BACKUPSET ARCHIVELOG ALL NOT BACKED UP 1 TIMES FILESPERSET 8 FORMAT '${g.emergencyDir}%d_EMERG_%T_%U' DELETE INPUT;`,
                'DELETE NOPROMPT ARCHIVELOG ALL BACKED UP 1 TIMES TO DEVICE TYPE DISK;'];
        case 'force-delete':
            return ['CROSSCHECK ARCHIVELOG ALL;', `DELETE NOPROMPT FORCE ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE-${action.keepMinutes}/1440';`];
        default:
            return null;
    }
}

function demoApply(action) {
    const s = demoFra.state;
    if (action.kind === 'grow') s.limitMb = action.newGb * 1024;
    else if (action.kind === 'backup-archivelog') { s.usedMb -= Math.round(s.unbackedMb * 0.7); s.unbackedMb = 0; }
    else if (action.kind === 'dump') { s.usedMb -= s.unbackedMb; s.unbackedMb = 0; }
    else if (action.kind === 'cleanup') s.usedMb = Math.round(s.usedMb * 0.93);
    else if (action.kind === 'force-delete') s.usedMb = Math.round(s.usedMb * 0.5);
    s.usedMb = Math.max(1000, s.usedMb);
}

async function execute(action, m, settings) {
    if (config.demoMode) {
        await new Promise((r) => setTimeout(r, 400));
        demoApply(action);
        return { ok: true, output: action.kind === 'grow' ? `ALTER SYSTEM SET db_recovery_file_dest_size = ${action.newGb}G SCOPE=BOTH\nSystem altered.` : `RMAN> ${(actionRman(action, settings) || []).join('\nRMAN> ')}\n(simulação)` };
    }
    if (action.kind === 'grow') {
        return runSql(`ALTER SYSTEM SET db_recovery_file_dest_size = ${action.newGb}G SCOPE=${m.spfile ? 'BOTH' : 'MEMORY'}`);
    }
    const r = await backupAdmin.runRmanGuarded(actionRman(action, settings), { timeoutMs: 6 * 3600000 });
    return { ok: r.ok, output: r.output, errors: r.errors };
}

// ==========================================================================
// Estado, histórico e laço
// ==========================================================================

const state = {
    started: false,
    busy: null,              // ação em execução
    lastCheck: null,
    measure: null,
    decision: null,
    error: null,
    samples: [],
    last: {},
    failed: {},
    schedule: null,          // { jobs, alerts, checkedAt }
};
let history = null;

function loadHistory() {
    if (history) return history;
    try { history = JSON.parse(fs.readFileSync(HISTORY_FILE(), 'utf8')); } catch { history = []; }
    if (!Array.isArray(history)) history = [];
    return history;
}

function pushHistory(entry) {
    loadHistory().unshift(entry);
    history.length = Math.min(history.length, HISTORY_MAX);
    try {
        fs.mkdirSync(config.paths.logs, { recursive: true });
        fs.writeFileSync(HISTORY_FILE(), JSON.stringify(history, null, 1));
    } catch (err) {
        logger.warn('Não foi possível gravar o histórico do guardião da FRA:', err.message);
    }
}

/** Limpeza de logs: apaga o histórico de ações do guardião. */
function clearHistory() {
    history = [];
    let bytes = 0;
    try {
        bytes = fs.statSync(HISTORY_FILE()).size;
        fs.unlinkSync(HISTORY_FILE());
        return { files: 1, bytes };
    } catch {
        return { files: 0, bytes: 0 };
    }
}

function summary() {
    const s = backupSchedule.loadSettings();
    const m = state.measure;
    return {
        enabled: s.guard.enabled,
        settings: s.guard,
        busy: state.busy,
        lastCheck: state.lastCheck,
        error: state.error,
        measure: m ? {
            dest: m.dest, limitGb: round1(m.limitMb / 1024), usedGb: round1(m.usedMb / 1024), reclaimGb: round1(m.reclaimMb / 1024),
            unbackedGb: round1(m.unbackedMb / 1024), archiver: m.archiver, logMode: m.logMode, via: m.via,
            rateGbH: m.rateMbMin != null ? round1((m.rateMbMin * 60) / 1024) : null,
            disk: m.disk, emergencyDisk: m.emergencyDisk,
        } : null,
        decision: state.decision ? {
            level: state.decision.level, pct: round1(state.decision.pct), etaMin: state.decision.etaMin != null ? Math.round(state.decision.etaMin) : null,
            action: state.decision.action, skipped: state.decision.skipped, stuck: state.decision.stuck,
        } : null,
        compromisedSince: s.guardState.compromisedSince || null,
        automation: config.demoMode || config.oracleServer.rmanAutomationReady,
        history: loadHistory().slice(0, 40),
    };
}

function round1(n) {
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** Número com vírgula decimal (mensagens e notificações). */
function br(n) {
    return n == null ? '?' : String(n).replace('.', ',');
}

async function checkCompromised(settings) {
    const since = settings.guardState.compromisedSince;
    if (!since) return;
    let lastDb = null;
    if (config.demoMode) {
        lastDb = null;
    } else {
        try {
            const rows = await db.runQuery('lastDbBackupEnd');
            lastDb = rows[0] && (rows[0].END_ISO || rows[0].end_iso);
        } catch { /* sem como confirmar agora */ }
    }
    if (lastDb && Date.parse(lastDb) > Date.parse(since)) {
        backupSchedule.updateSettings({ guardState: { compromisedSince: null } });
        alerts.setExternal('fraguard-compromised', null);
        pushHistory({ at: new Date().toISOString(), level: 'ok', kind: 'recovered', label: 'Backup completo concluído: recuperação restabelecida', ok: true });
    } else {
        alerts.setExternal('fraguard-compromised', {
            severity: 'critical',
            message: `Recuperação comprometida desde ${new Date(since).toLocaleString('pt-BR')}: o guardião apagou archives sem backup para o banco não parar. Faça um backup completo (tela Backup).`,
        });
    }
}

/** Uma verificação (e no máximo uma ação). */
async function tick({ manual = false } = {}) {
    const settings = backupSchedule.loadSettings();
    const g = settings.guard;
    if (!g.enabled && !manual) {
        alerts.syncExternal('fraguard-', []);
        return summary();
    }
    if (state.busy) return summary();
    try {
        const m = await measureDb();
        state.error = null;
        if (!m.dest || !m.limitMb) {
            state.measure = { ...m, rateMbMin: null };
            state.decision = { level: 'ok', pct: 0, etaMin: null, action: null, skipped: [{ kind: '-', why: 'FRA não configurada (DB_RECOVERY_FILE_DEST vazio)' }] };
            state.lastCheck = new Date().toISOString();
            return summary();
        }
        const effMb = Math.max(0, m.usedMb - m.reclaimMb);
        state.samples.push({ t: Date.now(), effMb });
        state.samples = state.samples.filter((x) => Date.now() - x.t < 20 * 60000);
        m.rateMbMin = growthRate(state.samples, m.rmanBusy ? 1 : 4);
        m.disk = await diskFor(m.dest);
        m.emergencyDisk = g.emergencyDir ? await diskFor(g.emergencyDir) : null;
        state.measure = m;
        const automation = config.demoMode || config.oracleServer.rmanAutomationReady;
        const d = decide(m, g, { now: Date.now(), last: state.last, failed: state.failed, automation, backupDest: settings.schedule.destination });
        state.decision = d;
        state.lastCheck = new Date().toISOString();

        // Notificações de situação
        const stuckNoAction = d.level === 'emergency' && !d.action;
        alerts.setExternal('fraguard-stuck', stuckNoAction ? {
            severity: 'critical',
            message: `FRA em ${br(round1(d.pct))}% e o guardião não tem como agir: ${d.skipped.map((s) => `${s.label} — ${s.why}`).join('; ')}. Libere disco ou configure o diretório de emergência.`,
        } : null);
        alerts.setExternal('fraguard-limited', g.enabled && !automation ? {
            severity: 'warning',
            message: 'Guardião da FRA com recursos limitados: sem DB_ORACLE_HOME/DB_ORACLE_SID ele só consegue aumentar o limite da FRA (sem backup/limpeza de archives).',
        } : null);
        await checkCompromised(settings);

        if (d.action && (g.enabled || manual) && d.level !== 'ok') {
            await runAction(d, m, settings);
            // Mostra a situação DEPOIS da ação (sem agir de novo nesta rodada).
            try {
                const m2 = await measureDb();
                m2.rateMbMin = null;
                m2.disk = await diskFor(m2.dest);
                m2.emergencyDisk = g.emergencyDir ? await diskFor(g.emergencyDir) : null;
                state.measure = m2;
                state.decision = decide(m2, g, { now: Date.now(), last: state.last, failed: state.failed, automation, backupDest: settings.schedule.destination });
            } catch { /* fica a medição anterior */ }
        }
    } catch (err) {
        state.error = err.message.split('\n')[0];
        state.lastCheck = new Date().toISOString();
    }
    return summary();
}

async function runAction(d, m, settings) {
    const action = d.action;
    const before = d.pct;
    state.busy = { ...action, startedAt: new Date().toISOString() };
    const entry = { at: new Date().toISOString(), level: d.level, kind: action.kind, label: action.label, pctBefore: round1(before), reason: reasonText(d) };
    if (action.kind === 'grow') entry.detail = `limite ${br(round1(m.limitMb / 1024))} GB → ${action.newGb} GB`;
    try {
        const r = await execute(action, m, settings);
        entry.ok = !!r.ok;
        entry.output = String(r.output || '').slice(-4000);
        if (r.ok) {
            state.last[action.kind] = Date.now();
            delete state.failed[action.kind];
        } else {
            state.failed[action.kind] = Date.now();
            entry.detail = [entry.detail, r.errors && r.errors.length ? `erros: ${r.errors.join(', ')}` : null].filter(Boolean).join(' · ');
        }
    } catch (err) {
        entry.ok = false;
        entry.output = backupAdmin.scrubSecrets(err.message).slice(0, 2000);
        state.failed[action.kind] = Date.now();
    } finally {
        state.busy = null;
    }
    // Mede de novo para registrar o efeito
    try {
        const after = await measureDb();
        entry.pctAfter = after.limitMb ? round1((Math.max(0, after.usedMb - after.reclaimMb) / after.limitMb) * 100) : null;
        state.samples = []; // o ritmo recomeça depois de uma ação
    } catch { /* ignore */ }
    if (action.kind === 'force-delete' && entry.ok) {
        const s = backupSchedule.loadSettings();
        if (!s.guardState.compromisedSince) backupSchedule.updateSettings({ guardState: { compromisedSince: entry.at } });
    }
    pushHistory(entry);
    audit.record({
        action: 'fra-guard', user: 'guardião', role: 'sistema', ip: 'local', success: entry.ok,
        detail: `${action.kind} ${entry.detail || ''} (${entry.pctBefore}% → ${entry.pctAfter ?? '?'}%)`.trim(),
    });
    alerts.setExternal(`fraguard-action:${action.kind}`, {
        severity: action.kind === 'force-delete' || !entry.ok ? 'critical' : 'warning',
        message: `Guardião da FRA: ${action.label}${entry.detail ? ` (${entry.detail})` : ''} — ${entry.ok ? `FRA ${br(entry.pctBefore)}% → ${br(entry.pctAfter)}%` : 'FALHOU, veja o histórico na tela Backup'}.`,
    }, 2 * 3600000);
    logger.warn(`Guardião da FRA: ${action.label} → ${entry.ok ? 'ok' : 'falhou'} (${entry.pctBefore}% → ${entry.pctAfter ?? '?'}%)`);
}

function reasonText(d) {
    const parts = [`FRA em ${br(round1(d.pct))}%`];
    if (d.etaMin != null && d.etaMin < 24 * 60) parts.push(`enche em ~${Math.max(1, Math.round(d.etaMin))} min no ritmo atual`);
    if (d.stuck) parts.push('archiver travado');
    return parts.join(', ');
}

/** Situação dos backups agendados (falhas/atrasos viram notificação). */
async function checkSchedule() {
    try {
        const s = backupSchedule.loadSettings();
        if (!s.schedule.installed) {
            state.schedule = { jobs: [], alerts: [], checkedAt: new Date().toISOString() };
            alerts.syncExternal('backup-', []);
            return state.schedule;
        }
        const { statuses, tasks } = await backupSchedule.readStatuses(s.schedule);
        const ev = backupSchedule.evaluateJobs(s.schedule, statuses);
        state.schedule = { ...ev, tasks, checkedAt: new Date().toISOString() };
        alerts.syncExternal('backup-', ev.alerts);
    } catch (err) {
        state.schedule = { jobs: [], alerts: [], error: err.message.split('\n')[0], checkedAt: new Date().toISOString() };
    }
    return state.schedule;
}

function start() {
    if (state.started) return;
    state.started = true;
    // Próxima medição: 15 s com backup RMAN em andamento, 60 s no resto do tempo.
    const loop = (delay) => {
        const t = setTimeout(async () => {
            await tick().catch(() => {});
            loop(state.measure && state.measure.rmanBusy ? TICK_BUSY_MS : TICK_MS);
        }, delay);
        if (t.unref) t.unref();
    };
    const t2 = setInterval(() => { checkSchedule().catch(() => {}); }, SCHEDULE_CHECK_MS);
    if (t2.unref) t2.unref();
    loop(8000);
    setTimeout(() => { checkSchedule().catch(() => {}); }, 8000).unref?.();
}

module.exports = {
    start, tick, summary, checkSchedule, clearHistory, scheduleState: () => state.schedule,
    // puros (testes)
    decide, growAmount, growthRate, parseMeasure, actionRman, MEASURE_SQL, ACTION_LABEL,
};

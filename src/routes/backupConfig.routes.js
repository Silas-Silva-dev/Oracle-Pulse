/**
 * Rotas de CONFIGURAÇÃO de backup (DBA-only, auditadas):
 *  - GET  /backup/config            estado atual (archivelog, FRA, retenção)
 *  - POST /backup/config/fra-size   define DB_RECOVERY_FILE_DEST_SIZE (sem reinício)
 *  - POST /backup/config/retention  define a janela de retenção do RMAN (via RMAN)
 *
 * O modo ARCHIVELOG NÃO é alterado ao vivo (exige MOUNT/parada). A rota de
 * config retorna o procedimento exato para o DBA executar em manutenção.
 */
const express = require('express');
const { config } = require('../config');
const { runQuery, executeAdmin, ValidationError, assertPositiveInt } = require('../db');
const logger = require('../logger');
const storage = require('../storage');
const { requireDba } = require('../auth');
const backupAdmin = require('../backupAdmin');
const backupSchedule = require('../backupSchedule');
const backupPreflight = require('../backupPreflight');
const audit = require('../audit');
const cache = require('../cache');

const router = express.Router();

const MAX_FRA_GB = 10240; // 10 TB de teto de segurança
const MAX_RETENTION_DAYS = 3650;

/** Interpreta a política de retenção vinda do V$RMAN_CONFIGURATION. */
function parseRetention(rmanRows) {
    const row = (rmanRows || []).find((r) => (r.NAME || r.name) === 'RETENTION POLICY');
    const raw = row ? (row.VALUE || row.value) : 'TO REDUNDANCY 1'; // padrão do Oracle
    const win = raw.match(/RECOVERY WINDOW OF (\d+) DAYS/i);
    if (win) return { raw, type: 'recovery-window', days: parseInt(win[1], 10) };
    const red = raw.match(/REDUNDANCY (\d+)/i);
    if (red) return { raw, type: 'redundancy', redundancy: parseInt(red[1], 10) };
    return { raw, type: 'other' };
}

/** Interpreta a política de deleção de archivelog. */
function parseDeletionPolicy(rmanRows) {
    const row = (rmanRows || []).find((r) => (r.NAME || r.name) === 'ARCHIVELOG DELETION POLICY');
    const raw = row ? (row.VALUE || row.value) : 'TO NONE';
    return { raw, enabled: !/TO NONE/i.test(raw) };
}

router.get('/backup/config', requireDba, async (req, res) => {
    try {
        const [arch, recParams, rman, fra] = await Promise.all([
            runQuery('archivelogMode'),
            runQuery('recoveryParams'),
            runQuery('rmanConfig'),
            runQuery('fraUsage'),
        ]);

        const params = {};
        (recParams || []).forEach((r) => { params[(r.NAME || r.name)] = (r.VALUE || r.value); });
        const sizeBytes = Number(params.db_recovery_file_dest_size || 0);
        const fra0 = (fra && fra[0]) || {};

        res.json({
            success: true,
            data: {
                archivelog: arch[0] || null,
                fra: {
                    dest: params.db_recovery_file_dest || '',
                    sizeGb: sizeBytes > 0 ? Math.round(sizeBytes / (1024 ** 3)) : 0,
                    usedMb: fra0.USED_MB ?? fra0.used_mb ?? null,
                    limitMb: fra0.LIMIT_MB ?? fra0.limit_mb ?? null,
                    usedPct: fra0.USED_PCT ?? fra0.used_pct ?? null,
                },
                retention: parseRetention(rman),
                deletionPolicy: parseDeletionPolicy(rman),
                rman: rman || [],
                rmanAutomationReady: config.oracleServer.rmanAutomationReady || config.demoMode,
                archivelogProcedure: {
                    enable: backupAdmin.archivelogProcedure(true),
                    disable: backupAdmin.archivelogProcedure(false),
                },
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/** Lê o destino atual da FRA (db_recovery_file_dest) — vazio = não configurada. */
async function currentFraDest() {
    const rec = await runQuery('recoveryParams');
    const params = {};
    (rec || []).forEach((r) => { params[(r.NAME || r.name)] = (r.VALUE || r.value); });
    return (params.db_recovery_file_dest || '').trim();
}

router.post('/backup/config/fra-size', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const { sizeGb } = req.body || {};
        const size = assertPositiveInt(sizeGb, 'Tamanho da FRA (GB)', { min: 1, max: MAX_FRA_GB });

        if (config.demoMode) {
            audit.record({ action: 'fra-size', user: req.session.user, role: req.session.role, ip, detail: `[DEMO] ${size}G` });
            return res.json({ success: true, message: `Simulação: FRA definida para ${size} GB.`, autoConfigured: false });
        }

        const dest = await currentFraDest();
        let autoConfigured = false;
        let fraDest = dest;

        // Se a FRA AINDA NÃO tem destino, cria a pasta no servidor e a define
        // como db_recovery_file_dest (antes de mexer no SQL, p/ não deixar estado
        // parcial se a criação da pasta falhar).
        if (!dest) {
            fraDest = await backupAdmin.resolveFraPath();
            await backupAdmin.createServerDir(fraDest);
        }

        // Tamanho (precisa estar definido antes do destino).
        await executeAdmin(`ALTER SYSTEM SET DB_RECOVERY_FILE_DEST_SIZE = ${size}G SCOPE=BOTH`);

        if (!dest) {
            await executeAdmin(`ALTER SYSTEM SET DB_RECOVERY_FILE_DEST = '${fraDest}' SCOPE=BOTH`);
            autoConfigured = true;
        }

        cache.invalidate('archivelogMode');
        cache.invalidate('fraUsage');
        audit.record({
            action: 'fra-size', user: req.session.user, role: req.session.role, ip,
            detail: autoConfigured ? `${size}G + FRA criada/definida em ${fraDest}` : `${size}G`,
        });
        res.json({
            success: true, autoConfigured, fraDest,
            message: autoConfigured
                ? `FRA configurada com sucesso (sem reinício):\n• pasta criada em ${fraDest}\n• definida como destino (DB_RECOVERY_FILE_DEST)\n• tamanho máximo: ${size} GB`
                : `Tamanho máximo da FRA definido para ${size} GB (sem reinício).`,
        });
    } catch (err) {
        const status = err instanceof ValidationError ? 400 : 500;
        audit.record({ action: 'fra-size', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

router.post('/backup/config/retention', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const { days } = req.body || {};
        const d = assertPositiveInt(days, 'Dias de retenção', { min: 1, max: MAX_RETENTION_DAYS });

        const result = await backupAdmin.setRetention(d);
        audit.record({
            action: 'rman-retention',
            user: req.session.user, role: req.session.role, ip,
            success: result.success,
            detail: `${d} dias${result.success ? '' : ' (não aplicado: ' + (result.detail || result.message) + ')'}`,
        });
        // 200 mesmo quando não aplicado: o front mostra a mensagem + comando manual.
        res.json(result);
    } catch (err) {
        const status = err instanceof ValidationError ? 400 : 500;
        audit.record({ action: 'rman-retention', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

/**
 * Volume onde a FRA fica (ou ficará): destino atual (db_recovery_file_dest),
 * senão DB_FRA_DEST do .env, senão o diretório do SYSTEM (onde costuma estar o
 * ORACLE_BASE, base do caminho automático da FRA).
 */
async function fraDisk() {
    const dest = await currentFraDest();
    const target = dest || config.oracleServer.fraDest;
    if (target) return storage.getDiskForPath(target);
    const { layout } = await storage.getLayout();
    const system = layout.tablespaces.find((t) => t.name === 'SYSTEM');
    return storage.getDiskForPath(system ? system.currentDir : layout.currentDir);
}

/**
 * Sugere um tamanho de FRA suficiente, porém enxuto:
 * archives (redo/dia × retenção × margem) + os backups do agendamento quando o
 * destino deles é a própria FRA, com teto pelo espaço que a FRA pode ocupar no disco.
 */
async function computeFraRecommendation() {
    const [redo, rmanRows, sizeRow, disk, fraRows] = await Promise.all([
        runQuery('redoStats'),
        runQuery('rmanConfig'),
        runQuery('dbSize'),
        fraDisk().catch(() => null),
        runQuery('fraUsage').catch(() => []),
    ]);

    const r0 = redo[0] || {};
    const redoBytes = Number(r0.REDO_BYTES ?? r0.redo_bytes ?? 0);
    const uptimeSec = Number(r0.UPTIME_SEC ?? r0.uptime_sec ?? 1) || 1;
    const redoPerDayGb = (redoBytes / uptimeSec) * 86400 / (1024 ** 3);

    const ret = parseRetention(rmanRows);
    const retentionDays = ret.type === 'recovery-window' ? ret.days : 7; // padrão razoável
    const dbSizeGb = Number((sizeRow[0] || {}).DB_SIZE_GB || (sizeRow[0] || {}).db_size_gb || 0);

    // Espaço para os archive logs retidos + margem de segurança de 50%.
    const archiveSpaceGb = redoPerDayGb * retentionDays * 1.5;
    const buffer = 2;
    const floor = Math.max(redoPerDayGb * 2, 5); // nunca recomenda algo minúsculo
    // Backups agendados com destino na FRA ficam dentro dela (pico: nova cópia + as retidas).
    const schedule = backupSchedule.loadSettings().schedule;
    const backups = backupPreflight.fraBackupsAllowance(schedule, ret, dbSizeGb, redoPerDayGb);
    let recommendedGb = Math.ceil(Math.max(archiveSpaceGb + buffer + backups.gb, floor));

    // Teto: 75% do que a FRA pode ocupar no volume (o livre + o que ela já usa).
    const freeDiskGb = disk && !disk.error ? Number(disk.freeGB) : null;
    const fra = fraRows[0] || {};
    const fraUsedGb = Number(fra.USED_MB ?? fra.used_mb ?? 0) / 1024 || 0;
    let cappedByDisk = false;
    if (freeDiskGb && freeDiskGb > 0) {
        const cap = Math.floor((freeDiskGb + fraUsedGb) * 0.75);
        if (recommendedGb > cap) { recommendedGb = cap; cappedByDisk = true; }
    }

    return {
        recommendedGb,
        basis: {
            redoPerDayGb: Math.round(redoPerDayGb * 100) / 100,
            retentionDays,
            dbSizeGb,
            freeDiskGb,
            fraUsedGb: Math.round(fraUsedGb * 10) / 10,
            cappedByDisk,
            archiveSpaceGb: Math.ceil(archiveSpaceGb + buffer),
            backupsToFra: schedule.destination === 'fra',
            backupsGb: Math.ceil(backups.gb),
            backupsText: backups.text,
            strategy: schedule.strategy,
        },
    };
}

router.get('/backup/config/fra-recommendation', requireDba, async (req, res) => {
    try {
        res.json({ success: true, data: await computeFraRecommendation() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Inicia a (des)ativação REAL do archivelog em segundo plano.
router.post('/backup/config/archivelog', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const enable = req.body?.enable === true || req.body?.enable === 'true';
        const jobId = backupAdmin.startArchivelogJob(enable, { user: req.session.user, role: req.session.role, ip });
        res.json({ success: true, jobId, message: 'Operação iniciada em segundo plano.' });
    } catch (err) {
        if (err.needsConfig) {
            return res.status(400).json({ success: false, error: err.message, needsConfig: true });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// Política de deleção de archivelog (faz a FRA reciclar automaticamente).
router.post('/backup/config/deletion-policy', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const enable = req.body?.enable === true || req.body?.enable === 'true';
        const result = await backupAdmin.setArchivelogDeletionPolicy(enable);
        audit.record({ action: 'archivelog-deletion-policy', user: req.session.user, role: req.session.role, ip, success: result.success, detail: enable ? 'BACKED UP 1 TIMES TO DISK' : 'NONE' });
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Limpar obsoletos (DELETE OBSOLETE) — job em segundo plano.
router.post('/backup/config/delete-obsolete', requireDba, (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const jobId = backupAdmin.startDeleteObsoleteJob({ user: req.session.user, role: req.session.role, ip });
        res.json({ success: true, jobId, message: 'Limpeza de obsoletos iniciada em segundo plano.' });
    } catch (err) {
        const status = err.needsConfig ? 400 : 500;
        res.status(status).json({ success: false, error: err.message, needsConfig: !!err.needsConfig });
    }
});

// Backup sob demanda (full ou só archivelog) — job em segundo plano.
router.post('/backup/config/backup', requireDba, (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const type = req.body?.type === 'archivelog' ? 'archivelog' : 'full';
        const jobId = backupAdmin.startBackupJob(type, { user: req.session.user, role: req.session.role, ip });
        res.json({ success: true, jobId, message: `Backup (${type}) iniciado em segundo plano.` });
    } catch (err) {
        const status = err.needsConfig ? 400 : 500;
        res.status(status).json({ success: false, error: err.message, needsConfig: !!err.needsConfig });
    }
});

// Status genérico de qualquer job (archivelog, delete-obsolete, backup).
router.get('/backup/config/job/:jobId', requireDba, (req, res) => {
    const job = backupAdmin.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job não encontrado.' });
    res.json({ success: true, data: job });
});

// Logs das execuções DISPARADAS PELO PAINEL (backup, archivelog, delete-obsolete,
// retenção). É o histórico de saída mais confiável, pois capturamos o stdout.
router.get('/backup/config/jobs', requireDba, (req, res) => {
    res.json({ success: true, data: backupAdmin.listJobs(30) });
});

// Log de uma sessão RMAN do histórico (v$rman_output, por session_key).
// É volátil: pode estar vazio para backups antigos ou após reiniciar a instância.
router.get('/backup/rman-log/:sessionKey', requireDba, async (req, res) => {
    try {
        const key = assertPositiveInt(req.params.sessionKey, 'session_key', { min: 1, max: 9999999999 });
        const rows = await runQuery('rmanOutputBySession', { sessionKey: key });
        const text = (rows || []).map((r) => r.OUTPUT ?? r.output ?? '').join('\n').trim();
        res.json({ success: true, data: { sessionKey: key, output: text } });
    } catch (err) {
        const status = err instanceof ValidationError ? 400 : 500;
        logger.warn('Falha ao ler log RMAN:', err.message);
        res.status(status).json({ success: false, error: err.message });
    }
});

// (compatibilidade) status do job de archivelog
router.get('/backup/config/archivelog/status/:jobId', requireDba, (req, res) => {
    const job = backupAdmin.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job não encontrado.' });
    res.json({ success: true, data: job });
});

module.exports = router;

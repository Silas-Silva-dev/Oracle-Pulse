/**
 * Rotas de PROTEÇÃO DE BACKUP (tela Backup, DBA, auditadas):
 *  - GET    /backup/protection                     situação: agendamento + guardião da FRA
 *  - POST   /backup/protection/schedule/preview    o que será instalado (sem alterar nada)
 *  - POST   /backup/protection/schedule            salva e instala o agendamento no servidor
 *  - DELETE /backup/protection/schedule            remove o agendamento do servidor
 *  - POST   /backup/protection/schedule/run        executa uma tarefa agora
 *  - GET    /backup/protection/schedule/log/:job   último log de uma tarefa
 *  - POST   /backup/protection/guard               salva as opções do guardião da FRA
 *  - POST   /backup/protection/guard/check         verifica (e age) agora
 *  - POST   /backup/protection/guard/demo-spike    DEMO: simula um pico de archives
 */
const express = require('express');
const { config } = require('../config');
const { requireDba } = require('../auth');
const audit = require('../audit');
const logger = require('../logger');
const backupSchedule = require('../backupSchedule');
const fraGuard = require('../fraGuard');
const demoFra = require('../demoFra');

const router = express.Router();

const ctxOf = (req) => ({ user: req.session.user, role: req.session.role, ip: audit.ipOf(req) });

function fail(res, err) {
    const status = err.status || 500;
    if (status >= 500) logger.error('Proteção de backup:', err.message);
    res.status(status).json({ success: false, error: err.message });
}

async function readiness() {
    try {
        const { serverOs } = await backupSchedule.context();
        return { ok: true, serverOs, reason: null };
    } catch (err) {
        let serverOs = null;
        try { serverOs = config.demoMode ? 'linux' : await require('../osDisk').detectServerOs(); } catch { /* ignore */ }
        return { ok: false, serverOs, reason: err.message };
    }
}

router.get('/backup/protection', requireDba, async (req, res) => {
    try {
        const settings = backupSchedule.loadSettings();
        const ready = await readiness();
        let sched = fraGuard.scheduleState();
        if (!sched || req.query.refresh === '1') sched = await fraGuard.checkSchedule();
        res.json({
            success: true,
            data: {
                schedule: settings.schedule,
                scheduleState: sched,
                guard: fraGuard.summary(),
                ready,
                demo: config.demoMode,
            },
        });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/backup/protection/schedule/preview', requireDba, async (req, res) => {
    try {
        const ready = await readiness();
        res.json({ success: true, data: backupSchedule.preview(req.body && req.body.schedule, ready.serverOs || 'linux') });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/backup/protection/schedule', requireDba, async (req, res) => {
    const ctx = ctxOf(req);
    try {
        const schedule = await backupSchedule.install(req.body && req.body.schedule, ctx.user);
        audit.record({ action: 'backup-agenda', ...ctx, detail: `instalado: ${backupSchedule.activeJobs(schedule).map((j) => `${j} (${backupSchedule.describeJob(j, schedule)})`).join('; ')} · destino ${schedule.destination === 'dir' ? schedule.directory : 'FRA'}` });
        const sched = await fraGuard.checkSchedule();
        res.json({ success: true, data: { schedule, scheduleState: sched }, message: `Agendamento instalado em: ${schedule.installed.where || schedule.installed.os}.` });
    } catch (err) {
        audit.record({ action: 'backup-agenda', ...ctx, success: false, detail: err.message });
        fail(res, err);
    }
});

router.delete('/backup/protection/schedule', requireDba, async (req, res) => {
    const ctx = ctxOf(req);
    try {
        const schedule = await backupSchedule.remove();
        audit.record({ action: 'backup-agenda', ...ctx, detail: 'agendamento removido do servidor' });
        const sched = await fraGuard.checkSchedule();
        res.json({ success: true, data: { schedule, scheduleState: sched }, message: 'Agendamento removido do servidor.' });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/backup/protection/schedule/run', requireDba, async (req, res) => {
    const ctx = ctxOf(req);
    try {
        const job = String((req.body && req.body.job) || '');
        const s = backupSchedule.loadSettings();
        await backupSchedule.runNow(s.schedule, job);
        audit.record({ action: 'backup-agenda', ...ctx, detail: `executar agora: ${job}` });
        res.json({ success: true, message: `${backupSchedule.JOB_LABEL[job]} iniciado no servidor. Acompanhe pelo status (atualiza em alguns minutos) e pelo log.` });
    } catch (err) {
        fail(res, err);
    }
});

router.get('/backup/protection/schedule/log/:job', requireDba, async (req, res) => {
    try {
        const s = backupSchedule.loadSettings();
        const text = await backupSchedule.readLog(s.schedule, String(req.params.job));
        res.json({ success: true, data: { job: req.params.job, text } });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/backup/protection/guard', requireDba, async (req, res) => {
    const ctx = ctxOf(req);
    try {
        const ready = await readiness();
        const guard = backupSchedule.validateGuard(req.body && req.body.guard, ready.serverOs || 'linux');
        const saved = backupSchedule.updateSettings({ guard });
        audit.record({ action: 'fra-guard-config', ...ctx, detail: `${guard.enabled ? 'ativo' : 'DESLIGADO'} · ${guard.targetPct}/${guard.growPct}/${guard.emergencyPct}% · reserva ${guard.diskReservePct}% · emergência ${guard.emergencyDir || '(nenhum)'} · último recurso ${guard.lastResort ? 'sim' : 'não'}` });
        // No Linux a verificação antes do backup usa reserva/teto/limite gravados no run-job.sh.
        let note = '';
        const inst = saved.schedule.installed;
        if (inst && inst.os === 'linux' && !config.demoMode) {
            try {
                await backupSchedule.install(saved.schedule, ctx.user);
            } catch (err) {
                note = ` Atenção: o agendamento no servidor não foi atualizado (${err.message}); clique em "Salvar e reinstalar".`;
            }
        }
        res.json({ success: true, data: fraGuard.summary(), message: (guard.enabled ? 'Proteção da FRA salva e ativa.' : 'Proteção da FRA DESLIGADA.') + note });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/backup/protection/guard/check', requireDba, async (req, res) => {
    try {
        res.json({ success: true, data: await fraGuard.tick({ manual: true }) });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/backup/protection/guard/demo-spike', requireDba, (req, res) => {
    if (!config.demoMode) return res.status(400).json({ success: false, error: 'Disponível só no modo DEMO.' });
    demoFra.spike();
    res.json({ success: true, message: 'Simulação: FRA em 96% com archives sem backup.' });
});

module.exports = router;

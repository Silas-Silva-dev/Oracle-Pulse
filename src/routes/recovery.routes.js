/**
 * Rotas da tela Recuperação:
 *  - GET  /recovery/diagnosis      diagnóstico + laudo (todos; SYSDBA no servidor só para DBA)
 *  - POST /recovery/lookup         consulta de erro colado, cruzada com o diagnóstico
 *  - GET  /recovery/playbooks      catálogo de procedimentos
 *  - POST /recovery/plan           plano de um procedimento (pré-visualização)
 *  - POST /recovery/execute        executa (DBA, com confirmação e hash do plano)
 *  - GET  /recovery/job/:id        andamento de uma execução (DBA)
 *  - GET  /recovery/jobs           execuções recentes (DBA)
 *  - POST /recovery/demo-scenario  troca o cenário simulado (DBA, só em DEMO)
 */
const express = require('express');
const { config } = require('../config');
const { requireDba } = require('../auth');
const audit = require('../audit');
const logger = require('../logger');
const storage = require('../storage');
const collect = require('../recovery/collect');
const findings = require('../recovery/findings');
const playbooks = require('../recovery/playbooks');
const executor = require('../recovery/executor');
const demo = require('../recovery/demo');

const router = express.Router();
const CACHE_MS = 45000;
const cache = new Map(); // 'dba' | 'viewer' -> { at, signals, report }

const isDba = (req) => req.session && req.session.role === 'dba';

async function diagnose(req, { force = false, days } = {}) {
    const key = isDba(req) ? 'dba' : 'viewer';
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < CACHE_MS && (!days || hit.signals.alert?.days === days)) return hit;
    const signals = config.demoMode ? demo.signals() : await collect.collect({ allowSysdba: key === 'dba', days });
    try {
        const p = require('../backupSchedule').loadSettings();
        let guardManagedEpoch = null;
        try { guardManagedEpoch = require('../fraGuard').lastManagedEpoch(); } catch { /* guardião indisponível */ }
        signals.protection = { scheduleInstalled: !!p.schedule.installed, guardEnabled: !!p.guard.enabled, strategy: p.schedule.strategy, guardManagedEpoch };
    } catch { /* sem configuração */ }
    const report = findings.evaluate(signals);
    const entry = { at: Date.now(), signals, report };
    cache.set(key, entry);
    return entry;
}

function invalidate() {
    cache.clear();
}

/** Versão enxuta dos sinais para a tela (sem listas grandes). */
function publicSignals(s) {
    return {
        at: s.at, source: s.source, state: s.state, stateLabel: playbooks.STATE_LABEL[s.state] || s.state,
        connection: s.connection, sysdbaError: s.sysdbaError || null,
        instance: s.instance, database: s.database, edition: s.edition, banner: s.banner,
        fra: s.fra, backups: s.backups ? { lastDb: s.backups.lastDb, newestAny: s.backups.newestAny, lastArch: s.backups.lastArch, allCovered: s.backups.allCovered } : null,
        counts: {
            datafiles: (s.datafiles || []).length, recover: (s.recoverFiles || []).length, corruption: (s.corruption || []).length,
            logGroups: (s.logs || []).length, controlfiles: (s.controlFileParam || []).length,
        },
        alert: s.alert ? {
            path: s.alert.path, source: s.alert.source, error: s.alert.error, days: s.alert.days,
            records: (s.alert.records || []).slice(-150).reverse(),
            lifecycle: s.alert.lifecycle,
        } : null,
        capabilities: s.capabilities, demo: s.demo || null,
    };
}

function planEnv() {
    return {
        indexInfo: (o, n) => collect.indexInfo(o, n),
        diskFor: (p) => storage.getDiskForPath(p).catch((e) => ({ error: e.message })),
    };
}

function stripPlan(plan) {
    const { internal, ...rest } = plan;
    return rest;
}

function fail(res, err) {
    const status = err.status || (err instanceof playbooks.PlanError ? 400 : 500);
    if (status >= 500) logger.error('Recuperação:', err.message);
    res.status(status).json({ success: false, error: err.message });
}

router.get('/recovery/diagnosis', async (req, res) => {
    try {
        const days = req.query.days ? Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 30) : undefined;
        const { signals, report } = await diagnose(req, { force: req.query.refresh === '1', days });
        res.json({ success: true, data: { signals: publicSignals(signals), report, running: executor.isRunning() } });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/recovery/lookup', async (req, res) => {
    try {
        const text = String((req.body && req.body.text) || '').slice(0, 20000);
        if (!text.trim()) return res.status(400).json({ success: false, error: 'Cole uma mensagem de erro ou um código (ex.: ORA-00600).' });
        let entry = null;
        try { entry = await diagnose(req); } catch { /* consulta funciona sem diagnóstico */ }
        const items = findings.lookupText(text, entry && entry.signals, entry && entry.report);
        res.json({ success: true, data: { items } });
    } catch (err) {
        fail(res, err);
    }
});

router.get('/recovery/playbooks', (req, res) => {
    res.json({ success: true, data: playbooks.catalogList() });
});

router.post('/recovery/plan', async (req, res) => {
    try {
        const { playbook, params } = req.body || {};
        const { signals } = await diagnose(req);
        const plan = await playbooks.buildPlan(String(playbook || ''), params || {}, signals, planEnv());
        res.json({ success: true, data: stripPlan(plan) });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/recovery/execute', requireDba, async (req, res) => {
    const ctx = { user: req.session.user, role: req.session.role, ip: audit.ipOf(req) };
    try {
        const { playbook, params, hash, confirmText, acknowledge } = req.body || {};
        if (executor.isRunning()) return res.status(409).json({ success: false, error: 'Já existe um procedimento em execução.' });
        // Remonta o plano com o estado ATUAL: só executa o que o DBA revisou.
        const { signals } = await diagnose(req, { force: true });
        const plan = await playbooks.buildPlan(String(playbook || ''), params || {}, signals, planEnv());
        if (plan.hash !== hash) {
            return res.status(409).json({ success: false, error: 'O estado do banco mudou desde a revisão: o plano foi atualizado. Revise os passos e confirme de novo.', plan: stripPlan(plan) });
        }
        if (!plan.executable) {
            return res.status(400).json({ success: false, error: plan.blockers[0] || 'Este plano não pode ser executado automaticamente: copie os comandos e rode manualmente.', plan: stripPlan(plan) });
        }
        const level = plan.confirm.level;
        if (level !== 'simple' && acknowledge !== true) return res.status(400).json({ success: false, error: 'Confirme que leu os riscos do procedimento.' });
        if (level === 'dbname') {
            const want = String(plan.confirm.dbName || '').trim().toUpperCase();
            if (!want || String(confirmText || '').trim().toUpperCase() !== want) {
                return res.status(400).json({ success: false, error: `Digite o nome do banco (${want || '?'}) para confirmar.` });
            }
        }
        const jobId = executor.start(plan, ctx, {
            afterDiagnose: async () => {
                invalidate();
                const fresh = await diagnose(req, { force: true });
                return { state: fresh.signals.state, overall: fresh.report.overall, counts: fresh.report.counts };
            },
        });
        invalidate();
        res.json({ success: true, data: { jobId } });
    } catch (err) {
        fail(res, err);
    }
});

router.get('/recovery/job/:id', requireDba, (req, res) => {
    const job = executor.getJob(String(req.params.id));
    if (!job) return res.status(404).json({ success: false, error: 'Execução não encontrada.' });
    res.json({ success: true, data: job });
});

router.get('/recovery/jobs', requireDba, (req, res) => {
    res.json({ success: true, data: executor.listJobs(20) });
});

router.post('/recovery/demo-scenario', requireDba, (req, res) => {
    if (!config.demoMode) return res.status(400).json({ success: false, error: 'Disponível só no modo DEMO.' });
    try {
        demo.setScenario(String((req.body && req.body.scenario) || ''));
        invalidate();
        res.json({ success: true, data: { scenario: demo.current() } });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;

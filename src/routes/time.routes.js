/**
 * Rotas do relógio do servidor de banco x NTP:
 *  - GET  /time/status   diferença atual (todos os perfis; ?force=1 mede de novo)
 *  - POST /time/sync     sincroniza com o NTP (DBA, auditado)
 */
const express = require('express');
const { requireDba } = require('../auth');
const audit = require('../audit');
const logger = require('../logger');
const timeSync = require('../timeSync');

const router = express.Router();

router.get('/time/status', async (req, res) => {
    try {
        const data = await timeSync.getStatus({ force: req.query.force === '1' });
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/time/sync', requireDba, async (req, res) => {
    const ctx = { user: req.session.user, role: req.session.role, ip: audit.ipOf(req) };
    try {
        const data = await timeSync.syncServerClock(req.body && req.body.server, ctx);
        res.json({ success: data.success, data, error: data.success ? undefined : data.message });
    } catch (err) {
        const status = err instanceof timeSync.TimeSyncError ? err.status : 500;
        if (status === 500) logger.error('Falha na sincronização de relógio:', err.message);
        res.status(status).json({ success: false, error: err.message });
    }
});

module.exports = router;

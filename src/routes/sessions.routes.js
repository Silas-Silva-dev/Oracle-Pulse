/**
 * Rotas de sessões: locks, sessões de longa duração e kill (restrito a DBA).
 * O kill agora valida SID/SERIAL como inteiros (anti SQL injection).
 */
const express = require('express');
const { config } = require('../config');
const { runQuery, executeAdmin, ValidationError, assertPositiveInt } = require('../db');
const { requireDba } = require('../auth');
const audit = require('../audit');

const router = express.Router();

router.get('/sessions', async (req, res) => {
    try {
        const sessions = await runQuery('sessionDetails');
        res.json({ success: true, data: sessions });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/sessions/long-running', async (req, res) => {
    try {
        const sessions = await runQuery('longRunningSessions');
        res.json({ success: true, data: sessions });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/sessions/kill', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const { sid, serial } = req.body || {};
        const validSid = assertPositiveInt(sid, 'SID');
        const validSerial = assertPositiveInt(serial, 'SERIAL#');

        const sql = `ALTER SYSTEM KILL SESSION '${validSid},${validSerial}' IMMEDIATE`;
        if (config.demoMode) {
            audit.record({ action: 'kill-session', user: req.session.user, role: req.session.role, ip, detail: `[DEMO] ${sql}` });
            return res.json({ success: true, message: `Simulado KILL SESSION '${validSid},${validSerial}'` });
        }

        await executeAdmin(sql);
        audit.record({ action: 'kill-session', user: req.session.user, role: req.session.role, ip, detail: sql });
        res.json({ success: true, message: 'Sessão finalizada com sucesso' });
    } catch (err) {
        const status = err instanceof ValidationError ? 400 : 500;
        audit.record({ action: 'kill-session', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

module.exports = router;

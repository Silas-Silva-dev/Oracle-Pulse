/**
 * Rotas de dashboard e health. Usam cache curto para não sobrecarregar o banco
 * quando vários clientes atualizam no mesmo intervalo.
 */
const express = require('express');
const { config } = require('../config');
const { runQuery } = require('../db');
const dashboardService = require('../dashboardService');
const cache = require('../cache');
const alerts = require('../alerts');

const router = express.Router();

router.get('/health', async (req, res) => {
    try {
        const status = await cache.cached('health', 3000, () => runQuery('instanceStatus'));
        res.json({
            success: true,
            data: status[0],
            mode: config.demoMode ? 'DEMO' : 'LIVE',
            dbUser: config.db.user || 'SYS',
            role: req.session.role,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/dashboard', async (req, res) => {
    try {
        const data = await dashboardService.collectCached();
        res.json({ success: true, data, alerts: alerts.getActive() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/history', (req, res) => {
    res.json({ success: true, data: cache.getHistory(120) });
});

router.get('/alerts', (req, res) => {
    res.json({ success: true, data: alerts.getActive() });
});

module.exports = router;

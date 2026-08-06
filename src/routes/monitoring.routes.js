/**
 * Rotas de monitoramento de backup/recuperação e auditoria.
 */
const express = require('express');
const { runQuery } = require('../db');
const { requireDba } = require('../auth');
const cache = require('../cache');
const audit = require('../audit');

const router = express.Router();

router.get('/backup/status', async (req, res) => {
    try {
        const [mode, backups, fra] = await Promise.all([
            cache.cached('archivelogMode', 30000, () => runQuery('archivelogMode')),
            cache.cached('rmanBackups', 30000, () => runQuery('rmanBackups')),
            cache.cached('fraUsage', 30000, () => runQuery('fraUsage')),
        ]);
        res.json({ success: true, data: { mode: mode[0] || null, backups, fra: fra[0] || null } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Auditoria das ações sensíveis — restrita a DBA
router.get('/audit', requireDba, (req, res) => {
    res.json({ success: true, data: audit.getRecent(100) });
});

module.exports = router;

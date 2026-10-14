/**
 * Rotas de monitoramento de backup/recuperação e auditoria.
 */
const express = require('express');
const { config } = require('../config');
const { runQuery } = require('../db');
const { requireDba, verifyPassword } = require('../auth');
const { createRateLimiter } = require('../security');
const cache = require('../cache');
const audit = require('../audit');
const logMaintenance = require('../logMaintenance');

const router = express.Router();
const STATUS_KEYS = ['archivelogMode', 'rmanBackups', 'fraUsage'];

router.get('/backup/status', async (req, res) => {
    try {
        // "Atualizar Agora" pede ?refresh=1: sem isso o cache de 30 s devolvia os dados antigos.
        if (req.query.refresh === '1') STATUS_KEYS.forEach((k) => cache.invalidate(k));
        const [mode, backups, fra] = await Promise.all(STATUS_KEYS.map((k) => cache.cached(k, 30000, () => runQuery(k))));
        res.json({ success: true, data: { mode: mode[0] || null, backups, fra: fra[0] || null } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Auditoria das ações sensíveis — restrita a DBA
router.get('/audit', requireDba, (req, res) => {
    res.json({ success: true, data: audit.getRecent(100) });
});

// Limpar todos os logs: DBA + senha do DBA (tentativas limitadas).
const clearLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, message: 'Muitas tentativas de limpar os logs. Aguarde alguns minutos.' });

router.post('/audit/clear', requireDba, clearLimiter, async (req, res) => {
    const ctx = { user: req.session.user, role: req.session.role, ip: audit.ipOf(req) };
    const password = String((req.body && req.body.password) || '');
    const ok = password && req.session.user === config.auth.user && verifyPassword(password, config.auth.passHash);
    if (!ok) {
        audit.record({ action: 'logs-limpar', ...ctx, success: false, detail: 'senha do DBA incorreta' });
        return res.status(403).json({ success: false, error: 'Senha do DBA incorreta.' });
    }
    try {
        const r = await logMaintenance.clearAll();
        const mb = (r.bytes / 1048576).toFixed(1).replace('.', ',');
        const remote = typeof r.remote === 'number' ? ` + ${r.remote} no servidor do banco` : typeof r.remote === 'string' ? ` (servidor do banco: ${r.remote})` : '';
        const detail = `${r.files} arquivo(s), ${mb} MB${remote}${r.skipped.length ? ` · não apagados: ${r.skipped.join(', ')}` : ''}`;
        // A nova trilha começa pelo registro da limpeza (quem, quando, de onde).
        audit.record({ action: 'logs-limpos', ...ctx, success: true, detail });
        res.json({ success: true, data: r, message: `Logs limpos: ${detail}.` });
    } catch (err) {
        audit.record({ action: 'logs-limpar', ...ctx, success: false, detail: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

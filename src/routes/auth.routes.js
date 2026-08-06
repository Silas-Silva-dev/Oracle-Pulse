/**
 * Rotas de autenticação: login (com rate limit) e logout (revogação server-side).
 */
const express = require('express');
const { resolveRole, issueToken, revokeToken, requireAuth } = require('../auth');
const { createRateLimiter } = require('../security');
const audit = require('../audit');

const router = express.Router();

// Anti brute-force: no máx. 8 tentativas por IP a cada 15 min
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 8, message: 'Muitas tentativas de login. Aguarde alguns minutos.' });

router.post('/login', loginLimiter, (req, res) => {
    const { user, password } = req.body || {};
    const role = resolveRole(user, password);

    if (!role) {
        audit.record({ action: 'login', user: user || '-', ip: audit.ipOf(req), success: false, detail: 'credenciais inválidas' });
        return res.status(401).json({ success: false, error: 'Usuário ou senha incorretos' });
    }

    const token = issueToken(user, role);
    audit.record({ action: 'login', user, role, ip: audit.ipOf(req), success: true });
    res.json({ success: true, token, role });
});

router.post('/logout', requireAuth, (req, res) => {
    revokeToken(req.token);
    audit.record({ action: 'logout', user: req.session.user, role: req.session.role, ip: audit.ipOf(req) });
    res.json({ success: true });
});

module.exports = router;

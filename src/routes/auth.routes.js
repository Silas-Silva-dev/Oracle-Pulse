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

const MAX_CREDENTIAL = 256;

/** Usuário digitado por um anônimo, como vai para a auditoria/log: curto e sem quebras de linha. */
const auditName = (u) => (typeof u === 'string' && u ? u.slice(0, 64).replace(/[\x00-\x1f\x7f]/g, '?') : '-');

router.post('/login', loginLimiter, (req, res) => {
    const { user, password } = req.body || {};
    // Só texto, de tamanho razoável: objetos/arrays derrubavam o hash (erro 500) e um
    // "usuário" de 100 KB iria inteiro para a trilha de auditoria.
    if (typeof user !== 'string' || typeof password !== 'string' || user.length > MAX_CREDENTIAL || password.length > MAX_CREDENTIAL) {
        audit.record({ action: 'login', user: auditName(user), ip: audit.ipOf(req), success: false, detail: 'requisição de login inválida' });
        return res.status(400).json({ success: false, error: 'Usuário ou senha incorretos' });
    }
    const role = resolveRole(user, password);

    if (!role) {
        audit.record({ action: 'login', user: auditName(user), ip: audit.ipOf(req), success: false, detail: 'credenciais inválidas' });
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

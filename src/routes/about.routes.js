/**
 * Rotas da tela "Sobre": informações do sistema e atualização pelo GitHub.
 *   GET  /about               dados da versão/instalação (qualquer usuário)
 *   GET  /about/check-update  consulta a última release (cacheado)
 *   POST /about/update        baixa e executa o instalador oficial (DBA + senha)
 */
const express = require('express');
const { requireDba } = require('../auth');
const { createRateLimiter } = require('../security');
const audit = require('../audit');
const logger = require('../logger');
const updater = require('../updater');

const router = express.Router();

// Evita martelar a API do GitHub: guarda o resultado por 5 min.
let checkCache = { at: 0, data: null };
const CHECK_TTL = 5 * 60 * 1000;

const updateLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 6, message: 'Muitas tentativas de atualização. Aguarde alguns minutos.' });

router.get('/about', (req, res) => {
    res.json({ success: true, data: updater.about() });
});

router.get('/about/check-update', async (req, res) => {
    try {
        const force = req.query.refresh === '1';
        if (!force && checkCache.data && Date.now() - checkCache.at < CHECK_TTL) {
            return res.json({ success: true, data: checkCache.data, cached: true });
        }
        const full = await updater.checkLatest();
        const data = updater.checkLatestPublic(full); // sem referência ao repositório
        checkCache = { at: Date.now(), data };
        res.json({ success: true, data });
    } catch (err) {
        logger.warn('Verificação de atualização falhou:', err.message);
        res.status(502).json({ success: false, error: `Não foi possível verificar atualizações: ${err.message}` });
    }
});

router.post('/about/update', requireDba, updateLimiter, async (req, res) => {
    const ctx = { user: req.session.user, role: req.session.role, ip: audit.ipOf(req) };
    try {
        const result = await updater.startUpdate({ installPassword: req.body && req.body.installPassword });
        checkCache = { at: 0, data: null };
        audit.record({ action: 'atualizacao', ...ctx, success: true, detail: result.started ? `iniciada para a versão ${result.version}${result.verified ? ' (SHA-256 conferido)' : ''}` : (result.message || 'simulação') });
        res.json({ success: true, data: result });
    } catch (err) {
        const status = err.status || 500;
        audit.record({ action: 'atualizacao', ...ctx, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

module.exports = router;

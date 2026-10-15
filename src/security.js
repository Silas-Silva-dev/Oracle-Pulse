/**
 * SECURITY.JS - Middlewares de segurança sem dependências externas:
 *  - securityHeaders: equivalente "lite" ao helmet (CSP, anti-clickjacking, etc.)
 *  - jsonErrorHandler: erro não tratado vira JSON genérico (sem stack trace)
 *  - createRateLimiter: limitador de requisições em memória (anti brute-force)
 */
const logger = require('./logger');

/** Único script de terceiros: o Chart.js com versão fixa (o index.html confere o SRI). */
const CHART_JS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js';

/**
 * Cabeçalhos de segurança aplicados a todas as respostas.
 * A CSP libera só o arquivo exato do Chart.js (não o CDN inteiro: liberar o
 * domínio permitiria carregar QUALQUER pacote npm/GitHub por ele) e o CSS/fontes do
 * Font Awesome. Scripts/estilos inline continuam permitidos porque o HTML atual usa
 * handlers onclick e estilos inline.
 */
function securityHeaders(req, res, next) {
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            `script-src 'self' 'unsafe-inline' ${CHART_JS_URL}`,
            "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
            "font-src 'self' https://cdnjs.cloudflare.com data:",
            "img-src 'self' data:",
            "connect-src 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
        ].join('; ')
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // Dados do banco/servidor e o token não podem ficar em cache de navegador/proxy.
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    // HSTS só faz sentido (e só é aceito) sob HTTPS.
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.removeHeader('X-Powered-By');
    next();
}

/**
 * Erros não tratados (JSON malformado, corpo grande demais, falha inesperada):
 * resposta JSON genérica, sem stack trace nem caminhos internos (o detalhe fica no log).
 */
function jsonErrorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) logger.error(`Erro não tratado em ${req.method} ${req.path}:`, (err && (err.stack || err.message)) || err);
    const error = status === 413 ? 'Requisição grande demais.' : status < 500 ? 'Requisição inválida.' : 'Erro interno do servidor.';
    return res.status(status).json({ success: false, error });
}

/**
 * Limitador de taxa em memória por IP.
 * @param {object} opts { windowMs, max, message }
 */
function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 10, message = 'Muitas tentativas. Tente novamente mais tarde.' } = {}) {
    const hits = new Map(); // ip -> { count, resetAt }

    // Limpeza periódica para não vazar memória
    const cleanup = setInterval(() => {
        const now = Date.now();
        for (const [ip, info] of hits) {
            if (info.resetAt <= now) hits.delete(ip);
        }
    }, windowMs);
    if (cleanup.unref) cleanup.unref();

    return function rateLimiter(req, res, next) {
        const now = Date.now();
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        let info = hits.get(ip);

        if (!info || info.resetAt <= now) {
            info = { count: 0, resetAt: now + windowMs };
            hits.set(ip, info);
        }

        info.count += 1;

        if (info.count > max) {
            const retrySec = Math.ceil((info.resetAt - now) / 1000);
            res.setHeader('Retry-After', String(retrySec));
            return res.status(429).json({ success: false, error: message });
        }
        next();
    };
}

module.exports = { securityHeaders, createRateLimiter, jsonErrorHandler, CHART_JS_URL };

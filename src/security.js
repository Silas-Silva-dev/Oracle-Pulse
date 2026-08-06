/**
 * SECURITY.JS - Middlewares de segurança sem dependências externas:
 *  - securityHeaders: equivalente "lite" ao helmet (CSP, anti-clickjacking, etc.)
 *  - createRateLimiter: limitador de requisições em memória (anti brute-force)
 */

/**
 * Cabeçalhos de segurança aplicados a todas as respostas.
 * A CSP libera os CDNs usados (Chart.js, Font Awesome) e permite estilos/scripts
 * inline porque o HTML atual usa handlers onclick e estilos inline.
 */
function securityHeaders(req, res, next) {
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
            "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
            "font-src 'self' https://cdnjs.cloudflare.com data:",
            "img-src 'self' data:",
            "connect-src 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
        ].join('; ')
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '0');
    res.removeHeader('X-Powered-By');
    next();
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

module.exports = { securityHeaders, createRateLimiter };

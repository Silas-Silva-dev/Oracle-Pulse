/**
 * AUTH.JS - Autenticação baseada em token com:
 *  - Expiração de token (TTL configurável) e revogação no logout (server-side)
 *  - Limpeza periódica de tokens expirados (evita vazamento de memória)
 *  - Perfis de acesso: 'dba' (acesso total) e 'viewer' (somente leitura)
 *  - Comparação de senha em tempo constante (timingSafeEqual)
 *  - Suporte a hash legado SHA-256 e ao formato salgado scrypt (scrypt$salt$hash)
 */
const crypto = require('crypto');
const { config } = require('./config');
const logger = require('./logger');

const activeTokens = new Map(); // token -> { role, user, expiresAt }
const TTL_MS = config.auth.tokenTtlMinutes * 60 * 1000;

// Limpeza periódica de tokens expirados
const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [token, info] of activeTokens) {
        if (info.expiresAt <= now) activeTokens.delete(token);
    }
}, 60 * 1000);
if (cleanup.unref) cleanup.unref();

/** Compara dois hashes hex em tempo constante. */
function safeEqualHex(a, b) {
    const bufA = Buffer.from(String(a), 'hex');
    const bufB = Buffer.from(String(b), 'hex');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifica a senha contra o hash armazenado.
 * Aceita dois formatos:
 *   - "scrypt$<saltHex>$<hashHex>"  (recomendado, salgado)
 *   - "<sha256Hex>"                 (legado, compatibilidade)
 */
function verifyPassword(password, storedHash) {
    if (!storedHash) return false;

    if (storedHash.startsWith('scrypt$')) {
        const [, saltHex, hashHex] = storedHash.split('$');
        if (!saltHex || !hashHex) return false;
        const derived = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32).toString('hex');
        return safeEqualHex(derived, hashHex);
    }

    // Legado: SHA-256 sem salt (comparação ainda em tempo constante)
    const sha = crypto.createHash('sha256').update(password).digest('hex');
    return safeEqualHex(sha, storedHash);
}

/** Resolve qual conta/role corresponde às credenciais, ou null. */
function resolveRole(user, password) {
    if (user === config.auth.user && verifyPassword(password, config.auth.passHash)) {
        return 'dba';
    }
    if (
        config.auth.viewerUser &&
        user === config.auth.viewerUser &&
        verifyPassword(password, config.auth.viewerPassHash)
    ) {
        return 'viewer';
    }
    return null;
}

/** Cria e registra um novo token de sessão. */
function issueToken(user, role) {
    const token = crypto.randomBytes(32).toString('hex');
    activeTokens.set(token, { role, user, expiresAt: Date.now() + TTL_MS });
    return token;
}

/** Revoga (logout server-side). */
function revokeToken(token) {
    return activeTokens.delete(token);
}

function getSession(token) {
    const info = activeTokens.get(token);
    if (!info) return null;
    if (info.expiresAt <= Date.now()) {
        activeTokens.delete(token);
        return null;
    }
    return info;
}

/** Middleware: exige token válido. Anexa req.session = { role, user }. */
function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    const session = token && getSession(token);

    if (!session) {
        return res.status(401).json({ success: false, error: 'Não autorizado. Faça login primeiro.' });
    }
    req.session = session;
    req.token = token;
    next();
}

/** Middleware: exige perfil 'dba' (ações destrutivas). */
function requireDba(req, res, next) {
    if (!req.session || req.session.role !== 'dba') {
        logger.warn(`Acesso negado a ação DBA para usuário '${req.session?.user}' (role: ${req.session?.role})`);
        return res.status(403).json({ success: false, error: 'Ação restrita a administradores (DBA).' });
    }
    next();
}

module.exports = {
    resolveRole,
    issueToken,
    revokeToken,
    requireAuth,
    requireDba,
    verifyPassword,
};

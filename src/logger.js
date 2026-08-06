/**
 * LOGGER.JS - Logging estruturado simples (sem dependências externas).
 * Adiciona timestamp e nível a cada linha, preservando os emojis já usados
 * no projeto. Pode ser trocado por pino/winston no futuro sem mudar as chamadas.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function ts() {
    // ISO local sem milissegundos para legibilidade no console
    return new Date().toISOString();
}

function log(level, ...args) {
    if (LEVELS[level] < currentLevel) return;
    const prefix = `[${ts()}] [${level.toUpperCase()}]`;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(prefix, ...args);
}

module.exports = {
    debug: (...a) => log('debug', ...a),
    info: (...a) => log('info', ...a),
    warn: (...a) => log('warn', ...a),
    error: (...a) => log('error', ...a),
};

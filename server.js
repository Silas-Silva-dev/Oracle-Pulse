/**
 * SERVER.JS - Ponto de entrada do Oracle Pulse.
 * Responsável por: validar config, inicializar Oracle Client/pool, montar o
 * Express, iniciar o sampler de histórico/alertas e cuidar do shutdown gracioso.
 */
const express = require('express');
const { config, validateConfig } = require('./src/config');
const logger = require('./src/logger');
const db = require('./src/db');
const { securityHeaders } = require('./src/security');
const apiRoutes = require('./src/routes');
const dashboardService = require('./src/dashboardService');

// 1) Valida a configuração antes de qualquer coisa (fail-fast)
try {
    const warnings = validateConfig();
    (warnings || []).forEach((w) => logger.warn(w));
} catch (err) {
    logger.error(err.message);
    process.exit(1);
}

// 2) Inicializa o Oracle Client (modo thick)
db.initOracleClient();

// 3) App Express
const app = express();
app.use(securityHeaders);
app.use(express.json());
app.use('/api', apiRoutes);
app.use(express.static(config.paths.public));

// 4) Sampler de background: alimenta histórico e alertas mesmo sem ninguém olhando
let samplerId = null;
function startSampler() {
    if (config.demoMode) return;
    const intervalMs = 30 * 1000;
    samplerId = setInterval(() => {
        dashboardService.sample().catch((err) => logger.warn('Sampler falhou:', err.message));
    }, intervalMs);
    if (samplerId.unref) samplerId.unref();
}

// 5) Inicialização
const server = app.listen(config.port, async () => {
    const mode = config.demoMode ? 'MOCK/DEMO' : 'LIVE';
    if (!config.demoMode) {
        try {
            await db.ensurePool();
        } catch (err) {
            logger.error('Não foi possível criar o pool no startup:', err.message);
        }
        startSampler();
    }
    // Guardião da FRA + acompanhamento dos backups agendados (também no DEMO, simulado).
    require('./src/fraGuard').start();
    logger.info(`Oracle Pulse Dashboard rodando em http://localhost:${config.port}`);
    logger.info(`Modo: ${mode}`);
});

// 6) Shutdown gracioso
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Recebido ${signal}. Encerrando...`);
    if (samplerId) clearInterval(samplerId);
    server.close(() => logger.info('Servidor HTTP encerrado.'));
    try {
        try { require('./src/osDisk').closeSsh(); } catch { /* ignore */ }
        await db.closePool();
    } finally {
        process.exit(0);
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error('Unhandled Rejection:', reason));

module.exports = app;

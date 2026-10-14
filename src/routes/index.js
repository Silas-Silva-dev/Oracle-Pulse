/**
 * Monta todas as rotas /api. /login e /logout ficam fora do middleware de auth;
 * o restante exige token válido.
 */
const express = require('express');
const { requireAuth } = require('../auth');

const authRoutes = require('./auth.routes');
const dashboardRoutes = require('./dashboard.routes');
const storageRoutes = require('./storage.routes');
const sessionsRoutes = require('./sessions.routes');
const performanceRoutes = require('./performance.routes');
const monitoringRoutes = require('./monitoring.routes');
const memoryRoutes = require('./memory.routes');
const backupConfigRoutes = require('./backupConfig.routes');
const sqlRoutes = require('./sql.routes');
const timeRoutes = require('./time.routes');
const recoveryRoutes = require('./recovery.routes');
const protectionRoutes = require('./protection.routes');
const terminalRoutes = require('./terminal.routes');
const aboutRoutes = require('./about.routes');

const router = express.Router();

// Rotas públicas de autenticação
router.use('/', authRoutes);

// A partir daqui, tudo exige autenticação
router.use(requireAuth);
router.use('/', dashboardRoutes);
router.use('/', storageRoutes);
router.use('/', sessionsRoutes);
router.use('/', performanceRoutes);
router.use('/', monitoringRoutes);
router.use('/', memoryRoutes);
router.use('/', backupConfigRoutes);
router.use('/', sqlRoutes);
router.use('/', timeRoutes);
router.use('/', recoveryRoutes);
router.use('/', protectionRoutes);
router.use('/', terminalRoutes);
router.use('/', aboutRoutes);

module.exports = router;

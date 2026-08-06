/**
 * Rotas de performance: detalhe de SQL, plano de execução, top SQL por elapsed
 * e a otimização de tabelas (mantida exatamente como na versão original,
 * apenas restrita a perfil 'dba' e auditada).
 */
const express = require('express');
const { config } = require('../config');
const { runQuery, getConnection } = require('../db');
const { requireDba } = require('../auth');
const audit = require('../audit');
const logger = require('../logger');

const router = express.Router();

// SQL completo por SQL_ID (bind variable)
router.get('/sql/:sqlId', async (req, res) => {
    try {
        const result = await runQuery('fullSqlText', { sqlId: req.params.sqlId });
        if (result && result.length > 0) {
            res.json({ success: true, data: result[0].SQL_FULLTEXT });
        } else {
            res.status(404).json({ success: false, error: 'SQL não encontrado' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Plano de execução por SQL_ID
router.get('/sql/:sqlId/plan', async (req, res) => {
    try {
        const rows = await runQuery('sqlPlan', { sqlId: req.params.sqlId });
        if (rows && rows.length > 0) {
            const text = rows.map((r) => r.PLAN_TABLE_OUTPUT).join('\n');
            res.json({ success: true, data: text });
        } else {
            res.status(404).json({ success: false, error: 'Plano não disponível (cursor pode ter saído do cache).' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Top SQL por tempo decorrido
router.get('/performance/top-elapsed', async (req, res) => {
    try {
        const data = await runQuery('topSqlByElapsed');
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Otimização de tabelas — MANTIDA COMO NO ORIGINAL (a pedido), agora restrita a DBA
const tables = [
    'CAPA_MOVIMENTO', 'NOTAS_FISCAIS', 'NFE_HISTORICOXML', 'CADASTROS',
    'PORTADORES', 'ITENS_MOVIMENTO', 'FINANCEIRO', 'RESUMO_VENDAS_MES',
    'PRODUTOS', 'BAN_CEMITERIOMOVIMENTO', 'BAN_HISTORICOS', 'BAN_INDEXADORES',
    'BAN_MOVIMENTO', 'SIAI_ORDENS', 'SIAI_ORDENS_PRODUTOS',
    'SIAI_ORDENS_MATERIAIS', 'SIAI_ORDENS_PROCESSOS',
];

router.post('/performance/optimize', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        if (config.demoMode) {
            audit.record({ action: 'optimize-tables', user: req.session.user, role: req.session.role, ip, detail: '[DEMO]' });
            return res.json({ success: true, message: 'Otimização simulada com sucesso (Modo DEMO)!' });
        }

        const connection = await getConnection();
        try {
            logger.info('Iniciando otimização de tabelas...');
            for (const table of tables) {
                await connection.execute(`ANALYZE TABLE ${table} DELETE STATISTICS`);
                logger.info(`Tabela ${table} otimizada.`);
            }
            audit.record({ action: 'optimize-tables', user: req.session.user, role: req.session.role, ip, detail: `${tables.length} tabelas` });
            res.json({ success: true, message: 'Todas as tabelas foram otimizadas com sucesso!' });
        } finally {
            await connection.close();
        }
    } catch (err) {
        logger.error('Erro na otimização:', err.message);
        audit.record({ action: 'optimize-tables', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

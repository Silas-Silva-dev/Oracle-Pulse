/**
 * Rotas de storage: uso de tablespaces, disco do SO, e ações de DBA
 * (resize / add datafile) — agora com validação rígida (anti SQL injection)
 * e restrição a perfil 'dba'.
 */
const express = require('express');
const { config } = require('../config');
const {
    runQuery, executeAdmin, ValidationError,
    assertPositiveInt, assertKnownDatafile, assertKnownTablespace, assertSafeDatafilePath,
} = require('../db');
const { getOsDisk } = require('../osDisk');
const { requireDba } = require('../auth');
const audit = require('../audit');
const cache = require('../cache');

const router = express.Router();

// Tamanho máximo permitido por datafile (MB) — evita valores absurdos por engano
const MAX_DATAFILE_MB = 64 * 1024; // 64 GB

router.get('/storage', async (req, res) => {
    try {
        const storage = await cache.cached('storage', 5000, () => runQuery('tablespaceUsage'));
        res.json({ success: true, data: storage });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/storage/os-disk', async (req, res) => {
    try {
        const data = await getOsDisk();
        // getOsDisk retorna { error } para falhas previsíveis (SSH, parse, etc.).
        // Mantemos success:true com data.error para o frontend exibir a mensagem,
        // preservando o comportamento atual da tela de Storage.
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/storage/config', async (req, res) => {
    try {
        const [files, basePath] = await Promise.all([
            runQuery('datafilesList'),
            runQuery('defaultDataPath'),
        ]);
        res.json({ success: true, data: { files, basePath: basePath[0]?.PATH || basePath[0]?.path || '' } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/storage/resize', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const { fileName, newSizeMb } = req.body || {};
        const size = assertPositiveInt(newSizeMb, 'Novo tamanho (MB)', { min: 1, max: MAX_DATAFILE_MB });
        const validFile = await assertKnownDatafile(fileName);

        const sql = `ALTER DATABASE DATAFILE '${validFile}' RESIZE ${size}M`;
        if (config.demoMode) {
            audit.record({ action: 'resize-datafile', user: req.session.user, role: req.session.role, ip, detail: `[DEMO] ${sql}` });
            return res.json({ success: true, message: `Simulação: ${sql}` });
        }

        await executeAdmin(sql);
        cache.invalidate('storage');
        audit.record({ action: 'resize-datafile', user: req.session.user, role: req.session.role, ip, detail: sql });
        res.json({ success: true, message: 'Datafile redimensionado com sucesso!' });
    } catch (err) {
        const status = err instanceof ValidationError ? 400 : 500;
        audit.record({ action: 'resize-datafile', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

router.post('/storage/add-file', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const { tablespace, fileName, sizeMb } = req.body || {};
        const size = assertPositiveInt(sizeMb, 'Tamanho inicial (MB)', { min: 1, max: MAX_DATAFILE_MB });
        const validTs = await assertKnownTablespace(tablespace);

        // basePath real para validar o caminho do novo arquivo
        const basePathRes = await runQuery('defaultDataPath');
        const basePath = basePathRes[0]?.PATH || basePathRes[0]?.path || '';
        const validPath = assertSafeDatafilePath(fileName, config.demoMode ? '' : basePath);

        const sql = `ALTER TABLESPACE "${validTs}" ADD DATAFILE '${validPath}' SIZE ${size}M AUTOEXTEND ON NEXT 100M MAXSIZE UNLIMITED`;
        if (config.demoMode) {
            audit.record({ action: 'add-datafile', user: req.session.user, role: req.session.role, ip, detail: `[DEMO] ${sql}` });
            return res.json({ success: true, message: `Simulação: ${sql}` });
        }

        await executeAdmin(sql);
        cache.invalidate('storage');
        audit.record({ action: 'add-datafile', user: req.session.user, role: req.session.role, ip, detail: sql });
        res.json({ success: true, message: 'Novo datafile adicionado com sucesso!' });
    } catch (err) {
        const status = err instanceof ValidationError ? 400 : 500;
        audit.record({ action: 'add-datafile', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

module.exports = router;

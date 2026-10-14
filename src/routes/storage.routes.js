/**
 * Rotas de storage: uso de tablespaces, volumes do servidor, e ações de DBA
 * (resize / add datafile) com validação rígida (anti SQL injection) e
 * restrição a perfil 'dba'.
 *
 * Bancos cujos datafiles cresceram para outros discos (/u01 -> /u02 -> /u03,
 * D:\ -> E:\ -> F:\, ou disk groups ASM) são tratados por diretório: cada
 * tablespace tem um diretório ATUAL (o do datafile criado por último), que é o
 * destino padrão de um novo datafile.
 */
const express = require('express');
const { config } = require('../config');
const {
    runQuery, executeAdmin, ValidationError,
    assertPositiveInt, assertKnownDatafile, assertKnownTablespace,
} = require('../db');
const storage = require('../storage');
const sp = require('../storagePaths');
const { requireDba } = require('../auth');
const audit = require('../audit');
const cache = require('../cache');
const logger = require('../logger');

const router = express.Router();

// Tamanho máximo permitido por datafile (MB) — evita valores absurdos por engano
const MAX_DATAFILE_MB = 64 * 1024; // 64 GB

const isBadRequest = (err) => err instanceof ValidationError || err instanceof sp.PathValidationError;

// Leituras da tela (banco + df via SSH) ficam em cache; "Atualizar Agora" manda
// ?refresh=1 e as ações (redimensionar/adicionar) invalidam tudo.
const STORAGE_KEYS = ['tablespaceUsage', 'storageLayout', 'osVolumes'];
function fresh(req, keys) {
    if (req.query.refresh === '1') keys.forEach((k) => cache.invalidate(k));
}

/** Volumes para as checagens de espaço; falha na leitura não bloqueia a ação. */
async function volumesFor(bundle) {
    try {
        return (await storage.getVolumes(bundle)).volumes;
    } catch (err) {
        logger.warn('Não foi possível ler os volumes para checar espaço livre:', err.message);
        return [];
    }
}

router.get('/storage', async (req, res) => {
    try {
        fresh(req, ['tablespaceUsage']);
        const data = await cache.cached('tablespaceUsage', 60000, () => runQuery('tablespaceUsage'));
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Volumes do servidor que contêm datafiles/tempfiles (um por ponto de montagem,
// letra de unidade ou disk group ASM). Falhas previsíveis (SSH, df) voltam em
// data.warnings / data.error para a tela mostrar a mensagem.
router.get('/storage/os-disk', async (req, res) => {
    try {
        fresh(req, ['osVolumes']);
        const { volumes, warnings } = await cache.cached('osVolumes', 20000, () => storage.getVolumes());
        const data = { volumes, warnings };
        if (!volumes.length && warnings.length) data.error = warnings.join(' ');
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/storage/config', async (req, res) => {
    try {
        fresh(req, ['storageLayout']);
        const { files, layout } = await cache.cached('storageLayout', 30000, () => storage.getLayout());
        res.json({
            success: true,
            data: {
                files: files.map((f) => ({ ...f, DIR: sp.dirOf(f.FILE_NAME || f.file_name) })),
                // Compatibilidade: antes era o diretório de um datafile qualquer;
                // agora é o do datafile criado por último.
                basePath: layout.currentDir,
                layout,
            },
        });
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

        // O crescimento precisa caber no volume do PRÓPRIO arquivo.
        const bundle = await storage.getLayout();
        const row = bundle.files.find((f) => sp.fileKey(f.FILE_NAME || f.file_name) === sp.fileKey(validFile));
        if (row) sp.checkResizeSpace(validFile, row.SIZE_MB ?? row.size_mb, size, await volumesFor(bundle));

        const sql = `ALTER DATABASE DATAFILE '${validFile}' RESIZE ${size}M`;
        if (config.demoMode) {
            audit.record({ action: 'resize-datafile', user: req.session.user, role: req.session.role, ip, detail: `[DEMO] ${sql}` });
            return res.json({ success: true, message: `Simulação: ${sql}` });
        }

        await executeAdmin(sql);
        STORAGE_KEYS.forEach((k) => cache.invalidate(k));
        audit.record({ action: 'resize-datafile', user: req.session.user, role: req.session.role, ip, detail: sql });
        res.json({ success: true, message: 'Datafile redimensionado com sucesso!' });
    } catch (err) {
        const status = isBadRequest(err) ? 400 : 500;
        audit.record({ action: 'resize-datafile', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

/**
 * Adiciona um datafile. Corpo: { tablespace, directory?, fileName?, sizeMb }.
 *  - directory omitido -> diretório ATUAL do tablespace;
 *  - fileName omitido  -> próximo nome da sequência (dados63.dbf -> dados64.dbf);
 *  - fileName com caminho completo (formato antigo) continua aceito;
 *  - diretório ainda sem datafiles ("Outro diretório") precisa existir no servidor;
 *  - ASM: informar o disk group (+DATA); o nome é gerado pelo Oracle (OMF).
 */
router.post('/storage/add-file', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const { tablespace, directory, fileName, sizeMb } = req.body || {};
        const size = assertPositiveInt(sizeMb, 'Tamanho inicial (MB)', { min: 1, max: MAX_DATAFILE_MB });
        const validTs = await assertKnownTablespace(tablespace);

        const bundle = await storage.getLayout();
        const volumes = await volumesFor(bundle);
        const plan = sp.planAddDatafile({ tablespace: validTs, directory, fileName, sizeMb: size }, { layout: bundle.layout, volumes });

        if (plan.custom) {
            if (sp.pathStyle(plan.dir) === 'asm') {
                const asm = await storage.readAsmUsage([plan.dir]);
                if (!asm.mounts.length) throw new sp.PathValidationError(`Disk group ${sp.asmDiskGroup(plan.dir)} não encontrado em V$ASM_DISKGROUP.`);
                const freeMb = Math.floor(asm.mounts[0].freeBytes / 1024 / 1024);
                if (size >= freeMb) throw new sp.PathValidationError(`Espaço insuficiente no disk group ${asm.mounts[0].mount}: ${freeMb} MB livres.`);
            } else {
                const exists = await storage.dirExistsOnServer(plan.dir);
                if (exists === false) {
                    throw new sp.PathValidationError(`O diretório ${plan.dir} não existe no servidor de banco. ` +
                        'Crie-o (com permissão de escrita para o usuário do Oracle) e tente novamente.');
                }
                const disk = await storage.getDiskForPath(plan.dir).catch(() => null);
                if (disk && !disk.error && size >= disk.freeGB * 1024) {
                    throw new sp.PathValidationError(`Espaço insuficiente no volume ${disk.path}: ${disk.freeGB} GB livres.`);
                }
            }
        }

        if (config.demoMode) {
            audit.record({ action: 'add-datafile', user: req.session.user, role: req.session.role, ip, detail: `[DEMO] ${plan.sql}` });
            return res.json({ success: true, message: `Simulação: ${plan.sql}`, fullPath: plan.fullPath, sql: plan.sql });
        }

        await executeAdmin(plan.sql);
        STORAGE_KEYS.forEach((k) => cache.invalidate(k));
        audit.record({ action: 'add-datafile', user: req.session.user, role: req.session.role, ip, detail: plan.sql });
        res.json({ success: true, message: `Novo datafile criado em ${plan.fullPath}`, fullPath: plan.fullPath, sql: plan.sql });
    } catch (err) {
        const status = isBadRequest(err) ? 400 : 500;
        audit.record({ action: 'add-datafile', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

module.exports = router;

/**
 * STORAGE.JS - Mapa de armazenamento do banco (diretórios e volumes).
 * Junta o que vem do Oracle (dba_data_files, dba_temp_files, v$datafile,
 * v$asm_diskgroup) com o uso dos volumes no servidor (df / Win32_Volume).
 * As regras ficam em storagePaths.js (puras e testadas); aqui só há I/O.
 */
const os = require('os');
const { config } = require('./config');
const { runQuery } = require('./db');
const { readDiskUsage, execOnServer, psEncoded } = require('./osDisk');
const sp = require('./storagePaths');
const logger = require('./logger');

/** Datafiles com a ordem de criação; sem acesso a v$datafile, usa a lista básica. */
async function loadDatafiles() {
    try {
        return await runQuery('datafilesList');
    } catch (err) {
        if (/ORA-00942|ORA-01031|ORA-00904/.test(String(err.message))) {
            logger.warn('Sem acesso a V$DATAFILE: o diretório atual de cada tablespace será estimado pelo FILE_ID.');
            return runQuery('datafilesListBasic');
        }
        throw err;
    }
}

/** { files, layout } — lista de datafiles + mapa de diretórios/tablespaces. */
async function getLayout() {
    const [files, temps] = await Promise.all([
        loadDatafiles(),
        runQuery('tempfilesList').catch((err) => {
            logger.warn('Falha ao ler DBA_TEMP_FILES:', err.message);
            return [];
        }),
    ]);
    return { files, layout: sp.buildStorageLayout(files, temps) };
}

/** Uso dos disk groups ASM, no mesmo formato de readDiskUsage. */
async function readAsmUsage(asmDirs) {
    const usage = { mounts: [], dirMount: {}, missing: [], errors: [] };
    if (!asmDirs.length) return usage;
    try {
        const groups = await runQuery('asmDiskgroups');
        const byName = new Map((groups || []).map((g) => {
            const name = '+' + String(g.NAME || g.name).toUpperCase();
            return [name, { mount: name, totalBytes: Number(g.TOTAL_MB || g.total_mb) * 1024 * 1024, freeBytes: Number(g.FREE_MB || g.free_mb) * 1024 * 1024 }];
        }));
        const used = new Map();
        for (const d of asmDirs) {
            const g = byName.get(sp.asmDiskGroup(d));
            if (g) {
                used.set(g.mount, g);
                usage.dirMount[sp.dirKey(d)] = g.mount;
            } else {
                usage.missing.push(d);
            }
        }
        usage.mounts = [...used.values()];
    } catch (err) {
        usage.errors.push('Não foi possível ler V$ASM_DISKGROUP: ' + err.message);
    }
    return usage;
}

/** Volumes simulados para o modo DEMO (derivados dos diretórios do mock). */
function demoUsage(layout) {
    const sizes = [[219, 55], [500, 38], [1000, 420], [300, 140], [600, 250]];
    const usage = { mounts: [], dirMount: {}, missing: [], errors: [] };
    const mounts = new Map();
    for (const d of layout.dirs) {
        const st = sp.pathStyle(d.dir);
        const mount = st === 'posix' ? '/' + (d.dir.split('/')[1] || '') : st === 'asm' ? sp.asmDiskGroup(d.dir) : d.dir.slice(0, 3);
        if (!mounts.has(mount)) {
            const [total, free] = sizes[mounts.size % sizes.length];
            mounts.set(mount, { mount, totalBytes: total * 1024 ** 3, freeBytes: free * 1024 ** 3 });
        }
        usage.dirMount[sp.dirKey(d.dir)] = mount;
    }
    usage.mounts = [...mounts.values()];
    return usage;
}

function mergeUsage(a, b) {
    return {
        mounts: [...a.mounts, ...b.mounts],
        dirMount: { ...a.dirMount, ...b.dirMount },
        missing: [...a.missing, ...b.missing],
        errors: [...a.errors, ...b.errors],
    };
}

/**
 * Volumes que contêm arquivos do banco: { volumes, warnings, layout }.
 * Aceita um layout já carregado para não repetir as consultas.
 */
async function getVolumes(bundle) {
    const { layout } = bundle || await getLayout();
    if (!layout.dirs.length) return { volumes: [], warnings: ['Nenhum datafile encontrado em DBA_DATA_FILES.'], layout };

    let usage;
    if (config.demoMode) {
        usage = demoUsage(layout);
    } else {
        const dirs = layout.dirs.map((d) => d.dir);
        const asm = dirs.filter((d) => sp.pathStyle(d) === 'asm');
        const fsDirs = dirs.filter((d) => sp.pathStyle(d) !== 'asm');
        const [fsUsage, asmUsage] = await Promise.all([
            fsDirs.length ? readDiskUsage(fsDirs) : { mounts: [], dirMount: {}, missing: [], errors: [] },
            readAsmUsage(asm),
        ]);
        usage = mergeUsage(fsUsage, asmUsage);
    }
    const summary = sp.summarizeVolumes(layout, usage);
    return { ...summary, layout };
}

/**
 * Uso do volume de UM caminho qualquer (ex.: destino da FRA), no formato antigo
 * { path, totalGB, freeGB, usedPct } ou { error }.
 */
async function getDiskForPath(path) {
    const dir = sp.normalizeDir(path);
    if (config.demoMode) return { path: dir, totalGB: 500, freeGB: 120, usedPct: 76 };
    if (sp.pathStyle(dir) === 'asm') {
        const u = await readAsmUsage([dir]);
        const m = u.mounts[0];
        if (!m) return { error: u.errors[0] || `Disk group ${sp.asmDiskGroup(dir)} não encontrado.` };
        return toDisk(m);
    }
    const u = await readDiskUsage([dir]);
    const mount = u.dirMount[sp.dirKey(dir)];
    const m = u.mounts.find((x) => x.mount === mount);
    if (!m) return { error: u.errors[0] || `Diretório não encontrado no servidor: ${dir}` };
    return toDisk(m);
}

function toDisk(m) {
    const GB = 1024 ** 3;
    const usedPct = m.totalBytes > 0 ? Math.round(((m.totalBytes - m.freeBytes) / m.totalBytes) * 100) : 0;
    return { path: m.mount, totalGB: Math.round(m.totalBytes / GB), freeGB: Math.round(m.freeBytes / GB), usedPct };
}

/**
 * O diretório existe no servidor de banco? true/false, ou null quando não há
 * como verificar (ex.: banco Linux sem SSH configurado) — aí o próprio Oracle
 * valida ao criar o arquivo.
 */
async function dirExistsOnServer(dir) {
    if (config.demoMode) return true;
    const st = sp.pathStyle(dir);
    const panelWin = os.platform() === 'win32';
    let r;
    if (st === 'posix') {
        if (!config.ssh.host && panelWin) return null;
        const quoted = `'${String(dir).replace(/'/g, `'\\''`)}'`;
        r = await execOnServer(`if [ -d ${quoted} ]; then echo __OP_DIR_OK__; else echo __OP_DIR_MISSING__; fi`);
    } else if (st === 'windows') {
        if (!config.ssh.host && !panelWin) return null;
        const literal = String(dir).replace(/'/g, "''");
        r = await execOnServer(psEncoded(`if (Test-Path -LiteralPath '${literal}' -PathType Container) { '__OP_DIR_OK__' } else { '__OP_DIR_MISSING__' }`));
    } else {
        return null; // ASM: o disk group é conferido em V$ASM_DISKGROUP
    }
    const out = String(r.stdout || '');
    if (out.includes('__OP_DIR_OK__')) return true;
    if (out.includes('__OP_DIR_MISSING__')) return false;
    return null;
}

module.exports = { getLayout, getVolumes, getDiskForPath, dirExistsOnServer, readAsmUsage };

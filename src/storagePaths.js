/**
 * STORAGEPATHS.JS - Regras PURAS (sem banco e sem SO) para datafiles espalhados
 * por vários diretórios/volumes, em Linux, Windows e ASM:
 *  - estilo do caminho (posix | windows | unc | asm) e normalização;
 *  - diretório ATUAL de cada tablespace (o do datafile criado por último);
 *  - sugestão do próximo nome (dados63.dbf -> dados64.dbf);
 *  - leitura da saída de `df -kP` (Linux) e de Win32_Volume (Windows);
 *  - associação diretório -> volume e o resumo exibido no painel;
 *  - plano do "Adicionar Datafile" (destino, nome, duplicidade, espaço livre).
 * Tudo aqui é testável sem Oracle; quem consulta banco/SO é src/storage.js.
 */

class PathValidationError extends Error {}

// ---------------------------------------------------------------------------
// Caminhos
// ---------------------------------------------------------------------------

/** 'asm' (+DATA/...), 'windows' (D:\...), 'unc' (\\srv\share), 'posix' (/u01/...) ou 'unknown'. */
function pathStyle(p) {
    const s = String(p || '').trim();
    if (s.startsWith('+')) return 'asm';
    if (/^[A-Za-z]:[\\/]/.test(s)) return 'windows';
    if (s.startsWith('\\\\') || s.startsWith('//')) return 'unc';
    if (s.startsWith('/')) return 'posix';
    return 'unknown';
}

/** SO do servidor a partir de um caminho de datafile; null quando não dá para saber (ASM). */
function osFromPath(p) {
    const st = pathStyle(p);
    if (st === 'posix') return 'linux';
    if (st === 'windows' || st === 'unc') return 'windows';
    return null;
}

const isWinLike = (st) => st === 'windows' || st === 'unc';

/** Diretório de um arquivo, COM o separador final (igual ao SUBSTR/INSTR do SQL). */
function dirOf(file) {
    const s = String(file || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(0, i + 1) : '';
}

function baseName(file) {
    const s = String(file || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
}

/** Normaliza um diretório: separador do SO, sem duplicados, com separador final. */
function normalizeDir(dir) {
    let s = String(dir || '').trim();
    const st = pathStyle(s);
    if (isWinLike(st)) {
        s = s.replace(/\//g, '\\');
        const lead = st === 'unc' ? '\\\\' : '';
        s = lead + s.slice(lead.length).replace(/\\{2,}/g, '\\');
        if (!s.endsWith('\\')) s += '\\';
    } else if (st === 'posix') {
        s = s.replace(/\/{2,}/g, '/');
        if (!s.endsWith('/')) s += '/';
    } else if (st === 'asm') {
        if (!s.endsWith('/')) s += '/';
    }
    return s;
}

/** Chave de comparação: Windows e ASM não diferenciam maiúsculas/minúsculas. */
function dirKey(dir) {
    const n = normalizeDir(dir);
    const st = pathStyle(n);
    return isWinLike(st) || st === 'asm' ? n.toUpperCase() : n;
}

function fileKey(file) {
    const s = String(file || '').trim();
    const st = pathStyle(s);
    if (isWinLike(st)) return s.replace(/\//g, '\\').toUpperCase();
    if (st === 'asm') return s.toUpperCase();
    return s;
}

/** Disk group de um caminho ASM: '+DATA/ORCL/DATAFILE/' -> '+DATA'. */
function asmDiskGroup(p) {
    return String(p || '').trim().split('/')[0].toUpperCase();
}

/** Comparação "natural" (u2 < u10) para ordenar volumes e diretórios. */
function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// ---------------------------------------------------------------------------
// Validações
// ---------------------------------------------------------------------------

const FORBIDDEN_CHARS = /['"`;\r\n\x00-\x1f*?<>|]/;

/** Nome de datafile seguro: sem caminho, extensão .dbf ou .ora. */
function validateFileName(name) {
    const s = String(name || '').trim();
    if (!s) throw new PathValidationError('Informe o nome do arquivo do datafile.');
    if (/[\\/]/.test(s)) throw new PathValidationError('Informe só o nome do arquivo (o diretório é escolhido no campo "Diretório de destino").');
    if (FORBIDDEN_CHARS.test(s) || s.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9_$#.-]{0,199}$/.test(s)) {
        throw new PathValidationError('Nome de arquivo inválido: use letras, números, "_", "-" ou "." (ex.: dados64.dbf).');
    }
    if (!/\.(dbf|ora)$/i.test(s)) throw new PathValidationError('O nome do datafile deve terminar em .dbf (ou .ora).');
    return s;
}

/**
 * Diretório digitado pelo DBA ("Outro diretório"). Precisa ser absoluto, do
 * mesmo tipo dos caminhos que o banco já usa, e sem caracteres perigosos.
 * Para ASM aceita só o disk group (+DATA): o nome é gerado pelo Oracle.
 */
function validateCustomDir(dir, serverStyle) {
    const raw = String(dir || '').trim();
    if (!raw) throw new PathValidationError('Informe o diretório de destino.');
    if (FORBIDDEN_CHARS.test(raw)) throw new PathValidationError('O diretório contém caracteres não permitidos.');
    const st = pathStyle(raw);
    if (st === 'unc') throw new PathValidationError('Caminhos de rede (\\\\servidor\\pasta) não são suportados para datafiles.');
    if (st === 'unknown') {
        throw new PathValidationError('Informe um caminho absoluto, ex.: /u04/oradata/ORCL (Linux) ou E:\\ORACLE\\ORADATA\\ORCL (Windows).');
    }
    const expected = serverStyle === 'asm' ? null : serverStyle;
    if (expected && st !== 'asm' && st !== expected) {
        throw new PathValidationError(expected === 'posix'
            ? 'O banco está em Linux: informe um caminho como /u04/oradata/ORCL.'
            : 'O banco está em Windows: informe um caminho como E:\\ORACLE\\ORADATA\\ORCL.');
    }
    if (st === 'asm') {
        if (!/^\+[A-Za-z][A-Za-z0-9_]*\/?$/.test(raw)) throw new PathValidationError('Para ASM informe só o disk group, ex.: +DATA.');
        return raw.replace(/\/$/, '').toUpperCase() + '/';
    }
    const norm = normalizeDir(raw);
    const segments = norm.split(/[\\/]/).filter(Boolean);
    if (segments.some((s) => s === '..' || s === '.')) throw new PathValidationError('O diretório não pode conter "." ou "..".');
    const ok = st === 'posix'
        ? /^\/[A-Za-z0-9_.\/ +@#$-]*$/.test(norm)
        : /^[A-Za-z]:\\[A-Za-z0-9_.\\ ()+@#$-]*$/.test(norm);
    if (!ok) throw new PathValidationError('O diretório contém caracteres não permitidos.');
    return norm;
}

// ---------------------------------------------------------------------------
// Diretório atual e próximo nome
// ---------------------------------------------------------------------------

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const col = (row, name) => (row[name] !== undefined ? row[name] : row[name.toLowerCase()]);

/** Ordem de criação: creation_change# (v$datafile) e, em empate, file_id. */
function newerThan(a, b) {
    if (num(a.change) !== num(b.change)) return num(a.change) > num(b.change);
    return num(a.fileId) > num(b.fileId);
}

/**
 * Próximo nome livre no diretório, seguindo o padrão do último arquivo:
 * dados63.dbf -> dados64.dbf, DADOS_09.DBF -> DADOS_10.DBF, users.dbf -> users02.dbf.
 * Nomes OMF (o1_mf_...) viram <tablespace>01.dbf.
 */
function suggestNextFileName(lastFile, tablespace, dir, existingKeys) {
    let base = baseName(lastFile);
    let ext = (/\.(dbf|ora)$/i.exec(base) || [])[0];
    if (!ext) ext = '.dbf';
    let stem = base.slice(0, base.length - (base.toLowerCase().endsWith(ext.toLowerCase()) ? ext.length : 0));
    if (/^o1_mf_/i.test(stem) || !stem || !/^[A-Za-z0-9][A-Za-z0-9_$#.-]*$/.test(stem)) {
        stem = String(tablespace || 'datafile').toLowerCase().replace(/[^a-z0-9_]/g, '') + '01';
        ext = '.dbf';
    }
    const m = /^(.*?)(\d+)$/.exec(stem);
    let prefix = stem;
    let n = 1;
    let width = 2;
    if (m) {
        prefix = m[1];
        n = parseInt(m[2], 10) + 1;
        width = m[2].length;
    } else {
        n = 2;
    }
    for (let i = 0; i < 10000; i++, n++) {
        const candidate = prefix + String(n).padStart(width, '0') + ext;
        if (!existingKeys || !existingKeys.has(fileKey(normalizeDir(dir) + candidate))) return candidate;
    }
    return prefix + Date.now() + ext;
}

/**
 * Monta o mapa de armazenamento a partir das linhas de dba_data_files
 * (datafilesList) e dba_temp_files (tempfilesList).
 */
function buildStorageLayout(dataRows, tempRows) {
    const dirs = new Map();       // dirKey -> info do diretório
    const tablespaces = new Map(); // nome -> info do tablespace
    const fileKeys = new Set();
    let newest = null;

    const touchDir = (dir, kind) => {
        const key = dirKey(dir);
        if (!dirs.has(key)) {
            dirs.set(key, { dir: normalizeDir(dir), style: pathStyle(dir), kinds: [], files: 0, sizeMb: 0, ts: new Map() });
        }
        const d = dirs.get(key);
        if (!d.kinds.includes(kind)) d.kinds.push(kind);
        return d;
    };

    for (const row of dataRows || []) {
        const file = String(col(row, 'FILE_NAME') || '');
        if (!file) continue;
        const name = String(col(row, 'TABLESPACE_NAME') || '');
        const sizeMb = num(col(row, 'SIZE_MB'));
        const info = { file, change: col(row, 'CREATION_CHANGE'), fileId: col(row, 'FILE_ID') };
        fileKeys.add(fileKey(file));

        const d = touchDir(dirOf(file), 'data');
        d.files += 1;
        d.sizeMb += sizeMb;
        const dts = d.ts.get(name) || { name, files: 0, sizeMb: 0 };
        dts.files += 1;
        dts.sizeMb += sizeMb;
        d.ts.set(name, dts);

        if (!tablespaces.has(name)) tablespaces.set(name, { name, files: 0, sizeMb: 0, latest: null, dirKeys: [] });
        const t = tablespaces.get(name);
        t.files += 1;
        t.sizeMb += sizeMb;
        if (!t.dirKeys.includes(dirKey(d.dir))) t.dirKeys.push(dirKey(d.dir));
        if (!t.latest || newerThan(info, t.latest)) t.latest = info;
        if (!newest || newerThan(info, newest)) newest = info;
    }
    for (const row of tempRows || []) {
        const file = String(col(row, 'FILE_NAME') || '');
        if (!file) continue;
        const name = String(col(row, 'TABLESPACE_NAME') || '');
        const sizeMb = num(col(row, 'SIZE_MB'));
        fileKeys.add(fileKey(file));
        const d = touchDir(dirOf(file), 'temp');
        d.files += 1;
        d.sizeMb += sizeMb;
        const dts = d.ts.get(name) || { name, files: 0, sizeMb: 0, temp: true };
        dts.files += 1;
        dts.sizeMb += sizeMb;
        d.ts.set(name, dts);
    }

    // Estilo predominante do servidor (ignora ASM, que não revela o SO).
    const counts = {};
    for (const d of dirs.values()) counts[d.style] = (counts[d.style] || 0) + d.files;
    const fsStyles = ['posix', 'windows'].filter((s) => counts[s]);
    let serverStyle = fsStyles.sort((a, b) => counts[b] - counts[a])[0] || null;
    if (!serverStyle && counts.asm) serverStyle = 'asm';

    const dirList = [...dirs.values()]
        .sort((a, b) => naturalCompare(a.dir, b.dir))
        .map((d) => ({
            dir: d.dir,
            style: d.style,
            kinds: d.kinds,
            files: d.files,
            sizeMb: Math.round(d.sizeMb),
            tablespaces: [...d.ts.values()]
                .sort((a, b) => naturalCompare(a.name, b.name))
                .map((t) => ({ name: t.name, files: t.files, sizeMb: Math.round(t.sizeMb), temp: !!t.temp })),
        }));

    const tsList = [...tablespaces.values()]
        .sort((a, b) => naturalCompare(a.name, b.name))
        .map((t) => {
            const currentDir = normalizeDir(dirOf(t.latest.file));
            return {
                name: t.name,
                files: t.files,
                sizeMb: Math.round(t.sizeMb),
                currentDir,
                latestFile: t.latest.file,
                dirs: t.dirKeys.map((k) => dirs.get(k).dir),
                suggestedName: pathStyle(currentDir) === 'asm' ? '' : suggestNextFileName(t.latest.file, t.name, currentDir, fileKeys),
            };
        });

    const layout = {
        serverStyle,
        currentDir: newest ? normalizeDir(dirOf(newest.file)) : '',
        dirs: dirList,
        tablespaces: tsList,
    };
    // Uso interno (duplicidade de nomes); fora do JSON enviado ao navegador.
    Object.defineProperty(layout, 'fileKeys', { value: fileKeys, enumerable: false });
    return layout;
}

// ---------------------------------------------------------------------------
// Volumes (df / Win32_Volume / ASM)
// ---------------------------------------------------------------------------

/**
 * Linhas de `df -kP` -> [{ filesystem, mount, totalBytes, freeBytes }].
 * Localiza a sequência "total usado disponível uso%" em vez de contar colunas,
 * porque o nome do sistema de arquivos (ex.: compartilhamento de rede) e o
 * ponto de montagem podem conter espaços. Ignora o cabeçalho (qualquer idioma).
 */
const DF_LINE = /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+%|-)\s+(.+?)\s*$/;
function parseDfLines(stdout) {
    const out = [];
    for (const line of String(stdout || '').split(/\r?\n/)) {
        const m = DF_LINE.exec(line.trim());
        if (!m) continue;
        out.push({ filesystem: m[1], mount: m[6], totalBytes: Number(m[2]) * 1024, freeBytes: Number(m[4]) * 1024 });
    }
    return out;
}

/**
 * Saída do comando por diretório (um bloco "@@OPDF@@<dir>" seguido da linha
 * do df). Mapeia cada diretório ao seu ponto de montagem EXATO (o df resolve),
 * e lista os que não existem no servidor.
 */
function parseDfByDir(stdout) {
    const mounts = new Map();
    const dirMount = {};
    const missing = [];
    let current = null;
    for (const line of String(stdout || '').split(/\r?\n/)) {
        if (line.startsWith('@@OPDF@@')) {
            if (current !== null && !dirMount[dirKey(current)]) missing.push(current);
            current = line.slice(8).trim();
            continue;
        }
        if (current === null) continue;
        const [entry] = parseDfLines(line);
        if (entry) {
            mounts.set(entry.mount, entry);
            dirMount[dirKey(current)] = entry.mount;
        }
    }
    if (current !== null && !dirMount[dirKey(current)]) missing.push(current);
    return { mounts: [...mounts.values()], dirMount, missing };
}

/** JSON de Win32_Volume (Name/Capacity/FreeSpace) -> [{ mount, totalBytes, freeBytes }]. */
function parseWinVolumes(stdout) {
    let data;
    try { data = JSON.parse(String(stdout || '').trim()); } catch { return []; }
    const list = Array.isArray(data) ? data : [data];
    const out = [];
    for (const v of list) {
        if (!v || !v.Name) continue;
        const name = String(v.Name);
        const total = Number(v.Capacity);
        const free = Number(v.FreeSpace);
        if (name.startsWith('\\\\?\\') || !Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) continue;
        out.push({ mount: normalizeDir(name), totalBytes: total, freeBytes: free });
    }
    return out;
}

/** Ponto de montagem (mais específico) que contém o diretório. */
function findMount(dir, mounts) {
    const d = normalizeDir(dir);
    const st = pathStyle(d);
    let best = null;
    for (const m of mounts) {
        const mount = String(m.mount || m);
        let ok;
        if (isWinLike(st)) {
            ok = d.toUpperCase().startsWith(normalizeDir(mount).toUpperCase());
        } else {
            const mm = mount.endsWith('/') ? mount : mount + '/';
            ok = mount === '/' || d.startsWith(mm);
        }
        if (ok && (!best || String(best.mount || best).length < mount.length)) best = m;
    }
    return best;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const gb = (bytes) => (bytes >= 10 * GB ? Math.round(bytes / GB) : Math.round((bytes / GB) * 10) / 10);

/**
 * Junta o mapa de diretórios com o uso dos volumes:
 *  usage = { mounts: [{ mount, totalBytes, freeBytes }], dirMount: { dirKey: mount }, missing: [dir], errors: [msg] }
 * Retorna { volumes, warnings }, um volume por ponto de montagem que contém
 * arquivos do banco, com os diretórios/tablespaces e para quem é o destino atual.
 */
function summarizeVolumes(layout, usage) {
    const byMount = new Map((usage.mounts || []).map((m) => [m.mount, m]));
    const volumes = new Map();
    const warnings = [...(usage.errors || [])];

    for (const d of layout.dirs) {
        const mount = (usage.dirMount || {})[dirKey(d.dir)];
        if (!mount || !byMount.has(mount)) continue;
        if (!volumes.has(mount)) {
            const m = byMount.get(mount);
            const usedPct = m.totalBytes > 0 ? Math.round(((m.totalBytes - m.freeBytes) / m.totalBytes) * 100) : 0;
            volumes.set(mount, {
                mount,
                kind: pathStyle(mount) === 'asm' ? 'asm' : 'fs',
                totalGB: gb(m.totalBytes),
                freeGB: gb(m.freeBytes),
                freeMb: Math.floor(m.freeBytes / MB),
                usedPct,
                dirs: [],
                currentFor: [],
            });
        }
        volumes.get(mount).dirs.push({ dir: d.dir, kinds: d.kinds, files: d.files, tablespaces: d.tablespaces });
    }
    for (const t of layout.tablespaces) {
        const mount = (usage.dirMount || {})[dirKey(t.currentDir)];
        if (mount && volumes.has(mount)) volumes.get(mount).currentFor.push(t.name);
    }
    for (const dir of usage.missing || []) {
        warnings.push(`Diretório não encontrado no servidor: ${dir}`);
    }
    return { volumes: [...volumes.values()].sort((a, b) => naturalCompare(a.mount, b.mount)), warnings };
}

/** Volume (do resumo) que contém o diretório, ou null. */
function volumeForDir(volumes, dir) {
    const key = dirKey(dir);
    for (const v of volumes || []) {
        if (v.dirs.some((d) => dirKey(d.dir) === key)) return v;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Plano das ações de storage
// ---------------------------------------------------------------------------

/**
 * Decide destino, nome e SQL do "Adicionar Datafile".
 *  input  = { tablespace, directory?, fileName?, sizeMb }   (sizeMb já validado)
 *  ctx    = { layout, volumes? }
 * Sem `directory` usa o diretório ATUAL do tablespace. `fileName` com caminho
 * completo (formato antigo da API) também é aceito.
 * Retorna { sql, fullPath, dir, custom, volume } — custom=true quando o
 * diretório ainda não tem datafiles (o chamador confere se existe no servidor).
 */
function planAddDatafile(input, ctx) {
    const { layout } = ctx;
    const ts = layout.tablespaces.find((t) => t.name === input.tablespace);
    if (!ts) throw new PathValidationError('Tablespace sem datafiles conhecidos.');

    let dir;
    let name = input.fileName ? String(input.fileName).trim() : '';
    if (input.directory) {
        dir = String(input.directory).trim();
    } else if (name && /[\\/]/.test(name)) {
        dir = dirOf(name);
        name = baseName(name);
    } else {
        dir = ts.currentDir;
    }

    const known = layout.dirs.find((d) => dirKey(d.dir) === dirKey(dir) && d.kinds.includes('data'));
    const custom = !known;
    dir = known ? known.dir : validateCustomDir(dir, layout.serverStyle);
    const volume = volumeForDir(ctx.volumes, dir);
    const size = Number(input.sizeMb);

    let fullPath;
    if (pathStyle(dir) === 'asm') {
        fullPath = asmDiskGroup(dir); // ASM/OMF: o Oracle gera o nome do arquivo
    } else {
        if (!name) name = ts.currentDir && dirKey(ts.currentDir) === dirKey(dir)
            ? ts.suggestedName
            : suggestNextFileName(ts.latestFile, ts.name, dir, layout.fileKeys);
        name = validateFileName(name);
        fullPath = dir + name;
        if (layout.fileKeys && layout.fileKeys.has(fileKey(fullPath))) {
            throw new PathValidationError(`Já existe um datafile em ${fullPath}. Escolha outro nome.`);
        }
    }
    if (FORBIDDEN_CHARS.test(fullPath)) throw new PathValidationError('Caminho do datafile contém caracteres não permitidos.');
    if (volume && Number.isFinite(size) && size >= volume.freeMb) {
        throw new PathValidationError(`Espaço insuficiente no volume ${volume.mount}: ${volume.freeMb} MB livres para um arquivo de ${size} MB.`);
    }

    const sql = `ALTER TABLESPACE "${ts.name}" ADD DATAFILE '${fullPath}' SIZE ${size}M AUTOEXTEND ON NEXT 100M MAXSIZE UNLIMITED`;
    return { sql, fullPath, dir, custom, volume };
}

/** Confere se o crescimento de um RESIZE cabe no volume do arquivo. */
function checkResizeSpace(fileName, currentMb, newMb, volumes) {
    const growth = Number(newMb) - Number(currentMb);
    if (!(growth > 0)) return null;
    const volume = volumeForDir(volumes, dirOf(fileName));
    if (volume && growth >= volume.freeMb) {
        throw new PathValidationError(`Espaço insuficiente no volume ${volume.mount}: o arquivo cresceria ${Math.round(growth)} MB e há ${volume.freeMb} MB livres.`);
    }
    return volume;
}

module.exports = {
    PathValidationError,
    pathStyle,
    osFromPath,
    dirOf,
    baseName,
    normalizeDir,
    dirKey,
    fileKey,
    asmDiskGroup,
    validateFileName,
    validateCustomDir,
    suggestNextFileName,
    buildStorageLayout,
    parseDfLines,
    parseDfByDir,
    parseWinVolumes,
    findMount,
    summarizeVolumes,
    volumeForDir,
    planAddDatafile,
    checkResizeSpace,
};

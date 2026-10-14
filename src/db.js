/**
 * DB.JS - Camada de acesso ao Oracle:
 *  - Inicialização do Oracle Client (thick) e do pool de conexões
 *  - getConnection() resiliente (garante pool, evita corrida e crash)
 *  - runQuery(name, binds) usando o dicionário de queries (ou mocks em DEMO)
 *  - Validadores/sanitizadores para os comandos DDL (resize/add datafile/kill),
 *    fechando o vetor de SQL injection das versões anteriores
 *  - closePool() para shutdown gracioso
 */
const oracledb = require('oracledb');
const { config } = require('./config');
const logger = require('./logger');
const queries = require('./queries');
const mockData = require('./mockData');

let pool = null;
let poolPromise = null;

/**
 * Inicializa o Oracle Client.
 *  - Se ORACLE_CLIENT_PATH estiver definido, ativa o modo THICK (precisa do
 *    Oracle Client 64-bit instalado no caminho informado).
 *  - Se estiver vazio, usa o modo THIN (padrão do node-oracledb 6+), que NÃO
 *    requer Oracle Client. É o ideal para o painel rodando no Windows acessando
 *    um banco Linux — foi validado e funciona normalmente.
 */
function initOracleClient() {
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
    oracledb.fetchAsString = [oracledb.CLOB];

    if (!config.db.clientPath) {
        logger.info('Oracle Client não configurado (ORACLE_CLIENT_PATH vazio) — usando modo THIN (sem client).');
        return;
    }
    try {
        oracledb.initOracleClient({ libDir: config.db.clientPath });
        logger.info(`Oracle Client (64-bit) inicializado em: ${config.db.clientPath} (modo THICK).`);
    } catch (err) {
        logger.warn(`Falha ao carregar o Oracle Client em "${config.db.clientPath}": ${err.message}`);
        logger.warn('Continuando em modo THIN (sem Oracle Client) — o painel funciona normalmente assim.');
    }
}

async function initPool() {
    const isSys = config.db.isSys;
    const poolOptions = {
        user: isSys ? 'SYS' : config.db.user,
        password: config.db.password,
        connectString: config.db.connectString,
        poolMin: config.db.pool.min,
        poolMax: config.db.pool.max,
        poolIncrement: config.db.pool.increment,
    };
    if (isSys) {
        poolOptions.privilege = oracledb.SYSDBA;
        logger.info('Tentando conexão como SYSDBA...');
    }
    // Sessões do painel identificáveis em V$SESSION (MODULE = 'Oracle Pulse').
    poolOptions.sessionCallback = (conn, requestedTag, done) => {
        try { conn.module = 'Oracle Pulse'; } catch { /* atributo não suportado: segue */ }
        done();
    };
    pool = await oracledb.createPool(poolOptions);
    logger.info('Pool de conexões Oracle criado com sucesso.');
    return pool;
}

/**
 * Garante um pool válido sem corrida de concorrência. Se a criação falhar,
 * limpa o estado para permitir nova tentativa na próxima chamada.
 */
async function ensurePool() {
    if (config.demoMode) return null;
    if (pool) return pool;
    if (!poolPromise) {
        poolPromise = initPool().catch((err) => {
            poolPromise = null;
            throw err;
        });
    }
    return poolPromise;
}

async function getConnection() {
    const p = await ensurePool();
    if (!p) throw new Error('Pool de conexões indisponível.');
    return p.getConnection();
}

/**
 * Marca as consultas do painel com um comentário inicial: o DBA as reconhece em
 * V$SQL/V$SQLSTATS e o Top SQL do painel as separa das consultas da aplicação.
 */
const SQL_TAG = '/* OraclePulse */ ';
function tag(sql) {
    const s = String(sql).replace(/^\s+/, '');
    return s.startsWith(SQL_TAG) ? s : SQL_TAG + s;
}

/** Executa uma query nomeada do dicionário (ou retorna mock em DEMO). */
async function runQuery(queryName, binds = {}) {
    if (config.demoMode) {
        return mockData[queryName] || [];
    }
    const sql = queries[queryName];
    if (!sql) throw new Error(`Query desconhecida: ${queryName}`);

    let connection;
    try {
        connection = await getConnection();
        const result = await connection.execute(tag(sql), binds);
        return result.rows;
    } catch (err) {
        logger.error(`Erro na query [${queryName}]:`, err.message);
        throw err;
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                logger.error('Erro ao retornar conexão ao pool:', err.message);
            }
        }
    }
}

/** Executa um comando DDL/admin já validado (resize, add datafile, kill...). */
async function executeAdmin(sql) {
    let connection;
    try {
        connection = await getConnection();
        await connection.execute(sql);
    } finally {
        if (connection) await connection.close();
    }
}

// ==========================================================================
// Terminal SQL — execução de scripts ad-hoc (DBA), com resultados estruturados
// ==========================================================================

const TERMINAL_MAX_ROWS = 1000; // teto de linhas devolvidas por SELECT

/**
 * Divide um script em comandos, respeitando strings, comentários e blocos
 * PL/SQL. Um bloco PL/SQL anônimo (BEGIN/DECLARE) ou um CREATE de objeto
 * (PROCEDURE/FUNCTION/TRIGGER/PACKAGE/TYPE) é tratado como UM comando único
 * (terminador "/" do SQL*Plus é removido). O resto é separado por ";".
 */
function splitStatements(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];

    const isPlsql = /^\s*(declare|begin)\b/i.test(trimmed) ||
        /^\s*create\s+(or\s+replace\s+)?(procedure|function|trigger|package|type)\b/i.test(trimmed);
    if (isPlsql) return [trimmed.replace(/\s*\/\s*$/, '').trim()];

    const stmts = [];
    let cur = '';
    let i = 0;
    const N = text.length;
    while (i < N) {
        const c = text[i];
        const n = i + 1 < N ? text[i + 1] : '';
        if (c === "'") { // literal string (trata '' como aspa escapada)
            cur += c; i++;
            while (i < N) {
                cur += text[i];
                if (text[i] === "'") {
                    if (text[i + 1] === "'") { cur += "'"; i += 2; continue; }
                    i++; break;
                }
                i++;
            }
            continue;
        }
        if (c === '-' && n === '-') { // comentário de linha
            const e = text.indexOf('\n', i);
            const end = e === -1 ? N : e;
            cur += text.slice(i, end); i = end; continue;
        }
        if (c === '/' && n === '*') { // comentário de bloco
            const e = text.indexOf('*/', i + 2);
            const end = e === -1 ? N : e + 2;
            cur += text.slice(i, end); i = end; continue;
        }
        if (c === ';') { if (cur.trim()) stmts.push(cur.trim()); cur = ''; i++; continue; }
        cur += c; i++;
    }
    if (cur.trim()) stmts.push(cur.trim());
    return stmts;
}

/** Converte um valor de coluna em algo serializável em JSON com segurança. */
function sanitizeValue(v) {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return v;
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return '0x' + v.toString('hex').slice(0, 256);
    try { return String(v); } catch { return '(objeto não exibível)'; }
}

function statusMessage(stmt, rowsAffected) {
    const verb = ((stmt.match(/^\s*(\w+)/) || [])[1] || '').toUpperCase();
    if (typeof rowsAffected === 'number' && /^(INSERT|UPDATE|DELETE|MERGE)$/.test(verb)) {
        return `${rowsAffected} linha(s) afetada(s).`;
    }
    if (/^(BEGIN|DECLARE)$/.test(verb)) return 'Bloco PL/SQL executado com sucesso.';
    if (verb === 'CREATE') return 'Objeto criado com sucesso.';
    return 'Comando executado com sucesso.';
}

async function runOneStatement(conn, stmt) {
    try {
        const result = await conn.execute(stmt, [], {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            autoCommit: true,
            maxRows: TERMINAL_MAX_ROWS,
        });
        if (result.metaData) { // é uma consulta (SELECT/WITH)
            const columns = result.metaData.map((m) => m.name);
            const rows = (result.rows || []).map((r) => {
                const o = {};
                for (const k of columns) o[k] = sanitizeValue(r[k]);
                return o;
            });
            return { statement: stmt, type: 'rows', columns, rows, rowCount: rows.length, truncated: rows.length >= TERMINAL_MAX_ROWS };
        }
        return { statement: stmt, type: 'status', rowsAffected: result.rowsAffected ?? 0, message: statusMessage(stmt, result.rowsAffected) };
    } catch (err) {
        return { statement: stmt, type: 'error', error: err.message };
    }
}

/**
 * Executa um script SQL/PLSQL ad-hoc e devolve um array de resultados (um por
 * comando). Cada item: { type: 'rows'|'status'|'error', ... }. Não lança por
 * erro de SQL (o erro vira um item type:'error'); lança apenas em falha de
 * infraestrutura (sem conexão). O chamador é responsável por exigir DBA/auditar.
 */
async function executeScript(sqlText) {
    if (config.demoMode) {
        const stmts = splitStatements(sqlText);
        return stmts.map((s) => /^\s*(select|with)\b/i.test(s)
            ? { statement: s, type: 'rows', columns: ['INFO'], rows: [{ INFO: '[DEMO] SELECT simulado — sem banco real.' }], rowCount: 1, truncated: false }
            : { statement: s, type: 'status', rowsAffected: 0, message: '[DEMO] Comando simulado (sem banco real).' });
    }
    const statements = splitStatements(sqlText);
    if (statements.length === 0) throw new ValidationError('Nenhum comando SQL encontrado.');

    const results = [];
    let connection;
    try {
        connection = await getConnection();
        for (const stmt of statements) {
            results.push(await runOneStatement(connection, stmt));
        }
    } finally {
        if (connection) {
            try { await connection.close(); } catch (e) { logger.warn('Erro ao fechar conexão do terminal:', e.message); }
        }
    }
    return results;
}

async function closePool() {
    if (pool) {
        try {
            await pool.close(10);
            logger.info('Pool de conexões Oracle fechado.');
        } catch (err) {
            logger.warn('Erro ao fechar pool:', err.message);
        } finally {
            pool = null;
            poolPromise = null;
        }
    }
}

// ==========================================================================
// Validadores / sanitizadores para comandos DDL (defesa contra SQL injection)
// ==========================================================================

class ValidationError extends Error {}

/** Inteiro positivo dentro de um limite. */
function assertPositiveInt(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new ValidationError(`${label} inválido: deve ser um inteiro entre ${min} e ${max}.`);
    }
    return n;
}

/**
 * Valida o nome de um datafile contra a lista REAL de datafiles do banco,
 * eliminando a interpolação livre. Em DEMO aceita qualquer nome plausível.
 */
async function assertKnownDatafile(fileName) {
    if (typeof fileName !== 'string' || fileName.trim() === '') {
        throw new ValidationError('Nome do datafile é obrigatório.');
    }
    if (config.demoMode) return fileName;

    const rows = await runQuery('datafilesList');
    const known = new Set(rows.map((r) => (r.FILE_NAME || r.file_name)));
    if (!known.has(fileName)) {
        throw new ValidationError('Datafile não reconhecido pelo banco. Operação bloqueada.');
    }
    return fileName;
}

/** Valida nome de tablespace contra a lista real do banco. */
async function assertKnownTablespace(name) {
    if (typeof name !== 'string' || name.trim() === '') {
        throw new ValidationError('Tablespace é obrigatório.');
    }
    if (config.demoMode) return name;

    const rows = await runQuery('tablespaceUsage');
    const known = new Set(rows.map((r) => (r.TABLESPACE_NAME || r.tablespace_name)));
    if (!known.has(name)) {
        throw new ValidationError('Tablespace não reconhecida pelo banco. Operação bloqueada.');
    }
    return name;
}

/**
 * Valida um caminho de novo datafile: precisa começar pelo basePath real do
 * banco e conter apenas caracteres seguros para path/arquivo. Bloqueia aspas,
 * ponto-e-vírgula e outras tentativas de quebra de comando.
 */
function assertSafeDatafilePath(fullPath, basePath) {
    if (typeof fullPath !== 'string' || fullPath.trim() === '') {
        throw new ValidationError('Caminho do datafile é obrigatório.');
    }
    // Sem aspas, ponto-e-vírgula, quebras de linha ou caracteres de controle
    if (/['";\n\r]/.test(fullPath) || /[\x00-\x1f]/.test(fullPath)) {
        throw new ValidationError('Caminho do datafile contém caracteres não permitidos.');
    }
    if (basePath && !fullPath.startsWith(basePath)) {
        throw new ValidationError('O datafile deve ser criado dentro do diretório padrão do banco.');
    }
    if (!/\.(dbf|DBF)$/.test(fullPath)) {
        throw new ValidationError('O nome do datafile deve terminar em .DBF');
    }
    return fullPath;
}

module.exports = {
    oracledb,
    initOracleClient,
    initPool,
    ensurePool,
    getConnection,
    runQuery,
    tag,
    SQL_TAG,
    executeAdmin,
    executeScript,
    closePool,
    // validadores
    ValidationError,
    assertPositiveInt,
    assertKnownDatafile,
    assertKnownTablespace,
    assertSafeDatafilePath,
};

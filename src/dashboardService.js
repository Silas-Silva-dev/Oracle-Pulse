/**
 * DASHBOARDSERVICE.JS - Agrega os dados do dashboard num único ponto,
 * alimentando o histórico (tendência) e o motor de alertas. É chamado tanto
 * pelas rotas (com cache curto) quanto pelo sampler de background.
 *
 * Carga no banco: cada consulta tem o seu ritmo (TTL). O que muda devagar —
 * Top SQL, memória, métricas de 60 s do V$SYSMETRIC — não vai ao banco a cada
 * atualização da tela, não importa quantos navegadores estejam abertos.
 */
const { runQuery } = require('./db');
const { getOsMemory } = require('./osDisk');
const storage = require('./storage');
const cache = require('./cache');
const alerts = require('./alerts');
const logger = require('./logger');

// Leituras de SO (SSH) e da FRA para os alertas: a cada 60 s basta (disco e RAM
// não mudam em segundos). As telas Storage/Memória têm "Atualizar Agora".
const OS_TTL = 60000;
// Todos os volumes com datafiles/tempfiles (não só o do primeiro datafile).
const cachedOsVolumes = () => cache.cached('osVolumes', OS_TTL, () => storage.getVolumes());
const cachedOsMemory = () => cache.cached('osMemory', OS_TTL, getOsMemory);

// Intervalo mínimo entre idas ao banco por consulta (ms).
const QUERY_TTL = {
    sessionSummary: 5000,
    sqlCommands: 5000,
    waitClasses: 15000,
    systemMetrics: 30000,      // V$SYSMETRIC (grupo 2) só muda a cada 60 s
    waitEvents: 30000,
    memoryUsage: 30000,
    sessionMemoryUsage: 30000,
    topSql: 60000,             // varre V$SQLSTATS: a mais cara da tela
};
const TABLESPACE_TTL = 60000;  // dba_free_space: mesma chave da tela Storage
const MONITORING_EVERY_MS = 25000;

const q = (name) => cache.cached(`dash:${name}`, QUERY_TTL[name], () => runQuery(name));

/** Coleta o snapshot completo do dashboard. */
async function collect() {
    const [sessions, sessionMem, sqlCommands, waitClasses, systemMetrics, waits, topSql, memory] = await Promise.all([
        q('sessionSummary'),
        q('sessionMemoryUsage'),
        q('sqlCommands'),
        q('waitClasses'),
        q('systemMetrics'),
        q('waitEvents'),
        q('topSql'),
        q('memoryUsage'),
    ]);

    const data = {
        sessions,
        sessionMem,
        sqlCommands: sqlCommands[0],
        waitClasses,
        systemMetrics,
        waits,
        topSql,
        memory: memory[0],
    };

    maybeUpdateMonitoring(data);
    return data;
}

// Histórico (amostras a cada ~30 s) e alertas: no máximo a cada 25 s, por mais
// que a tela atualize — antes rodava a cada refresh, com tablespaces + SSH junto.
let lastMonitoring = 0;
function maybeUpdateMonitoring(data) {
    const now = Date.now();
    if (now - lastMonitoring < MONITORING_EVERY_MS) return;
    lastMonitoring = now;
    updateMonitoring(data).catch((err) => logger.warn('Falha ao atualizar histórico/alertas:', err.message));
}

/** Atualiza histórico de tendência e avalia alertas (não bloqueia a resposta). */
async function updateMonitoring(data) {
    const activeSessions = data.sessions?.find((s) => s.STATUS === 'ACTIVE')?.COUNT || 0;
    const blockedSessions = data.sqlCommands?.BLOCKED_SESSIONS || 0;
    const memoryPct = data.memory?.USED_PCT ?? data.memory?.used_pct ?? 0;

    let tablespaces = [];
    let vols = null;
    let osMemory = null;
    let fra = null;
    try {
        [tablespaces, vols, osMemory, fra] = await Promise.all([
            cache.cached('tablespaceUsage', TABLESPACE_TTL, () => runQuery('tablespaceUsage')),
            cachedOsVolumes().catch(() => null),
            cachedOsMemory().catch(() => null),
            cache.cached('fraUsage', OS_TTL, () => runQuery('fraUsage')).catch(() => null),
        ]);
    } catch {
        tablespaces = [];
    }

    const maxTsPct = tablespaces.reduce((m, t) => Math.max(m, t.USED_PCT ?? t.used_pct ?? 0), 0);

    cache.addHistorySample({
        activeSessions,
        blockedSessions,
        memoryPct: Number(memoryPct) || 0,          // ratio Oracle (composição SGA/PGA)
        osMemoryPct: osMemory && !osMemory.error ? osMemory.usedPct : null, // RAM real do servidor
        maxTablespacePct: maxTsPct,
    });

    const fra0 = Array.isArray(fra) ? fra[0] : null;
    alerts.evaluate({
        tablespaces,
        disks: vols && Array.isArray(vols.volumes) ? vols.volumes : [],
        osMemory: osMemory && !osMemory.error ? osMemory : null,
        fra: fra0 ? { usedPct: fra0.USED_PCT ?? fra0.used_pct } : null,
        blockedSessions,
    });
}

/** Versão com cache curto, usada pelas rotas. */
function collectCached(ttlMs = 3000) {
    return cache.cached('dashboard', ttlMs, collect);
}

/**
 * Amostra do sampler de background (ninguém precisa estar com a tela aberta):
 * só o que o histórico e os alertas usam — sem Top SQL, esperas etc.
 */
async function sample() {
    const [sessions, sqlCommands, memory] = await Promise.all([q('sessionSummary'), q('sqlCommands'), q('memoryUsage')]);
    maybeUpdateMonitoring({ sessions, sqlCommands: sqlCommands[0], memory: memory[0] });
}

module.exports = { collect, collectCached, sample, QUERY_TTL, TABLESPACE_TTL };

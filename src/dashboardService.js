/**
 * DASHBOARDSERVICE.JS - Agrega os dados do dashboard num único ponto,
 * alimentando o histórico (tendência) e o motor de alertas. É chamado tanto
 * pelas rotas (com cache curto) quanto pelo sampler de background.
 */
const { runQuery } = require('./db');
const { getOsDisk, getOsMemory } = require('./osDisk');
const cache = require('./cache');
const alerts = require('./alerts');
const logger = require('./logger');

// Leituras de SO via SSH são caras; cacheia por ~20s para não martelar o servidor.
const OS_TTL = 20000;
const cachedOsDisk = () => cache.cached('osDisk', OS_TTL, getOsDisk);
const cachedOsMemory = () => cache.cached('osMemory', OS_TTL, getOsMemory);

/** Coleta o snapshot completo do dashboard. */
async function collect() {
    const [sessions, sessionMem, sqlCommands, waitClasses, systemMetrics, waits, topSql, memory] = await Promise.all([
        runQuery('sessionSummary'),
        runQuery('sessionMemoryUsage'),
        runQuery('sqlCommands'),
        runQuery('waitClasses'),
        runQuery('systemMetrics'),
        runQuery('waitEvents'),
        runQuery('topSql'),
        runQuery('memoryUsage'),
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

    updateMonitoring(data).catch((err) => logger.warn('Falha ao atualizar histórico/alertas:', err.message));
    return data;
}

/** Atualiza histórico de tendência e avalia alertas (não bloqueia a resposta). */
async function updateMonitoring(data) {
    const activeSessions = data.sessions?.find((s) => s.STATUS === 'ACTIVE')?.COUNT || 0;
    const blockedSessions = data.sqlCommands?.BLOCKED_SESSIONS || 0;
    const memoryPct = data.memory?.USED_PCT ?? data.memory?.used_pct ?? 0;

    let tablespaces = [];
    let disk = null;
    let osMemory = null;
    let fra = null;
    try {
        [tablespaces, disk, osMemory, fra] = await Promise.all([
            runQuery('tablespaceUsage'),
            cachedOsDisk().catch(() => null),
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
        disk: disk && !disk.error ? disk : null,
        osMemory: osMemory && !osMemory.error ? osMemory : null,
        fra: fra0 ? { usedPct: fra0.USED_PCT ?? fra0.used_pct } : null,
        blockedSessions,
    });
}

/** Versão com cache curto, usada pelas rotas. */
function collectCached(ttlMs = 3000) {
    return cache.cached('dashboard', ttlMs, collect);
}

module.exports = { collect, collectCached };

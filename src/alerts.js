/**
 * ALERTS.JS - Motor de alertas por limiares (thresholds).
 * Avalia métricas coletadas e mantém a lista de alertas ativos. Opcionalmente
 * dispara um webhook (ALERT_WEBHOOK_URL) quando um novo alerta surge.
 */
const { config } = require('./config');
const logger = require('./logger');

let activeAlerts = []; // [{ id, severity, message, value, since }]
let lastFingerprint = new Set();

function severityFor(pct, limit) {
    if (pct >= limit + 5) return 'critical';
    return 'warning';
}

/**
 * Avalia o estado atual e devolve a lista de alertas ativos.
 * @param {object} metrics { tablespaces:[], disk:{usedPct}, memoryPct, blockedSessions }
 */
function evaluate(metrics) {
    const alerts = [];

    (metrics.tablespaces || []).forEach((ts) => {
        const pct = ts.USED_PCT ?? ts.used_pct ?? 0;
        if (pct >= config.alerts.tablespacePct) {
            alerts.push({
                id: `tablespace:${ts.TABLESPACE_NAME}`,
                severity: severityFor(pct, config.alerts.tablespacePct),
                message: `Tablespace ${ts.TABLESPACE_NAME} em ${pct}% de uso`,
                value: pct,
            });
        }
    });

    if (metrics.disk && typeof metrics.disk.usedPct === 'number' && metrics.disk.usedPct >= config.alerts.diskPct) {
        alerts.push({
            id: `disk:${metrics.disk.path || 'os'}`,
            severity: severityFor(metrics.disk.usedPct, config.alerts.diskPct),
            message: `Disco do servidor (${metrics.disk.path || ''}) em ${metrics.disk.usedPct}%`,
            value: metrics.disk.usedPct,
        });
    }

    // Memória REAL do servidor (RAM física), não o ratio SGA/PGA do Oracle.
    const osMem = metrics.osMemory;
    if (osMem && !osMem.error) {
        if (typeof osMem.usedPct === 'number' && osMem.usedPct >= config.alerts.memoryPct) {
            alerts.push({
                id: 'memory',
                severity: severityFor(osMem.usedPct, config.alerts.memoryPct),
                message: `RAM do servidor em ${osMem.usedPct}% (${osMem.usedMB} de ${osMem.totalMB} MB)`,
                value: osMem.usedPct,
            });
        }
        // Swap em uso é o sinal REAL de pressão de memória.
        if (osMem.swap && typeof osMem.swap.usedPct === 'number' && osMem.swap.usedPct >= config.alerts.swapPct) {
            alerts.push({
                id: 'swap',
                severity: 'critical',
                message: `Servidor usando swap: ${osMem.swap.usedPct}% (${osMem.swap.usedMB} MB) — possível falta de RAM`,
                value: osMem.swap.usedPct,
            });
        }
    }

    // FRA (Flash Recovery Area): se encher com archivelog mode ligado, o banco PARA.
    if (metrics.fra && typeof metrics.fra.usedPct === 'number' && metrics.fra.usedPct >= config.alerts.fraPct) {
        alerts.push({
            id: 'fra',
            severity: severityFor(metrics.fra.usedPct, config.alerts.fraPct),
            message: `Recovery Area (FRA) em ${Math.round(metrics.fra.usedPct)}% — risco de parar o banco se encher. Faça backup/limpeza ou aumente a FRA.`,
            value: metrics.fra.usedPct,
        });
    }

    if (metrics.blockedSessions > 0) {
        alerts.push({
            id: 'locks',
            severity: 'critical',
            message: `${metrics.blockedSessions} sessão(ões) bloqueada(s) por lock`,
            value: metrics.blockedSessions,
        });
    }

    // Preserva o "since" de alertas que continuam ativos
    const previous = new Map(activeAlerts.map((a) => [a.id, a]));
    activeAlerts = alerts.map((a) => ({
        ...a,
        since: previous.get(a.id)?.since || new Date().toISOString(),
    }));

    notifyNew();
    return activeAlerts;
}

/** Dispara webhook apenas para alertas que acabaram de aparecer. */
function notifyNew() {
    const current = new Set(activeAlerts.map((a) => a.id));
    const fresh = activeAlerts.filter((a) => !lastFingerprint.has(a.id));
    lastFingerprint = current;

    if (fresh.length === 0) return;

    fresh.forEach((a) => logger.warn(`ALERTA [${a.severity}] ${a.message}`));

    if (config.alerts.webhookUrl && typeof fetch === 'function') {
        for (const a of fresh) {
            fetch(config.alerts.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: `[Oracle Pulse] ${a.severity.toUpperCase()}: ${a.message}` }),
            }).catch((err) => logger.warn('Falha ao enviar webhook de alerta:', err.message));
        }
    }
}

function getActive() {
    return activeAlerts;
}

module.exports = { evaluate, getActive };

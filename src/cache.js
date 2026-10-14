/**
 * CACHE.JS - Cache de curta duração + histórico em memória.
 *  - cached(key, ttlMs, producer): evita martelar o banco quando vários clientes
 *    pedem o mesmo dado no mesmo intervalo de refresh.
 *  - history: ring buffer com amostras periódicas para gráficos de tendência.
 */
const MAX_HISTORY = 720; // ~6h de amostras a cada 30s

const store = new Map(); // key -> { expiresAt, value, promise }
const history = []; // [{ ts, activeSessions, blockedSessions, memoryPct, maxTablespacePct }]

/**
 * Retorna o valor em cache se válido; caso contrário executa o producer,
 * deduplicando chamadas concorrentes para a mesma key.
 */
// Uma coleta em andamento é reaproveitada mesmo passando do TTL (consulta lenta,
// SSH): sem isso, cada nova chamada abria OUTRA coleta igual em paralelo. Só uma
// coleta presa há mais que isso é abandonada.
const INFLIGHT_MAX_MS = 120000;

async function cached(key, ttlMs, producer) {
    const now = Date.now();
    const entry = store.get(key);
    if (entry && entry.promise && now - entry.startedAt < INFLIGHT_MAX_MS) return entry.promise;
    if (entry && !entry.promise && entry.expiresAt > now) return entry.value;

    const promise = Promise.resolve()
        .then(producer)
        .then((value) => {
            if (store.get(key)?.promise === promise) store.set(key, { value, expiresAt: Date.now() + ttlMs, promise: null });
            return value;
        })
        .catch((err) => {
            if (store.get(key)?.promise === promise) store.delete(key);
            throw err;
        });

    store.set(key, { value: null, expiresAt: 0, promise, startedAt: now });
    return promise;
}

function invalidate(key) {
    store.delete(key);
}

function addHistorySample(sample) {
    history.push({ ts: new Date().toISOString(), ...sample });
    if (history.length > MAX_HISTORY) history.shift();
}

function getHistory(limit = 120) {
    return history.slice(-limit);
}

module.exports = { cached, invalidate, addHistorySample, getHistory };

/**
 * DEMOCLOCK.JS - Relógio simulado do "servidor de banco" no modo DEMO.
 * Começa adiantado (como no caso real que motivou o recurso) e é corrigido pela
 * sincronização NTP simulada. Módulo isolado para evitar dependência circular
 * entre mockData e timeSync.
 */
const state = { offsetMs: 9 * 60 * 1000 + 23 * 1000 };

/** Hora atual do servidor simulado (ms desde 1970). */
function now() {
    return Date.now() + state.offsetMs;
}

/** "DD/MM/AAAA HH:MM:SS", o mesmo formato da query instanceStatus. */
function formatted(ms = now()) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = { state, now, formatted };

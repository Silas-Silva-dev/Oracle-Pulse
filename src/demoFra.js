/**
 * DEMOFRA.JS - FRA simulada (modo DEMO), compartilhada entre a query mock
 * "fraUsage" (telas Backup/Dashboard) e o guardião da FRA, para que as ações
 * simuladas do guardião apareçam no painel.
 */
const state = {
    dest: '/u01/app/oracle/fast_recovery_area',
    limitMb: 50000,
    usedMb: 29100,
    reclaimMb: 0,
    unbackedMb: 4200,
    archiver: 'STARTED',
};

function pct() {
    return state.limitMb ? Math.round(((state.usedMb - state.reclaimMb) / state.limitMb) * 1000) / 10 : 0;
}

/** Linhas no formato da query fraUsage. */
function rows() {
    return [{ NAME: state.dest, LIMIT_MB: state.limitMb, USED_MB: state.usedMb, USED_PCT: pct() }];
}

/** Pico de archives (botão "Simular pico" no modo DEMO). */
function spike() {
    state.usedMb = Math.round(state.limitMb * 0.96);
    state.unbackedMb = Math.round(state.limitMb * 0.42);
    state.archiver = 'STARTED';
}

module.exports = { state, pct, rows, spike };

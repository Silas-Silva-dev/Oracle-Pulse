/**
 * Rotas de otimização de memória:
 *  - /memory/advisor: RAM/swap REAL do servidor + conselheiros do Oracle
 *    (V$PGA_TARGET_ADVICE / V$SGA_TARGET_ADVICE / V$MEMORY_TARGET_ADVICE) +
 *    uma recomendação calculada (sugestão segura de dimensionamento).
 */
const express = require('express');
const { config } = require('../config');
const { runQuery, executeAdmin, ValidationError, assertPositiveInt } = require('../db');
const { getOsMemory } = require('../osDisk');
const { requireDba } = require('../auth');
const audit = require('../audit');
const cache = require('../cache');

const router = express.Router();

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const MAX_MEM_MB = 1024 * 1024; // 1 TB de teto de segurança

/** Calcula uma recomendação de dimensionamento (sugestão, não execução automática). */
function computeRecommendation({ params, pga, sga, mode, osMemory }) {
    const rec = { mode, items: [] };

    // ----- PGA -----
    if (pga && pga.length) {
        const current = pga.find((r) => Number(r.FACTOR) === 1) || pga[0];
        const curOver = num(current.OVERALLOC);
        if (curOver > 0) {
            // Menor target que zera a over-allocation
            const fix = pga.find((r) => num(r.OVERALLOC) === 0);
            if (fix) {
                rec.items.push({
                    area: 'PGA',
                    severity: 'warning',
                    text: `A PGA atual (${params.pga_aggregate_target || '?'} MB) gera over-allocation (${curOver}). ` +
                        `Sugestão: aumentar PGA_AGGREGATE_TARGET para ~${fix.TARGET_MB} MB ` +
                        `(cache hit estimado ${fix.CACHE_HIT_PCT}%).`,
                    suggestedMb: num(fix.TARGET_MB),
                });
            }
        } else {
            rec.items.push({ area: 'PGA', severity: 'ok', text: `PGA adequada: sem over-allocation no alvo atual (${params.pga_aggregate_target || '?'} MB).` });
        }
    }

    // ----- SGA -----
    if (sga && sga.length) {
        const current = sga.find((r) => Number(r.FACTOR) === 1) || sga[0];
        const curTime = num(current.ESTD_DB_TIME);
        const curSize = num(current.SIZE_MB);

        // Margem de RAM livre para crescer (deixa 1 GB de folga no SO)
        const freeMB = osMemory && !osMemory.error ? num(osMemory.freeMB) : null;
        const headroom = freeMB != null ? Math.max(0, freeMB - 1024) : Infinity;

        // Melhor tamanho que ainda cabe na RAM e melhora o DB time de forma relevante
        let best = null;
        for (const r of sga) {
            const size = num(r.SIZE_MB);
            const delta = size - curSize;
            if (size <= curSize) continue;
            if (delta > headroom) continue; // não cabe na RAM livre
            const improvement = curTime > 0 ? (curTime - num(r.ESTD_DB_TIME)) / curTime : 0;
            if (improvement >= 0.05 && (!best || num(r.SIZE_MB) > num(best.SIZE_MB))) best = r;
        }

        if (best) {
            const improvement = Math.round(((curTime - num(best.ESTD_DB_TIME)) / curTime) * 100);
            rec.items.push({
                area: 'SGA',
                severity: 'info',
                text: `Há espaço para ganho: aumentar a SGA de ${curSize} para ~${best.SIZE_MB} MB ` +
                    `reduz o DB time estimado em ~${improvement}% e cabe na RAM livre do servidor.`,
                suggestedMb: num(best.SIZE_MB),
            });
        } else if (freeMB != null && headroom <= 0) {
            rec.items.push({ area: 'SGA', severity: 'warning', text: 'Pouca RAM livre no servidor para crescer a SGA com segurança. Considere adicionar RAM antes de aumentar a SGA.' });
        } else {
            rec.items.push({ area: 'SGA', severity: 'ok', text: 'SGA adequada: aumentar não traria ganho relevante de desempenho.' });
        }
    }

    // ----- Swap -----
    if (osMemory && !osMemory.error && osMemory.swap && osMemory.swap.usedPct >= 10) {
        rec.items.push({
            area: 'Servidor',
            severity: 'critical',
            text: `O servidor está usando swap (${osMemory.swap.usedPct}%). Isso degrada o desempenho: reduza a memória alocada ou adicione RAM física.`,
        });
    }

    if (rec.items.length === 0) {
        rec.items.push({ area: 'Geral', severity: 'ok', text: 'Memória do servidor saudável; nenhum ajuste necessário no momento.' });
    }
    return rec;
}

router.get('/memory/advisor', async (req, res) => {
    try {
        // "Atualizar Agora" (e após aplicar um ajuste): dados novos, sem o cache.
        if (req.query.refresh === '1') ['osMemory', 'memoryParams', 'pgaAdvice', 'sgaAdvice', 'memoryAdvice'].forEach((k) => cache.invalidate(k));
        const [osMemory, paramRows, pga, sga, memory] = await Promise.all([
            // Falha ao ler a RAM do SO não pode derrubar a tela inteira (SGA/PGA vêm do banco).
            cache.cached('osMemory', 20000, getOsMemory).catch((e) => ({ error: `Leitura da memória do servidor falhou: ${e.message}` })),
            cache.cached('memoryParams', 30000, () => runQuery('memoryParams')),
            cache.cached('pgaAdvice', 30000, () => runQuery('pgaAdvice')),
            cache.cached('sgaAdvice', 30000, () => runQuery('sgaAdvice')),
            cache.cached('memoryAdvice', 30000, () => runQuery('memoryAdvice')),
        ]);

        const params = {};
        (paramRows || []).forEach((r) => { params[(r.NAME || r.name)] = num(r.VALUE_MB ?? r.value_mb); });

        const mode = params.memory_target > 0 ? 'AMM (Automatic Memory Management)'
            : params.sga_target > 0 ? 'ASMM (Automatic Shared Memory Management)'
                : 'MANUAL';

        const recommendation = computeRecommendation({ params, pga, sga, mode, osMemory });

        res.json({ success: true, data: { osMemory, params, mode, pga, sga, memory, recommendation } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/** Lê os parâmetros de memória atuais (MB) como mapa. */
async function readMemoryParams() {
    const rows = await runQuery('memoryParams');
    const p = {};
    (rows || []).forEach((r) => { p[(r.NAME || r.name)] = num(r.VALUE_MB ?? r.value_mb); });
    return p;
}

// Ajusta o PGA_AGGREGATE_TARGET online (sem reinício).
router.post('/memory/pga-target', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const size = assertPositiveInt(req.body?.sizeMb, 'PGA Target (MB)', { min: 100, max: MAX_MEM_MB });
        const sql = `ALTER SYSTEM SET PGA_AGGREGATE_TARGET = ${size}M SCOPE=BOTH`;
        if (config.demoMode) {
            audit.record({ action: 'set-pga', user: req.session.user, role: req.session.role, ip, detail: `[DEMO] ${sql}` });
            return res.json({ success: true, message: `Simulação: ${sql}` });
        }
        await executeAdmin(sql);
        cache.invalidate('memoryParams');
        audit.record({ action: 'set-pga', user: req.session.user, role: req.session.role, ip, detail: sql });
        res.json({ success: true, message: `PGA_AGGREGATE_TARGET definido para ${size} MB (sem reinício).` });
    } catch (err) {
        const status = err instanceof ValidationError ? 400 : 500;
        audit.record({ action: 'set-pga', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

// Ajusta o SGA_TARGET online (sem reinício), respeitando SGA_MAX_SIZE.
router.post('/memory/sga-target', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const size = assertPositiveInt(req.body?.sizeMb, 'SGA Target (MB)', { min: 100, max: MAX_MEM_MB });

        if (!config.demoMode) {
            const p = await readMemoryParams();
            const sgaMax = p.sga_max_size || 0;
            // SGA_TARGET só pode crescer até SGA_MAX_SIZE sem reinício (parâmetro estático).
            if (sgaMax > 0 && size > sgaMax) {
                return res.status(400).json({
                    success: false,
                    error: `SGA_TARGET (${size} MB) não pode exceder SGA_MAX_SIZE (${sgaMax} MB) sem reiniciar o banco. ` +
                        `Escolha um valor ≤ ${sgaMax} MB, ou aumente SGA_MAX_SIZE (requer reinício).`,
                });
            }
        }

        const sql = `ALTER SYSTEM SET SGA_TARGET = ${size}M SCOPE=BOTH`;
        if (config.demoMode) {
            audit.record({ action: 'set-sga', user: req.session.user, role: req.session.role, ip, detail: `[DEMO] ${sql}` });
            return res.json({ success: true, message: `Simulação: ${sql}` });
        }
        await executeAdmin(sql);
        cache.invalidate('memoryParams');
        audit.record({ action: 'set-sga', user: req.session.user, role: req.session.role, ip, detail: sql });
        res.json({ success: true, message: `SGA_TARGET definido para ${size} MB (sem reinício).` });
    } catch (err) {
        const status = err instanceof ValidationError ? 400 : 500;
        audit.record({ action: 'set-sga', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

// Ajusta o SGA_MAX_SIZE (parâmetro ESTÁTICO): grava no SPFILE; vale após reinício.
router.post('/memory/sga-max-size', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const size = assertPositiveInt(req.body?.sizeMb, 'SGA Max Size (MB)', { min: 100, max: MAX_MEM_MB });

        if (!config.demoMode) {
            const p = await readMemoryParams();
            // SGA_MAX_SIZE não pode ficar abaixo do SGA_TARGET atual (o banco não sobe).
            if (p.sga_target > 0 && size < p.sga_target) {
                return res.status(400).json({
                    success: false,
                    error: `SGA_MAX_SIZE (${size} MB) não pode ser menor que o SGA_TARGET atual (${p.sga_target} MB) — o banco não reiniciaria. Use um valor ≥ ${p.sga_target} MB.`,
                });
            }
        }

        const sql = `ALTER SYSTEM SET SGA_MAX_SIZE = ${size}M SCOPE=SPFILE`;
        if (config.demoMode) {
            audit.record({ action: 'set-sga-max', user: req.session.user, role: req.session.role, ip, detail: `[DEMO] ${sql}` });
            return res.json({ success: true, needsRestart: true, message: `Simulação: ${sql} (efetivo após reiniciar o banco).` });
        }
        await executeAdmin(sql);
        cache.invalidate('memoryParams');
        audit.record({ action: 'set-sga-max', user: req.session.user, role: req.session.role, ip, detail: sql });
        res.json({ success: true, needsRestart: true, message: `SGA_MAX_SIZE = ${size} MB gravado no SPFILE. ⚠️ Só entra em vigor após REINICIAR o banco.` });
    } catch (err) {
        const status = err instanceof ValidationError ? 400 : 500;
        audit.record({ action: 'set-sga-max', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

// PGA_AGGREGATE_LIMIT (dinâmico). 0 = SEM LIMITE.
router.post('/memory/pga-limit', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const n = Number(req.body?.sizeMb);
        if (!Number.isInteger(n) || n < 0 || n > MAX_MEM_MB) {
            throw new ValidationError(`PGA Aggregate Limit (MB) inválido: use 0 (sem limite) ou um inteiro até ${MAX_MEM_MB}.`);
        }
        const val = n === 0 ? '0' : `${n}M`;
        const sql = `ALTER SYSTEM SET PGA_AGGREGATE_LIMIT = ${val} SCOPE=BOTH`;
        const okMsg = n === 0 ? 'PGA_AGGREGATE_LIMIT definido como 0 (SEM LIMITE).' : `PGA_AGGREGATE_LIMIT definido para ${n} MB (sem reinício).`;
        if (config.demoMode) {
            audit.record({ action: 'set-pga-limit', user: req.session.user, role: req.session.role, ip, detail: `[DEMO] ${sql}` });
            return res.json({ success: true, message: `Simulação: ${sql}` });
        }
        await executeAdmin(sql);
        cache.invalidate('memoryParams');
        audit.record({ action: 'set-pga-limit', user: req.session.user, role: req.session.role, ip, detail: sql });
        res.json({ success: true, message: okMsg });
    } catch (err) {
        const status = err instanceof ValidationError ? 400 : 500;
        audit.record({ action: 'set-pga-limit', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

// MEMORY_TARGET (dinâmico) — só no modo AMM.
router.post('/memory/memory-target', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const size = assertPositiveInt(req.body?.sizeMb, 'MEMORY_TARGET (MB)', { min: 100, max: MAX_MEM_MB });
        if (!config.demoMode) {
            const p = await readMemoryParams();
            if (p.memory_max_target > 0 && size > p.memory_max_target) {
                return res.status(400).json({ success: false, error: `MEMORY_TARGET (${size} MB) não pode exceder MEMORY_MAX_TARGET (${p.memory_max_target} MB) sem reiniciar. Aumente o MEMORY_MAX_TARGET (requer reinício) ou use ≤ ${p.memory_max_target} MB.` });
            }
        }
        const sql = `ALTER SYSTEM SET MEMORY_TARGET = ${size}M SCOPE=BOTH`;
        if (config.demoMode) {
            audit.record({ action: 'set-memory-target', user: req.session.user, role: req.session.role, ip, detail: `[DEMO] ${sql}` });
            return res.json({ success: true, message: `Simulação: ${sql}` });
        }
        await executeAdmin(sql);
        cache.invalidate('memoryParams');
        audit.record({ action: 'set-memory-target', user: req.session.user, role: req.session.role, ip, detail: sql });
        res.json({ success: true, message: `MEMORY_TARGET definido para ${size} MB (sem reinício).` });
    } catch (err) {
        const status = err instanceof ValidationError ? 400 : 500;
        audit.record({ action: 'set-memory-target', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

// MEMORY_MAX_TARGET (estático) — SPFILE; vale após reiniciar. Só no modo AMM.
router.post('/memory/memory-max-target', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    try {
        const size = assertPositiveInt(req.body?.sizeMb, 'MEMORY_MAX_TARGET (MB)', { min: 100, max: MAX_MEM_MB });
        if (!config.demoMode) {
            const p = await readMemoryParams();
            if (p.memory_target > 0 && size < p.memory_target) {
                return res.status(400).json({ success: false, error: `MEMORY_MAX_TARGET (${size} MB) não pode ser menor que o MEMORY_TARGET atual (${p.memory_target} MB).` });
            }
        }
        const sql = `ALTER SYSTEM SET MEMORY_MAX_TARGET = ${size}M SCOPE=SPFILE`;
        if (config.demoMode) {
            audit.record({ action: 'set-memory-max', user: req.session.user, role: req.session.role, ip, detail: `[DEMO] ${sql}` });
            return res.json({ success: true, needsRestart: true, message: `Simulação: ${sql} (efetivo após reiniciar o banco).` });
        }
        await executeAdmin(sql);
        cache.invalidate('memoryParams');
        audit.record({ action: 'set-memory-max', user: req.session.user, role: req.session.role, ip, detail: sql });
        res.json({ success: true, needsRestart: true, message: `MEMORY_MAX_TARGET = ${size} MB gravado no SPFILE. ⚠️ Só entra em vigor após REINICIAR o banco.` });
    } catch (err) {
        const status = err instanceof ValidationError ? 400 : 500;
        audit.record({ action: 'set-memory-max', user: req.session?.user, role: req.session?.role, ip, success: false, detail: err.message });
        res.status(status).json({ success: false, error: err.message });
    }
});

module.exports = router;

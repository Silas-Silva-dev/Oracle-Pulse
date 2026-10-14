/**
 * EXECUTOR.JS - Executa um plano de recuperação como JOB em segundo plano.
 *
 *  - Um job por vez (recuperação concorrente no mesmo banco é receita de desastre).
 *  - Passo a passo, com a saída AO VIVO (o RMAN pode levar horas).
 *  - Antes de cada passo que depende do estado da instância, consulta o estado
 *    real e usa a variante certa (parada / NOMOUNT / montada / aberta).
 *  - Para no primeiro erro; os códigos ORA/RMAN da saída são cruzados com a
 *    base de conhecimento para sugerir o próximo passo.
 *  - Tudo auditado; senhas nunca aparecem na saída (scrubSecrets).
 */
const crypto = require('crypto');
const { config } = require('../config');
const { execOnServer, detectServerOs, psEncoded } = require('../osDisk');
const backupAdmin = require('../backupAdmin');
const audit = require('../audit');
const logger = require('../logger');
const collect = require('./collect');
const kb = require('./knowledge');
const { renderStep, STATE_LABEL } = require('./playbooks');
const demo = require('./demo');

const jobs = new Map();
const MAX_JOBS = 30;
const MAX_LOG = 200000;
let running = null;

function publicJob(j) {
    return {
        id: j.id, playbook: j.playbook, title: j.title, params: j.params, state: j.state, message: j.message,
        user: j.user, startedAt: j.startedAt, finishedAt: j.finishedAt,
        steps: j.steps.map((s) => ({ id: s.id, title: s.title, channel: s.channel, state: s.state, startedAt: s.startedAt, finishedAt: s.finishedAt, output: s.output, warnings: s.warnings, stateBefore: s.stateBefore })),
        suggestions: j.suggestions, after: j.after, warnings: j.warnings,
    };
}

function getJob(id) {
    const j = jobs.get(id);
    return j ? publicJob(j) : null;
}

function listJobs(limit = 15) {
    return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
        .map((j) => ({ id: j.id, playbook: j.playbook, title: j.title, state: j.state, message: j.message, user: j.user, startedAt: j.startedAt, finishedAt: j.finishedAt }));
}

function isRunning() {
    return !!running;
}

// ==========================================================================
// Avaliação da saída
// ==========================================================================

/** Códigos de erro presentes na saída (ORA/RMAN/SP2/TNS). */
function codesIn(text) {
    const out = [];
    const re = /\b(ORA|RMAN|SP2|TNS)-(\d{4,5})\b/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
        const code = m[1] === 'ORA' || m[1] === 'RMAN' ? kb.normalizeCode(m[1], m[2]) : `${m[1]}-${m[2].padStart(4, '0')}`;
        if (!out.includes(code)) out.push(code);
    }
    return out;
}

/**
 * Sucesso de um passo: código de saída 0 e nenhum erro fora da lista benigna.
 * RMAN-08xxx são mensagens informativas. tolerate06054: fim normal do redo.
 */
function evaluateStep(stepDef, code, output) {
    const warnings = [];
    let codes = codesIn(output).filter((c) => !/^RMAN-08\d{3}$/.test(c));
    const benign = new Set(stepDef.benign || []);
    // RECOVER após restaurar o controlfile termina com RMAN-06054 (e o RMAN sai com
    // código 1): é o fim normal do redo disponível, não falha.
    let tolerated = false;
    if (stepDef.tolerate06054 && codes.includes('RMAN-06054')) {
        codes = codes.filter((c) => !['RMAN-06054', 'RMAN-03002', 'RMAN-00571', 'RMAN-00569'].includes(c));
        tolerated = true;
        warnings.push('O RMAN aplicou todo o redo disponível e parou pedindo um log inexistente (RMAN-06054) — é o fim esperado; segue para o OPEN RESETLOGS.');
    }
    const fatal = codes.filter((c) => !benign.has(c));
    const seenBenign = codes.filter((c) => benign.has(c) && !kb.isBenignRecoveryCode(c));
    if (seenBenign.length) warnings.push(`Mensagens esperadas neste passo: ${seenBenign.join(', ')}.`);
    // sqlplus com WHENEVER SQLERROR CONTINUE sempre sai com 0: vale só a lista de códigos.
    const continueMode = stepDef.channel === 'sqlplus' && (stepDef.lines || []).some((l) => /^WHENEVER SQLERROR CONTINUE/i.test(l));
    const ok = fatal.length === 0 && (code === 0 || continueMode || tolerated);
    return { ok, fatal, warnings };
}

function suggestionsFor(codes) {
    const out = [];
    for (const c of codes) {
        const e = kb.lookup(c);
        if (!e || e.severity === 'info') continue;
        out.push({ code: c, title: e.title, meaning: e.meaning, playbooks: e.playbooks });
        if (out.length >= 4) break;
    }
    return out;
}

// ==========================================================================
// Canais
// ==========================================================================

function sqlplusScript(stepDef, rendered) {
    const lines = ['SET DEFINE OFF', 'SET SQLBLANKLINES ON', 'SET LINESIZE 200', 'SET PAGESIZE 100'];
    if (!stepDef.lines.some((l) => /^WHENEVER /i.test(l))) lines.push('WHENEVER SQLERROR EXIT FAILURE');
    for (const l of rendered) {
        if (/;\s*$/.test(l) && !/^(SET|WHENEVER|PROMPT)\b/i.test(l)) lines.push(`PROMPT SQL> ${l.replace(/\s+/g, ' ')}`);
        if (/^@/.test(l)) lines.push(`PROMPT SQL> ${l}`);
        lines.push(l);
    }
    return lines;
}

async function runChannel(stepDef, rendered, serverOs, onOutput) {
    const ch = stepDef.channel;
    if (ch === 'sql') {
        const conn = await collect.openDirectConnection();
        const log = [];
        try {
            conn.callTimeout = 0;
            for (const st of stepDef.statements) {
                const head = st.sql.replace(/\s+/g, ' ').slice(0, 300);
                log.push(`SQL> ${head}`);
                onOutput(`SQL> ${head}\n`);
                try {
                    await conn.execute(st.sql, [], { autoCommit: true });
                    log.push('OK');
                    onOutput('OK\n');
                } catch (err) {
                    const msg = String(err.message || err);
                    log.push(msg);
                    onOutput(msg + '\n');
                    return { code: 1, output: log.join('\n') };
                }
            }
            return { code: 0, output: log.join('\n') };
        } finally {
            try { await conn.close(); } catch { /* ignore */ }
        }
    }
    if (ch === 'sqlplus') {
        const r = await collect.runSysdba(sqlplusScript(stepDef, rendered), { serverOs, onOutput: (t) => onOutput(backupAdmin.scrubSecrets(t)) });
        return { code: r.code, output: r.output };
    }
    if (ch === 'rman') {
        const { command, stdin, env } = backupAdmin.buildRmanRun(rendered, serverOs);
        const r = await execOnServer(command, { stdin, env, onOutput: (t) => onOutput(backupAdmin.scrubSecrets(t)) });
        return { code: r.code, output: backupAdmin.scrubSecrets(`${r.stdout}\n${r.stderr}`) };
    }
    if (ch === 'os') {
        if (serverOs !== 'windows') throw new Error('Passo de PowerShell só se aplica a servidor Windows.');
        const r = await execOnServer(psEncoded(rendered.join('\n')), { onOutput });
        return { code: r.code, output: `${r.stdout}\n${r.stderr}` };
    }
    if (ch === 'mkdir') {
        // Mesma rotina da FRA/backups: no Linux cria como o dono do Oracle (o SSH costuma ser root).
        onOutput(`Criando a pasta ${stepDef.dir}\n`);
        try {
            await backupAdmin.createServerDir(stepDef.dir, serverOs);
            onOutput('OK\n');
            return { code: 0, output: `Pasta pronta: ${stepDef.dir}` };
        } catch (err) {
            const msg = backupAdmin.scrubSecrets(String(err.message || err));
            onOutput(`${msg}\n`);
            return { code: 1, output: msg };
        }
    }
    if (ch === 'lsnrctl') {
        const { command, env } = backupAdmin.buildServerCommand('lsnrctl', stepDef.args || 'start', serverOs);
        const r = await execOnServer(command, { env, onOutput });
        return { code: r.code, output: `${r.stdout}\n${r.stderr}` };
    }
    throw new Error(`Canal desconhecido: ${ch}`);
}

// ==========================================================================
// Job
// ==========================================================================

/**
 * @param {object} plan  resultado de playbooks.buildPlan (com .internal)
 * @param {object} ctx   { user, role, ip }
 * @param {object} hooks { afterDiagnose: async () => summary }
 */
function start(plan, ctx = {}, hooks = {}) {
    if (running) {
        const err = new Error('Já existe um procedimento de recuperação em execução. Aguarde terminar.');
        err.status = 409;
        throw err;
    }
    const job = {
        id: crypto.randomBytes(8).toString('hex'),
        playbook: plan.playbook.id, title: plan.playbook.title, params: plan.params,
        state: 'running', message: 'Iniciando...', user: ctx.user || '-',
        startedAt: Date.now(), finishedAt: null,
        steps: plan.internal.steps.map((s) => ({ ...s, def: s, state: 'pending', output: '', warnings: [], startedAt: null, finishedAt: null, stateBefore: null })),
        suggestions: [], after: null, warnings: [],
        log: '',
    };
    jobs.set(job.id, job);
    if (jobs.size > MAX_JOBS) {
        const oldest = [...jobs.values()].filter((j) => j.state !== 'running').sort((a, b) => a.startedAt - b.startedAt)[0];
        if (oldest) jobs.delete(oldest.id);
    }
    running = job.id;
    audit.record({ action: 'recovery-start', user: ctx.user, role: ctx.role, ip: ctx.ip, detail: `${plan.playbook.id} ${JSON.stringify(plan.params)}` });
    run(job, ctx, hooks).catch((err) => {
        job.state = 'failed';
        job.message = 'Erro inesperado: ' + backupAdmin.scrubSecrets(err.message);
        job.finishedAt = Date.now();
        logger.error('Job de recuperação falhou:', err.message);
    }).finally(() => {
        running = null;
    });
    return job.id;
}

async function run(job, ctx, hooks) {
    const serverOs = config.demoMode ? 'linux' : await detectServerOs().catch(() => null);
    let restarted = false;
    let failedCodes = [];

    for (let i = 0; i < job.steps.length; i++) {
        const st = job.steps[i];
        const def = st.def;
        st.state = 'running';
        st.startedAt = Date.now();
        job.message = `Passo ${i + 1} de ${job.steps.length}: ${def.title}`;
        const emit = (t) => {
            st.output = (st.output + t).slice(-MAX_LOG);
        };
        try {
            let state = 'UNKNOWN';
            if (def.variants) {
                state = config.demoMode ? demo.signals().state : await collect.probeState();
                st.stateBefore = state;
                if (def.variants[state] === undefined) {
                    throw new Error(`Este passo não se aplica com a instância ${STATE_LABEL[state] || state}. Analise novamente o banco antes de continuar.`);
                }
                emit(`[instância ${STATE_LABEL[state] || state}]\n`);
            }
            const rendered = renderStep(def, state === 'UNKNOWN' ? 'OPEN' : state) || [];
            let result;
            if (config.demoMode) {
                await new Promise((r) => setTimeout(r, 900 + Math.random() * 900));
                const out = demo.stepOutput(def, rendered);
                emit(out + '\n');
                result = { code: 0, output: out };
            } else {
                result = await runChannel(def, rendered, serverOs, emit);
                if (!st.output.trim()) emit(result.output);
                // Higieniza o texto INTEIRO (uma senha poderia vir partida entre dois pedaços da saída ao vivo).
                st.output = backupAdmin.scrubSecrets(st.output);
            }
            if (def.restartsInstance) restarted = true;
            const ev = evaluateStep(def, result.code, result.output);
            st.warnings = ev.warnings;
            st.finishedAt = Date.now();
            if (!ev.ok) {
                st.state = 'failed';
                failedCodes = ev.fatal;
                if (!st.output.trim()) st.output = result.output;
                for (let k = i + 1; k < job.steps.length; k++) job.steps[k].state = 'skipped';
                job.state = 'failed';
                job.message = `Falhou no passo ${i + 1} (${def.title})${ev.fatal.length ? `: ${ev.fatal.slice(0, 3).join(', ')}` : ''}. Nada além deste passo foi executado.`;
                break;
            }
            st.state = 'done';
        } catch (err) {
            st.state = 'failed';
            st.finishedAt = Date.now();
            emit(`\n${backupAdmin.scrubSecrets(err.message)}\n`);
            failedCodes = codesIn(err.message);
            for (let k = i + 1; k < job.steps.length; k++) job.steps[k].state = 'skipped';
            job.state = 'failed';
            job.message = `Falhou no passo ${i + 1} (${def.title}): ${backupAdmin.scrubSecrets(err.message).split('\n')[0].slice(0, 200)}`;
            break;
        }
    }

    if (job.state === 'running') {
        job.state = 'done';
        job.message = 'Procedimento concluído com sucesso.';
        if (config.demoMode) demo.apply(job.playbook, job.params);
    }
    job.suggestions = suggestionsFor(failedCodes);

    if (restarted && !config.demoMode) {
        // A instância foi reiniciada/aberta: as conexões antigas do pool morreram.
        try { await require('../db').closePool(); } catch { /* ignore */ }
    }
    try {
        if (hooks.afterDiagnose) job.after = await hooks.afterDiagnose();
    } catch (err) {
        job.warnings.push(`Não foi possível diagnosticar de novo: ${err.message}`);
    }
    job.finishedAt = Date.now();
    audit.record({
        action: 'recovery', user: ctx.user, role: ctx.role, ip: ctx.ip, success: job.state === 'done',
        detail: `${job.playbook} ${JSON.stringify(job.params)} -> ${job.state}${failedCodes.length ? ` (${failedCodes.join(',')})` : ''}`,
    });
}

module.exports = { start, getJob, listJobs, isRunning, evaluateStep, codesIn, sqlplusScript };

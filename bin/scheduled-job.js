#!/usr/bin/env node
/**
 * Backup agendado no WINDOWS: executado pelo Agendador de Tarefas
 * (\OraclePulse\), com o Node do próprio painel:
 *
 *   node bin/scheduled-job.js <full|level0|level1|archivelog>
 *
 * Lê o .env do painel (a senha do SYS vai ao RMAN pela entrada padrão, nunca
 * fica em arquivo de script) e as opções salvas na tela Backup. Grava o log em
 * logs\backup\<tarefa>_<data>.log e o status em logs\backup\<tarefa>.status.json.
 * Antes de um backup do banco, src/backupPreflight.js confere se ele cabe (e
 * aumenta a FRA se preciso); se não couber, só os archivelogs são copiados e a
 * tarefa termina com código 3.
 * No Linux o equivalente é o run-job.sh instalado no servidor (cron).
 */
'use strict';
const path = require('path');
const fs = require('fs');

// O .env e os logs são os do painel, qualquer que seja a pasta de trabalho da tarefa.
process.chdir(path.join(__dirname, '..'));

const schedule = require('../src/backupSchedule');
const preflight = require('../src/backupPreflight');
const backupAdmin = require('../src/backupAdmin');
const audit = require('../src/audit');

const KEEP_DAYS = 30;

function stampOf(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function prune(dir, job) {
    const limit = Date.now() - KEEP_DAYS * 86400000;
    for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(`${job}_`) || !f.endsWith('.log')) continue;
        const full = path.join(dir, f);
        try { if (fs.statSync(full).mtimeMs < limit) fs.unlinkSync(full); } catch { /* ignore */ }
    }
}

async function main() {
    const job = process.argv[2];
    if (!schedule.JOBS.includes(job)) {
        console.error(`Uso: node bin/scheduled-job.js <${schedule.JOBS.join('|')}>`);
        return 2;
    }
    const dir = schedule.WIN_LOG_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const started = new Date();
    const log = path.join(dir, `${job}_${stampOf(started)}.log`);
    const statusFile = path.join(dir, `${job}.status.json`);
    fs.writeFileSync(statusFile, JSON.stringify({ start: started.getTime(), rc: 'running', log, end: null }));

    let rc = 1;
    let text = '';
    try {
        const settings = schedule.loadSettings();
        // Antes do backup do banco: cabe? (senão aumenta a FRA ou faz só os archivelogs)
        const pre = await preflight.run(job, settings);
        const noRoom = pre.verdict === 'noroom';
        if (pre.decision && pre.decision.grown) {
            audit.record({ action: 'fra-preflight', user: 'agendador', role: 'sistema', ip: 'local', success: true, detail: `${job}: limite da FRA ${pre.decision.limitMb} MB → ${pre.decision.toMb} MB antes do backup` });
        }
        const lines = schedule.rmanLines(noRoom ? 'archivelog' : job, settings.schedule);
        const r = await backupAdmin.runRmanGuarded(lines, { serverOs: 'windows', timeoutMs: 12 * 3600000 });
        rc = noRoom ? preflight.NOROOM_RC : r.ok ? 0 : (r.code || 1);
        const result = noRoom
            ? `RESULTADO: BACKUP DO BANCO NÃO INICIADO (sem espaço) · archivelogs: ${r.ok ? 'copiados' : `FALHOU${r.errors.length ? ` (${r.errors.join(', ')})` : ''}`}`
            : r.ok ? 'RESULTADO: OK' : `RESULTADO: FALHOU${r.errors.length ? ` (${r.errors.join(', ')})` : ''}`;
        text = [`Oracle Pulse - ${schedule.JOB_LABEL[job]} (${started.toLocaleString('pt-BR')})`, ...(pre.text ? [pre.text, ''] : []),
            `RMAN> ${lines.join('\nRMAN> ')}`, '', r.output, '', result].join('\n');
    } catch (err) {
        text = `Erro ao executar ${job}: ${backupAdmin.scrubSecrets(err.message)}`;
    }
    fs.writeFileSync(log, text);
    fs.writeFileSync(statusFile, JSON.stringify({ start: started.getTime(), rc, log, end: Date.now() }));
    audit.record({ action: 'backup-agendado', user: 'agendador', role: 'sistema', ip: 'local', success: rc === 0, detail: `${job} rc=${rc}${rc === preflight.NOROOM_RC ? ' (sem espaço: só archivelogs)' : ''}` });
    prune(dir, job);
    return rc;
}

main().then((rc) => process.exit(rc), (err) => {
    console.error(err);
    process.exit(1);
});

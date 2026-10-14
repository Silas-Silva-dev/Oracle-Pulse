/**
 * LOGMAINTENANCE.JS - "Limpar todos os logs" (tela Backup & Auditoria, DBA + senha).
 *
 * Apaga:
 *  - a trilha de auditoria (audit.log e audit.log.1);
 *  - os logs dos backups agendados (Windows: logs\backup\*.log; Linux: <base>/logs/*.log
 *    no servidor do banco);
 *  - o histórico de ações do guardião da FRA;
 *  - os logs do serviço do Windows e demais *.log da pasta de logs (o que estiver
 *    preso pelo serviço é zerado em vez de apagado).
 *
 * Mantém (não são logs): configurações, status das tarefas agendadas (sem eles o
 * painel acusaria "backup atrasado") e o retrato usado pela tela Recuperação.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const audit = require('./audit');
const fraGuard = require('./fraGuard');
const backupSchedule = require('./backupSchedule');
const logger = require('./logger');

const isLogFile = (name) => /\.log(\.\d+)?$/i.test(name);

/** Apaga (ou zera, se estiver preso) os *.log de uma pasta. */
function clearDir(dir, result) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
        if (!isLogFile(name)) continue;
        const file = path.join(dir, name);
        let size = 0;
        try {
            const st = fs.statSync(file);
            if (!st.isFile()) continue;
            size = st.size;
            fs.unlinkSync(file);
            result.files++;
            result.bytes += size;
        } catch (err) {
            try {
                fs.truncateSync(file, 0);
                result.files++;
                result.bytes += size;
            } catch {
                result.skipped.push(name);
                logger.warn(`Limpeza de logs: ${name} não pôde ser apagado (${err.code || err.message}).`);
            }
        }
    }
}

/** Logs dos backups agendados no servidor Linux (via SSH). */
async function clearRemote(schedule) {
    const inst = schedule && schedule.installed;
    if (config.demoMode || !inst || inst.os !== 'linux') return null;
    const base = String(inst.base || '');
    if (!/^\/[\w./-]+$/.test(base) || base.includes('..')) return 'caminho do agendamento inválido';
    try {
        const { execOnServer } = require('./osDisk');
        const r = await execOnServer(`n=$(find '${base}/logs' -maxdepth 1 -type f -name '*.log' 2>/dev/null | wc -l); find '${base}/logs' -maxdepth 1 -type f -name '*.log' -delete 2>/dev/null; echo "@@OP:COUNT:$n"`, { timeoutMs: 30000 });
        const m = /@@OP:COUNT:\s*(\d+)/.exec(r.stdout || '');
        return m ? Number(m[1]) : `sem resposta do servidor (${(r.stderr || '').trim().slice(0, 120)})`;
    } catch (err) {
        return `servidor inacessível (${err.message.split('\n')[0]})`;
    }
}

/**
 * @returns {Promise<{files:number, bytes:number, skipped:string[], remote:number|string|null}>}
 *   remote: nº de logs apagados no servidor Linux, texto do erro, ou null (não se aplica)
 */
async function clearAll() {
    const result = { files: 0, bytes: 0, skipped: [], remote: null };
    const a = audit.clear();
    result.files += a.files;
    result.bytes += a.bytes;
    const g = fraGuard.clearHistory();
    result.files += g.files;
    result.bytes += g.bytes;
    clearDir(backupSchedule.WIN_LOG_DIR(), result);
    clearDir(config.paths.logs, result);
    result.remote = await clearRemote(backupSchedule.loadSettings().schedule);
    return result;
}

module.exports = { clearAll, isLogFile };

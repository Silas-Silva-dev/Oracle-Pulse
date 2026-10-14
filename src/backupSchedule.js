/**
 * BACKUPSCHEDULE.JS - Backups agendados NO SERVIDOR DE BANCO (rodam mesmo com o
 * painel desligado) e configurações da proteção da FRA.
 *
 *  Linux  : scripts em /opt/oraclepulse (root) ou ~/oraclepulse (usuário do
 *           Oracle) + /etc/cron.d/oraclepulse (ou crontab do usuário). O RMAN
 *           roda como o dono do Oracle com autenticação do SO ("rman target /"):
 *           nenhuma senha é gravada no servidor.
 *  Windows: tarefas no Agendador (\OraclePulse\) que executam
 *           <painel>\bin\scheduled-job.js com o Node do próprio painel, como
 *           SYSTEM. A senha do SYS continua só no .env (protegido) e vai ao
 *           RMAN pela entrada padrão, como nos backups manuais.
 *
 * Cada execução grava um log e um arquivo de status; o painel lê esses status
 * para mostrar o histórico e alertar falhas ou atrasos.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { detectServerOs, execOnServer, psEncoded } = require('./osDisk');
const sp = require('./storagePaths');
const preflight = require('./backupPreflight');

class ScheduleError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// O DEMO tem arquivo próprio: uma "instalação" simulada nunca aparece no modo real.
const SETTINGS_FILE = () => path.join(config.paths.logs, config.demoMode ? 'backup-protection.demo.json' : 'backup-protection.json');
const APP_DIR = path.join(__dirname, '..');
const WIN_LOG_DIR = () => path.join(config.paths.logs, 'backup');
const LINUX_ROOT_BASE = '/opt/oraclepulse';
const CRON_FILE = '/etc/cron.d/oraclepulse';
const TASK_PATH = '\\OraclePulse\\';
const JOBS = ['full', 'level0', 'level1', 'archivelog'];
const JOB_LABEL = { full: 'Backup completo', level0: 'Backup incremental nível 0', level1: 'Backup incremental nível 1', archivelog: 'Backup de archivelogs' };
const TASK_NAME = { full: 'Backup completo', level0: 'Backup nivel 0', level1: 'Backup nivel 1', archivelog: 'Backup de archivelogs' };
const DAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const PS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ARCH_HOURS = [0, 1, 2, 3, 4, 6, 8, 12];

const DEFAULT_SCHEDULE = {
    strategy: 'full',          // 'full' (completo diário) | 'incremental' (nível 0 semanal + nível 1 diário)
                               // | 'archivelog' (só archivelogs: o banco tem backup por outra ferramenta)
    level0Day: 0,              // domingo
    time: '01:00',
    archivelogHours: 4,        // 0 = sem backup periódico de archives
    archKeepDays: 7,           // só archivelogs: dias que os backups de archivelog ficam guardados
    destination: 'fra',        // 'fra' | 'dir'
    directory: '',
    compress: true,
    installed: null,           // { at, by, os, mode, base, runAs }
};
const STRATEGIES = ['full', 'incremental', 'archivelog'];

const DEFAULT_GUARD = {
    enabled: true,
    targetPct: 70,             // a partir daqui: backup dos archives + limpeza
    growPct: 85,               // a partir daqui (ou se for encher em < 30 min): aumenta o limite
    emergencyPct: 95,          // a partir daqui (ou archiver travado): todas as medidas
    growStepPct: 20,           // aumento mínimo: 20% do limite (no mínimo 5 GB)
    diskReservePct: 10,        // o volume da FRA nunca fica com menos de 10% (mín. 2 GB) livre
    maxSizeGb: 0,              // teto do limite da FRA (0 = só o disco limita)
    emergencyDir: '',          // diretório em OUTRO disco para despejar os archives
    lastResort: true,          // apagar archives antigos sem backup se nada mais funcionar
};

// ==========================================================================
// Configurações (logs/backup-protection.json)
// ==========================================================================

function loadSettings() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch { /* primeira vez */ }
    return {
        schedule: { ...DEFAULT_SCHEDULE, ...(raw.schedule || {}) },
        guard: { ...DEFAULT_GUARD, ...(raw.guard || {}) },
        guardState: raw.guardState || {},
    };
}

function saveSettings(settings) {
    fs.mkdirSync(config.paths.logs, { recursive: true });
    const tmp = SETTINGS_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    fs.renameSync(tmp, SETTINGS_FILE());
}

function updateSettings(patch) {
    const s = loadSettings();
    const next = {
        schedule: { ...s.schedule, ...(patch.schedule || {}) },
        guard: { ...s.guard, ...(patch.guard || {}) },
        guardState: { ...s.guardState, ...(patch.guardState || {}) },
    };
    saveSettings(next);
    return next;
}

// ==========================================================================
// Validação
// ==========================================================================

function intIn(v, label, min, max) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new ScheduleError(`${label}: informe um número inteiro entre ${min} e ${max}.`);
    return n;
}

/** Diretório para backup/emergência: absoluto, no padrão do SO do banco, sem ASM. */
function validateDir(dir, serverOs, label) {
    let norm;
    try {
        norm = sp.validateCustomDir(dir, serverOs === 'windows' ? 'windows' : 'posix');
    } catch (err) {
        throw new ScheduleError(`${label}: ${err.message}`);
    }
    if (sp.pathStyle(norm) === 'asm') throw new ScheduleError(`${label}: use um diretório do sistema de arquivos (ASM não é suportado aqui).`);
    if (/[$`]/.test(norm)) throw new ScheduleError(`${label}: o caminho não pode conter "$" ou crase.`);
    const sep = serverOs === 'windows' ? '\\' : '/';
    return norm.endsWith(sep) ? norm : norm + sep;
}

function validateSchedule(input, serverOs) {
    const s = { ...DEFAULT_SCHEDULE, ...(input || {}) };
    if (!STRATEGIES.includes(s.strategy)) throw new ScheduleError('Estratégia inválida.');
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s.time || ''));
    if (!m) throw new ScheduleError('Horário inválido: use HH:MM (ex.: 01:00).');
    const level0Day = intIn(s.level0Day, 'Dia do nível 0', 0, 6);
    const archivelogHours = Number(s.archivelogHours);
    if (!ARCH_HOURS.includes(archivelogHours)) throw new ScheduleError(`Intervalo dos archivelogs inválido (use ${ARCH_HOURS.filter(Boolean).join(', ')} horas ou desligado).`);
    if (s.strategy === 'archivelog' && !archivelogHours) throw new ScheduleError('Na estratégia "somente archivelogs" escolha de quantas em quantas horas o backup roda.');
    const archKeepDays = intIn(s.archKeepDays, 'Guardar os backups de archivelog (dias)', 1, 90);
    if (!['fra', 'dir'].includes(s.destination)) throw new ScheduleError('Destino inválido.');
    const directory = s.destination === 'dir' ? validateDir(s.directory, serverOs, 'Diretório dos backups') : '';
    return {
        strategy: s.strategy, level0Day, time: s.time, archivelogHours, archKeepDays,
        destination: s.destination, directory, compress: s.compress !== false && s.compress !== 'false',
        installed: input && input.installed ? input.installed : null,
    };
}

function validateGuard(input, serverOs) {
    const g = { ...DEFAULT_GUARD, ...(input || {}) };
    const out = {
        enabled: g.enabled === true || g.enabled === 'true',
        targetPct: intIn(g.targetPct, 'Limite de atenção (%)', 30, 90),
        growPct: intIn(g.growPct, 'Limite para aumentar a FRA (%)', 40, 97),
        emergencyPct: intIn(g.emergencyPct, 'Limite de emergência (%)', 50, 99),
        growStepPct: intIn(g.growStepPct, 'Aumento por vez (%)', 5, 100),
        diskReservePct: intIn(g.diskReservePct, 'Reserva no disco (%)', 2, 50),
        maxSizeGb: intIn(g.maxSizeGb || 0, 'Teto da FRA (GB)', 0, 102400),
        emergencyDir: g.emergencyDir ? validateDir(g.emergencyDir, serverOs, 'Diretório de emergência') : '',
        lastResort: g.lastResort === true || g.lastResort === 'true',
    };
    if (!(out.targetPct < out.growPct && out.growPct < out.emergencyPct)) {
        throw new ScheduleError('Os limites precisam crescer: atenção < aumentar a FRA < emergência.');
    }
    return out;
}

// ==========================================================================
// Comandos RMAN de cada tarefa (puros)
// ==========================================================================

function rmanLines(job, schedule) {
    const comp = schedule.compress ? ' AS COMPRESSED BACKUPSET' : '';
    const fmt = (tag) => (schedule.destination === 'dir' && schedule.directory ? ` FORMAT '${schedule.directory}%d_${tag}_%T_%U'` : '');
    const tail = ['DELETE NOPROMPT OBSOLETE;', 'CROSSCHECK ARCHIVELOG ALL;', 'DELETE NOPROMPT EXPIRED ARCHIVELOG ALL;'];
    switch (job) {
        case 'full':
            return [`BACKUP${comp} DATABASE${fmt('DB')} PLUS ARCHIVELOG${fmt('ARC')} DELETE INPUT;`, ...tail];
        case 'level0':
            return [`BACKUP${comp} INCREMENTAL LEVEL 0 DATABASE${fmt('L0')} PLUS ARCHIVELOG${fmt('ARC')} DELETE INPUT;`, ...tail];
        case 'level1':
            return [`BACKUP${comp} INCREMENTAL LEVEL 1 DATABASE${fmt('L1')} PLUS ARCHIVELOG${fmt('ARC')} DELETE INPUT;`, ...tail];
        case 'archivelog':
            return [
                // Lotes de 8 archives: cada lote é apagado assim que copiado (menos pico de espaço).
                `BACKUP${comp} ARCHIVELOG ALL NOT BACKED UP 1 TIMES FILESPERSET 8${fmt('ARC')} DELETE INPUT;`,
                'DELETE NOPROMPT ARCHIVELOG ALL BACKED UP 1 TIMES TO DEVICE TYPE DISK;',
                ...archOnlyRetention(schedule),
            ];
        default:
            throw new ScheduleError(`Tarefa desconhecida: ${job}`);
    }
}

/**
 * Só archivelogs: sem backup do banco no RMAN, o DELETE OBSOLETE não tem
 * referência para descartar backups de archivelog — a retenção é por dias.
 */
function archOnlyRetention(schedule) {
    if (schedule.strategy !== 'archivelog') return [];
    const days = Number(schedule.archKeepDays) || DEFAULT_SCHEDULE.archKeepDays;
    return [`DELETE NOPROMPT BACKUP OF ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE-${days}';`];
}

/** Tarefas ativas para o agendamento. */
function activeJobs(schedule) {
    const jobs = schedule.strategy === 'incremental' ? ['level0', 'level1'] : schedule.strategy === 'archivelog' ? [] : ['full'];
    if (schedule.archivelogHours > 0) jobs.push('archivelog');
    return jobs;
}

/** Texto amigável do agendamento de uma tarefa. */
function describeJob(job, s) {
    const others = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== s.level0Day).map((d) => DAY_NAMES[d]);
    if (job === 'full') return `todo dia às ${s.time}`;
    if (job === 'level0') return `${DAY_NAMES[s.level0Day]} às ${s.time}`;
    if (job === 'level1') return `${others.length === 6 ? 'demais dias' : others.join(', ')} às ${s.time}`;
    return `a cada ${s.archivelogHours} h (minuto ${archMinute(s)})`;
}

function archMinute(s) {
    const mm = Number(s.time.split(':')[1]);
    return (mm + 30) % 60;
}

// ==========================================================================
// Linux: cron + scripts (puros)
// ==========================================================================

/** Linhas de agendamento (formato do /etc/cron.d quando runAs é informado). */
function cronLines(schedule, base, runAs) {
    const [hh, mm] = schedule.time.split(':').map(Number);
    const who = runAs ? `${runAs} ` : '';
    const cmd = (job) => `${who}${base}/bin/run-job.sh ${job}`;
    const lines = [];
    if (schedule.strategy === 'incremental') {
        const others = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== schedule.level0Day).join(',');
        lines.push(`${mm} ${hh} * * ${schedule.level0Day} ${cmd('level0')}`);
        lines.push(`${mm} ${hh} * * ${others} ${cmd('level1')}`);
    } else if (schedule.strategy === 'full') {
        lines.push(`${mm} ${hh} * * * ${cmd('full')}`);
    }
    if (schedule.archivelogHours > 0) lines.push(`${archMinute(schedule)} */${schedule.archivelogHours} * * * ${cmd('archivelog')}`);
    return lines;
}

/**
 * Script que o cron executa: verifica o espaço (backups do banco), roda o RMAN,
 * grava log e status. Código 3 = backup do banco não iniciado por falta de espaço.
 */
function buildLinuxRunScript(ctx) {
    const pf = ctx.pf || preflight.params(DEFAULT_SCHEDULE, DEFAULT_GUARD);
    return [
        '#!/bin/sh',
        '# Oracle Pulse - executa um backup agendado. Gerado pelo painel: nao edite a mao.',
        'JOB="$1"',
        `BASE='${ctx.base}'`,
        `ORACLE_HOME='${ctx.home}'; export ORACLE_HOME`,
        `ORACLE_SID='${ctx.sid}'; export ORACLE_SID`,
        "NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS'; export NLS_DATE_FORMAT",
        'PATH="$ORACLE_HOME/bin:/usr/bin:/bin:$PATH"; export PATH',
        `PF_COMP=${pf.comp}; PF_TODIR=${pf.todir}; PF_DIR='${pf.dir}'; PF_GROW=${pf.growPct}; PF_RESERVE=${pf.reservePct}; PF_MAXGB=${pf.maxGb}`,
        'case "$JOB" in full|level0|level1|archivelog) ;; *) echo "tarefa invalida: $JOB" >&2; exit 2;; esac',
        '[ -f "$BASE/rman/$JOB.rcv" ] || { echo "sem $BASE/rman/$JOB.rcv" >&2; exit 2; }',
        'if command -v flock >/dev/null 2>&1; then',
        '  exec 9>"$BASE/status/$JOB.lock"',
        '  flock -n 9 || { echo "$JOB ja esta em execucao" >&2; exit 0; }',
        'fi',
        'STAMP=$(date +%Y%m%d_%H%M%S)',
        'LOG="$BASE/logs/$JOB""_$STAMP.log"',
        'START=$(date +%s)',
        'echo "$START|running|$LOG|" > "$BASE/status/$JOB.status"',
        'RCV="$BASE/rman/$JOB.rcv"',
        'PFRC=0',
        ': > "$LOG"',
        ...preflight.linuxShell(),
        '"$ORACLE_HOME/bin/rman" target / cmdfile="$RCV" log="$LOG" append >/dev/null 2>&1',
        'RC=$?',
        'if [ "$PFRC" -ne 0 ]; then RC=$PFRC; fi',
        'echo "$START|$RC|$LOG|$(date +%s)" > "$BASE/status/$JOB.status"',
        'find "$BASE/logs" -name "$JOB""_*.log" -mtime +30 -exec rm -f {} \\; 2>/dev/null',
        'exit $RC',
    ].join('\n') + '\n';
}

function heredoc(target, content, tag = 'OPEOF') {
    if (content.split('\n').includes(tag)) throw new ScheduleError('Conteúdo inválido para o script.');
    return [`cat > ${target} <<'${tag}'`, content.replace(/\n$/, ''), tag];
}

/**
 * Script de instalação (Linux, roda como o usuário do SSH via "sh -s").
 * root  → /opt/oraclepulse + /etc/cron.d/oraclepulse (executa como runAs)
 * outro → ~/oraclepulse + crontab do próprio usuário (precisa ser o dono do Oracle)
 */
function buildLinuxInstallScript(schedule, ctx, guard = DEFAULT_GUARD) {
    const jobs = activeJobs(schedule);
    const pf = preflight.params(schedule, guard);
    const lines = [
        'set -e',
        'LC_ALL=C; export LC_ALL',
        `RUNAS='${ctx.runAs}'`,
        'if [ "$(id -u)" = "0" ]; then MODE=root; BASE=' + LINUX_ROOT_BASE + '; else MODE=user; BASE="$HOME/oraclepulse"; fi',
        'id "$RUNAS" >/dev/null 2>&1 || { echo "@@OP:ERR:NOUSER"; exit 3; }',
        'if [ "$MODE" = user ] && [ "$(id -un)" != "$RUNAS" ]; then echo "@@OP:ERR:NOTOWNER"; exit 3; fi',
        'GRP=$(id -gn "$RUNAS")',
        'mkdir -p "$BASE/bin" "$BASE/rman" "$BASE/logs" "$BASE/status"',
        'rm -f "$BASE"/rman/*.rcv',
    ];
    // O run-job.sh precisa do BASE real: é gerado com um marcador e ajustado no servidor.
    lines.push(...heredoc('"$BASE/bin/run-job.sh"', buildLinuxRunScript({ ...ctx, base: '@@BASE@@', pf })));
    lines.push('sed -i "s#@@BASE@@#$BASE#" "$BASE/bin/run-job.sh"');
    for (const job of jobs) lines.push(...heredoc(`"$BASE/rman/${job}.rcv"`, rmanLines(job, schedule).join('\n') + '\n'));
    // Verificação de espaço antes dos backups do banco e o plano B (só archivelogs).
    lines.push(...heredoc('"$BASE/rman/preflight.sql"', preflight.linuxSqlFile()));
    lines.push(...heredoc('"$BASE/bin/preflight.awk"', preflight.linuxAwk()));
    lines.push(...heredoc('"$BASE/rman/fallback.rcv"', rmanLines('archivelog', schedule).join('\n') + '\n'));
    lines.push(
        'chmod 755 "$BASE/bin/run-job.sh"',
        'chmod 644 "$BASE"/rman/*.rcv "$BASE/rman/preflight.sql" "$BASE/bin/preflight.awk"',
        'chown -R "$RUNAS:$GRP" "$BASE/rman" "$BASE/logs" "$BASE/status"',
        'chmod 750 "$BASE/logs" "$BASE/status"',
        'if [ "$MODE" = root ]; then',
    );
    const cronRoot = ['# Oracle Pulse - backups agendados. Gerado pelo painel: nao edite a mao.', 'SHELL=/bin/sh', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
        ...cronLines(schedule, '@@BASE@@', ctx.runAs)].join('\n') + '\n';
    // Sem indentação: o corpo e o terminador do heredoc vão para o arquivo como estão.
    lines.push(...heredoc(CRON_FILE, cronRoot));
    lines.push(
        `  sed -i "s#@@BASE@@#$BASE#g" ${CRON_FILE}`,
        `  chmod 644 ${CRON_FILE}`,
        '  echo "@@OP:CRON:' + CRON_FILE + '"',
        'else',
        '  TMP=$(mktemp)',
        '  (crontab -l 2>/dev/null | grep -v "# oraclepulse$" || true) > "$TMP"',
    );
    for (const l of cronLines(schedule, '@@BASE@@', null)) lines.push(`  echo '${l} # oraclepulse' >> "$TMP"`);
    lines.push(
        '  sed -i "s#@@BASE@@#$BASE#g" "$TMP"',
        '  crontab "$TMP"',
        '  rm -f "$TMP"',
        '  echo "@@OP:CRON:crontab"',
        'fi',
        'echo "@@OP:BASE:$BASE"',
        'echo "@@OP:MODE:$MODE"',
        'echo "@@OP:OK"',
    );
    return lines.join('\n') + '\n';
}

function buildLinuxRemoveScript() {
    return [
        'LC_ALL=C; export LC_ALL',
        'if [ "$(id -u)" = "0" ]; then BASE=' + LINUX_ROOT_BASE + '; rm -f ' + CRON_FILE + '; else BASE="$HOME/oraclepulse"; fi',
        // grep -v sai com 1 quando não sobra nenhuma linha: grava o crontab mesmo assim.
        'if crontab -l >/dev/null 2>&1; then',
        '  TMP=$(mktemp)',
        '  crontab -l 2>/dev/null | grep -v "# oraclepulse$" > "$TMP" || true',
        '  crontab "$TMP"',
        '  rm -f "$TMP"',
        'fi',
        'rm -rf "$BASE/bin" "$BASE/rman"',
        'echo "@@OP:OK"',
    ].join('\n') + '\n';
}

function buildLinuxStatusScript() {
    return [
        'LC_ALL=C; export LC_ALL',
        'if [ "$(id -u)" = "0" ]; then BASE=' + LINUX_ROOT_BASE + '; else BASE="$HOME/oraclepulse"; fi',
        '[ -f ' + CRON_FILE + ' ] && echo "@@OP:CRON:' + CRON_FILE + '"',
        'crontab -l 2>/dev/null | grep -q "# oraclepulse$" && echo "@@OP:CRON:crontab"',
        'for f in "$BASE"/status/*.status; do [ -f "$f" ] && echo "@@OP:STATUS:$(basename "$f" .status)|$(cat "$f")"; done',
        'echo "@@OP:BASE:$BASE"',
    ].join('\n') + '\n';
}

// ==========================================================================
// Windows: Agendador de Tarefas (puro)
// ==========================================================================

function psq(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}

function buildWindowsInstallScript(schedule, ctx) {
    const lines = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$node = ${psq(ctx.node)}`,
        `$script = ${psq(ctx.script)}`,
        `$work = ${psq(ctx.workDir)}`,
        `$tp = ${psq(TASK_PATH)}`,
        'Get-ScheduledTask -TaskPath $tp -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false',
        "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
        '$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 12)',
        'function Add-Job($name, $job, $trigger) {',
        "  $a = New-ScheduledTaskAction -Execute $node -Argument ('\"' + $script + '\" ' + $job) -WorkingDirectory $work",
        "  Register-ScheduledTask -TaskName $name -TaskPath $tp -Action $a -Trigger $trigger -Principal $principal -Settings $set -Description 'Oracle Pulse - backup agendado' | Out-Null",
        "  Write-Output ('@@OP:TASK:' + $name)",
        '}',
    ];
    const at = psq(schedule.time);
    if (schedule.strategy === 'incremental') {
        const others = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== schedule.level0Day).map((d) => PS_DAYS[d]).join(',');
        lines.push(`Add-Job ${psq(TASK_NAME.level0)} 'level0' (New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${PS_DAYS[schedule.level0Day]} -At ${at})`);
        lines.push(`Add-Job ${psq(TASK_NAME.level1)} 'level1' (New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${others} -At ${at})`);
    } else if (schedule.strategy === 'full') {
        lines.push(`Add-Job ${psq(TASK_NAME.full)} 'full' (New-ScheduledTaskTrigger -Daily -At ${at})`);
    }
    if (schedule.archivelogHours > 0) {
        // 00:MM e depois a cada N horas — os mesmos horários do cron "MM */N * * *".
        const archAt = psq(`00:${String(archMinute(schedule)).padStart(2, '0')}`);
        // Diário com repetição a cada N horas por 1 dia = indefinidamente (padrão estável no PowerShell 5.1).
        lines.push(`$t = New-ScheduledTaskTrigger -Daily -At ${archAt}`);
        lines.push(`$t.Repetition = (New-ScheduledTaskTrigger -Once -At ${archAt} -RepetitionInterval (New-TimeSpan -Hours ${schedule.archivelogHours}) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition`);
        lines.push(`Add-Job ${psq(TASK_NAME.archivelog)} 'archivelog' $t`);
    }
    lines.push("Write-Output '@@OP:OK'");
    return lines.join('\n');
}

function buildWindowsRemoveScript() {
    return [
        "$ProgressPreference = 'SilentlyContinue'",
        `Get-ScheduledTask -TaskPath ${psq(TASK_PATH)} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false`,
        "Write-Output '@@OP:OK'",
    ].join('\n');
}

function buildWindowsStatusScript() {
    return [
        "$ProgressPreference = 'SilentlyContinue'",
        `Get-ScheduledTask -TaskPath ${psq(TASK_PATH)} -ErrorAction SilentlyContinue | ForEach-Object {`,
        '  $i = $_ | Get-ScheduledTaskInfo',
        "  $last = ''; if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $last = $i.LastRunTime.ToString('s') }",
        "  $next = ''; if ($i.NextRunTime) { $next = $i.NextRunTime.ToString('s') }",
        "  Write-Output ('@@OP:TASK:' + $_.TaskName + '|' + [string]$_.State + '|' + $last + '|' + $next + '|' + $i.LastTaskResult)",
        '}',
    ].join('\n');
}

// ==========================================================================
// Saída/estado (puros)
// ==========================================================================

function parseMarkers(text) {
    const out = { ok: false, error: null, cron: [], base: null, mode: null, status: {}, tasks: {}, log: [] };
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        const m = /^@@OP:([A-Z]+):?(.*)$/.exec(line);
        if (!m) { if (line) out.log.push(line); continue; }
        const [, k, v] = m;
        if (k === 'OK') out.ok = true;
        else if (k === 'ERR') out.error = v;
        else if (k === 'CRON') out.cron.push(v);
        else if (k === 'BASE') out.base = v;
        else if (k === 'MODE') out.mode = v;
        else if (k === 'STATUS') {
            const [job, start, rc, logFile, end] = v.split('|');
            out.status[job] = { start: num(start) && num(start) * 1000, rc: rc === 'running' ? 'running' : num(rc), log: logFile || null, end: num(end) && num(end) * 1000 };
        } else if (k === 'TASK') {
            const [name, state, last, next, result] = v.split('|');
            out.tasks[name] = { state: state || null, last: last || null, next: next || null, result: result === undefined || result === '' ? null : Number(result) };
        }
    }
    return out;
}

function num(v) {
    const n = Number(v);
    return v === '' || v == null || !Number.isFinite(n) ? null : n;
}

/** Próxima execução prevista (horário local do painel ≈ do servidor). */
function nextRun(job, s, now = Date.now()) {
    const [hh, mm] = s.time.split(':').map(Number);
    const base = new Date(now);
    if (job === 'archivelog') {
        if (!s.archivelogHours) return null;
        const minute = archMinute(s);
        for (let h = 0; h < 48; h++) {
            const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), base.getHours() + h, minute, 0);
            if (d.getHours() % s.archivelogHours === 0 && d.getTime() > now) return d.getTime();
        }
        return null;
    }
    for (let i = 0; i < 8; i++) {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, hh, mm, 0);
        if (d.getTime() <= now) continue;
        const dow = d.getDay();
        if (job === 'full' || (job === 'level0' && dow === s.level0Day) || (job === 'level1' && dow !== s.level0Day)) return d.getTime();
    }
    return null;
}

/**
 * Situação de cada tarefa + alertas (falha, atraso).
 * statuses: { job: { start, rc, end, log } }
 */
function evaluateJobs(schedule, statuses, now = Date.now()) {
    const installedAt = schedule.installed ? Date.parse(schedule.installed.at) : null;
    const jobs = activeJobs(schedule).map((job) => {
        const st = statuses[job] || null;
        let state = 'never';
        if (st && st.rc === 'running') state = (now - (st.start || now)) > 12 * 3600000 ? 'stuck' : 'running';
        else if (st && st.rc === 0) state = 'ok';
        else if (st && st.rc === preflight.NOROOM_RC && job !== 'archivelog') state = 'noroom';
        else if (st && st.rc != null) state = 'failed';
        return { job, label: JOB_LABEL[job], when: describeJob(job, schedule), state, start: st && st.start, end: st && st.end, rc: st ? st.rc : null, log: st && st.log, next: nextRun(job, schedule, now) };
    });
    const alerts = [];
    if (!installedAt) return { jobs, alerts };
    for (const j of jobs) {
        if (j.state === 'failed') alerts.push({ id: `backup-failed:${j.job}`, severity: 'critical', message: `${j.label} agendado falhou em ${fmt(j.end || j.start)} — veja o log na tela Backup.` });
        if (j.state === 'noroom') alerts.push({ id: `backup-failed:${j.job}`, severity: 'critical', message: `${j.label} agendado NÃO foi iniciado em ${fmt(j.end || j.start)}: não há espaço para ele sem lotar a FRA (só os archivelogs foram copiados). Aponte os backups para um diretório em outro disco.` });
        if (j.state === 'stuck') alerts.push({ id: `backup-stuck:${j.job}`, severity: 'warning', message: `${j.label} agendado está em execução há mais de 12 h.` });
    }
    // Atraso: nenhum backup do banco nas últimas 26 h (ou 2 intervalos de archivelog).
    // Na estratégia "somente archivelogs" o backup do banco é feito por fora: não há o que cobrar.
    const dbJobs = jobs.filter((j) => j.job !== 'archivelog');
    const lastDb = Math.max(0, ...dbJobs.filter((j) => j.state === 'ok').map((j) => j.end || j.start || 0));
    const dbLimit = 26 * 3600000;
    if (dbJobs.length && now - installedAt > dbLimit && now - lastDb > dbLimit) {
        alerts.push({ id: 'backup-late', severity: 'critical', message: `Nenhum backup agendado do banco concluiu nas últimas 26 h${lastDb ? ` (último: ${fmt(lastDb)})` : ''}.` });
    }
    const arch = jobs.find((j) => j.job === 'archivelog');
    if (arch) {
        const lim = (schedule.archivelogHours * 2 + 0.5) * 3600000;
        const lastArch = Math.max(arch.state === 'ok' ? (arch.end || arch.start || 0) : 0, lastDb);
        if (now - installedAt > lim && now - lastArch > lim) {
            alerts.push({ id: 'backup-arch-late', severity: 'warning', message: `O backup de archivelogs (a cada ${schedule.archivelogHours} h) não concluiu nas últimas ${Math.round(lim / 3600000)} h.` });
        }
    }
    return { jobs, alerts };
}

function fmt(ms) {
    if (!ms) return '--';
    return new Date(ms).toLocaleString('pt-BR');
}

// ==========================================================================
// Operações no servidor
// ==========================================================================

async function context() {
    const serverOs = config.demoMode ? 'linux' : await detectServerOs();
    if (!config.demoMode && serverOs === 'windows' && config.ssh.host) {
        throw new ScheduleError('Banco Windows: o agendamento é criado no próprio servidor. Instale o painel na máquina do banco (sem SSH).');
    }
    if (!config.demoMode && !config.oracleServer.rmanAutomationReady) {
        throw new ScheduleError('Defina DB_ORACLE_HOME e DB_ORACLE_SID no .env para agendar backups no servidor.');
    }
    if (!config.demoMode && serverOs === 'windows' && !config.oracleServer.usesPasswordAuth) {
        throw new ScheduleError('No Windows os backups agendados usam a senha do SYS: defina DB_SYS_PASSWORD no .env.');
    }
    return { serverOs };
}

function linuxCtx() {
    const id = (v, label) => {
        const s = String(v || '');
        if (!/^[A-Za-z0-9_./+@-]+$/.test(s)) throw new ScheduleError(`${label} inválido para o script: ${s}`);
        return s;
    };
    return {
        home: id(config.oracleServer.home, 'DB_ORACLE_HOME'),
        sid: id(config.oracleServer.sid, 'DB_ORACLE_SID'),
        runAs: id(config.oracleServer.osUser || 'oracle', 'DB_OS_USER'),
    };
}

function windowsCtx() {
    return { node: process.execPath, script: path.join(APP_DIR, 'bin', 'scheduled-job.js'), workDir: APP_DIR };
}

const ERR_TEXT = {
    NOUSER: 'o usuário dono do Oracle não existe no servidor (defina DB_OS_USER no .env, ex.: oracle).',
    NOTOWNER: 'o usuário do SSH não é root nem o dono do Oracle. Use SSH_USER=root (recomendado) ou o próprio usuário oracle.',
};

async function install(input, who) {
    const { serverOs } = await context();
    const schedule = validateSchedule(input, serverOs);
    let installed;
    if (config.demoMode) {
        installed = { at: new Date().toISOString(), by: who, os: 'linux', mode: 'root', base: LINUX_ROOT_BASE, runAs: 'oracle', where: CRON_FILE };
    } else if (serverOs === 'windows') {
        const r = await execOnServer(psEncoded(buildWindowsInstallScript(schedule, windowsCtx())), { timeoutMs: 60000 });
        const p = parseMarkers(`${r.stdout}\n${r.stderr}`);
        if (!p.ok) {
            const raw = (r.stderr || r.stdout || '').trim();
            const denied = /Acesso negado|Access is denied|0x80070005/i.test(raw);
            throw new ScheduleError(denied
                ? 'O Windows negou a criação das tarefas: o painel precisa rodar como Administrador (o serviço do instalador roda como SYSTEM).'
                : `Não foi possível criar as tarefas no Agendador: ${raw.split('\n').slice(-3).join(' ').slice(0, 400)}`, 500);
        }
        fs.mkdirSync(WIN_LOG_DIR(), { recursive: true });
        installed = { at: new Date().toISOString(), by: who, os: 'windows', mode: 'tasks', base: WIN_LOG_DIR(), runAs: 'SYSTEM', where: `Agendador de Tarefas ${TASK_PATH}` };
    } else {
        if (schedule.destination === 'dir') await ensureDir(schedule.directory);
        const r = await execOnServer('sh -s', { stdin: buildLinuxInstallScript(schedule, linuxCtx(), loadSettings().guard), timeoutMs: 60000 });
        const p = parseMarkers(`${r.stdout}\n${r.stderr}`);
        if (!p.ok) {
            const why = p.error ? ERR_TEXT[p.error] || p.error : (r.stderr || r.stdout || 'sem saída').trim().split('\n').slice(-3).join(' ').slice(0, 400);
            throw new ScheduleError(`Não foi possível instalar o agendamento no servidor: ${why}`, 500);
        }
        installed = { at: new Date().toISOString(), by: who, os: 'linux', mode: p.mode, base: p.base, runAs: linuxCtx().runAs, where: p.cron[0] || null };
    }
    const next = updateSettings({ schedule: { ...schedule, installed } });
    return next.schedule;
}

async function ensureDir(dir) {
    const { dirExistsOnServer } = require('./storage');
    const exists = await dirExistsOnServer(dir);
    if (exists === false) {
        const { createServerDir } = require('./backupAdmin');
        await createServerDir(dir.replace(/[\\/]$/, ''));
    }
}

async function remove() {
    const s = loadSettings();
    if (!config.demoMode && s.schedule.installed) {
        const os = s.schedule.installed.os;
        const r = os === 'windows'
            ? await execOnServer(psEncoded(buildWindowsRemoveScript()), { timeoutMs: 60000 })
            : await execOnServer('sh -s', { stdin: buildLinuxRemoveScript(), timeoutMs: 60000 });
        if (!parseMarkers(`${r.stdout}\n${r.stderr}`).ok) throw new ScheduleError(`Não foi possível remover o agendamento: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`, 500);
    }
    return updateSettings({ schedule: { ...s.schedule, installed: null } }).schedule;
}

/** Lê os status das execuções no servidor (Linux) ou nos logs do painel (Windows). */
async function readStatuses(schedule) {
    const inst = schedule.installed;
    if (!inst) return { statuses: {}, tasks: {} };
    if (config.demoMode) return { statuses: demoStatuses(schedule), tasks: {} };
    if (inst.os === 'windows') {
        const statuses = {};
        for (const job of JOBS) {
            try {
                const st = JSON.parse(fs.readFileSync(path.join(WIN_LOG_DIR(), `${job}.status.json`), 'utf8'));
                statuses[job] = st;
            } catch { /* nunca rodou */ }
        }
        const r = await execOnServer(psEncoded(buildWindowsStatusScript()), { timeoutMs: 30000 });
        return { statuses, tasks: parseMarkers(r.stdout).tasks };
    }
    const r = await execOnServer('sh -s', { stdin: buildLinuxStatusScript(), timeoutMs: 30000 });
    const p = parseMarkers(r.stdout);
    return { statuses: p.status, tasks: {}, cron: p.cron };
}

const DEMO_START = Date.now();
function demoStatuses(schedule) {
    const out = {};
    for (const job of activeJobs(schedule)) {
        const end = DEMO_START - (job === 'archivelog' ? 2 : 17) * 3600000;
        out[job] = { start: end - 9 * 60000, rc: 0, end, log: `${LINUX_ROOT_BASE}/logs/${job}_demo.log` };
    }
    return out;
}

const LOG_GONE = 'O log desta execução não existe mais (foi apagado na limpeza de logs). A próxima execução gera um novo.';

/** Últimas linhas do log de uma execução. */
async function readLog(schedule, job) {
    if (!JOBS.includes(job)) throw new ScheduleError('Tarefa desconhecida.');
    const { statuses } = await readStatuses(schedule);
    const st = statuses[job];
    if (!st || !st.log) throw new ScheduleError('Esta tarefa ainda não tem log.', 404);
    if (config.demoMode) {
        return `Recovery Manager: Release 19.0.0.0.0\nconnected to target database: ORCL (DBID=1612345678)\nusing target database control file instead of recovery catalog\n\nRMAN> ${rmanLines(job, schedule).join('\nRMAN> ')}\n\nStarting backup at ...\nFinished backup at ...\nDeleted 12 objects\nRecovery Manager complete.`;
    }
    if (schedule.installed.os === 'windows') {
        const file = path.resolve(st.log);
        if (!file.startsWith(path.resolve(WIN_LOG_DIR()))) throw new ScheduleError('Log fora da pasta de backups.');
        if (!fs.existsSync(file)) throw new ScheduleError(LOG_GONE, 404);
        const text = fs.readFileSync(file, 'utf8');
        return text.slice(-40000);
    }
    const base = schedule.installed.base || LINUX_ROOT_BASE;
    if (!st.log.startsWith(`${base}/logs/`) || !/^[\w./-]+$/.test(st.log)) throw new ScheduleError('Caminho de log inválido.');
    const r = await execOnServer(`tail -c 40000 '${st.log}'`);
    if (r.code !== 0 && /No such file/i.test(r.stderr || '')) throw new ScheduleError(LOG_GONE, 404);
    if (r.code !== 0) throw new ScheduleError(`Não foi possível ler o log: ${(r.stderr || '').trim().slice(0, 200)}`, 500);
    return r.stdout;
}

/** Dispara uma tarefa agora (no servidor, em segundo plano). */
async function runNow(schedule, job) {
    if (!activeJobs(schedule).includes(job)) throw new ScheduleError('Esta tarefa não está no agendamento atual.');
    if (!schedule.installed) throw new ScheduleError('Instale o agendamento antes.');
    if (config.demoMode) return;
    if (schedule.installed.os === 'windows') {
        const r = await execOnServer(psEncoded(`Start-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME[job])}; Write-Output '@@OP:OK'`));
        if (!parseMarkers(r.stdout).ok) throw new ScheduleError(`Não foi possível iniciar a tarefa: ${(r.stderr || '').trim().slice(0, 300)}`, 500);
        return;
    }
    const base = schedule.installed.base || LINUX_ROOT_BASE;
    const cmd = schedule.installed.mode === 'root'
        ? `su - ${schedule.installed.runAs} -c '${base}/bin/run-job.sh ${job}'`
        : `${base}/bin/run-job.sh ${job}`;
    const r = await execOnServer(`(setsid nohup ${cmd} >/dev/null 2>&1 &) ; echo @@OP:OK`);
    if (!parseMarkers(r.stdout).ok) throw new ScheduleError(`Não foi possível iniciar a tarefa: ${(r.stderr || '').trim().slice(0, 300)}`, 500);
}

/** Prévia do que será instalado (para a tela). */
function preview(input, serverOs) {
    const schedule = validateSchedule(input, serverOs);
    const jobs = activeJobs(schedule).map((job) => ({ job, label: JOB_LABEL[job], when: describeJob(job, schedule), rman: rmanLines(job, schedule) }));
    const where = serverOs === 'windows'
        ? `Agendador de Tarefas do Windows (${TASK_PATH}), executando como SYSTEM`
        : `cron do servidor (${CRON_FILE}, executando como ${config.oracleServer.osUser || 'oracle'})`;
    const cron = serverOs === 'windows' ? null : cronLines(schedule, LINUX_ROOT_BASE, config.oracleServer.osUser || 'oracle');
    return { schedule, jobs, where, cron };
}

module.exports = {
    ScheduleError, JOBS, JOB_LABEL, DEFAULT_SCHEDULE, DEFAULT_GUARD, TASK_PATH, STRATEGIES,
    loadSettings, saveSettings, updateSettings,
    validateSchedule, validateGuard, rmanLines, activeJobs, describeJob,
    cronLines, buildLinuxRunScript, buildLinuxInstallScript, buildLinuxRemoveScript, buildLinuxStatusScript,
    buildWindowsInstallScript, buildWindowsRemoveScript, buildWindowsStatusScript,
    parseMarkers, nextRun, evaluateJobs,
    install, remove, readStatuses, readLog, runNow, preview, context,
    WIN_LOG_DIR,
};

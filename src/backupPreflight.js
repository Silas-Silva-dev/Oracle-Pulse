/**
 * BACKUPPREFLIGHT.JS - Verificação de espaço ANTES de cada backup agendado do banco.
 *
 * Um backup gravado na própria FRA pode lotá-la no meio do caminho (ORA-19809 /
 * ORA-19804) e, enquanto ela está cheia, o archiver não grava: o banco pode parar.
 * O guardião mede a cada minuto e não acompanha um backup de vários GB, por isso a
 * conta é feita antes de começar:
 *
 *   necessário = backup estimado (histórico do RMAN ou tamanho usado do banco)
 *              + archives ainda sem backup (o "PLUS ARCHIVELOG")
 *              + folga para os archives gerados durante o backup
 *
 *   cabe na FRA                      → segue
 *   não cabe, mas o disco comporta   → aumenta o limite da FRA antes (mantendo a
 *                                      reserva do disco e o teto do guardião)
 *   não cabe de jeito nenhum         → o backup do banco NÃO começa: só os
 *                                      archivelogs são copiados (a FRA continua
 *                                      saudável) e a tarefa termina com código 3
 *
 * Com destino em diretório, quem precisa caber é o disco do diretório; a FRA só
 * precisa da folga para os archives.
 *
 * Windows: run() é chamado pelo bin/scheduled-job.js. Linux: o run-job.sh faz o
 * mesmo com o sqlplus local e o programa awk de linuxAwk() — a decisão é a mesma
 * (teste de paridade em test/backupPreflight.test.js).
 */
'use strict';

const DB_JOBS = ['full', 'level0', 'level1'];
const NOROOM_RC = 3;

// ==========================================================================
// Medição (SQL único para Windows e Linux; só inteiros: imune a NLS de vírgula)
// ==========================================================================

const SEP = "||'|~|'||";
const DONE = "j.status IN ('COMPLETED', 'COMPLETED WITH WARNINGS') AND j.input_type IN ('DB FULL', 'DB INCR') AND j.input_bytes > 0";
const ASM_DG = "g.name = UPPER(SUBSTR(f.name, 2, INSTR(f.name || '/', '/') - 2)) AND f.name LIKE '+%'";

// Várias linhas curtas (o SQL*Plus recusa linhas acima de 2499 caracteres), sem linha em branco.
const PF_SQL = [
    "SELECT 'PF~' || f.name",
    `  ${SEP}ROUND(f.space_limit / 1048576)${SEP}ROUND(f.space_used / 1048576)${SEP}ROUND(f.space_reclaimable / 1048576)`,
    `  ${SEP}(SELECT value FROM v$parameter WHERE name = 'spfile')`,
    `  ${SEP}(SELECT ROUND(SUM(bytes) / 1048576) FROM v$datafile)`,
    // proporção saída/entrada do maior backup recente (o nível 0/completo tem a maior)
    `  ${SEP}(SELECT ROUND(MAX(j.output_bytes / j.input_bytes) * 10000) FROM v$rman_backup_job_details j`,
    `     WHERE ${DONE} AND j.end_time > SYSDATE - 35)`,
    // maior nível 1 recente (incrementais bem menores que o nível 0)
    `  ${SEP}(SELECT ROUND(MAX(j.output_bytes) / 1048576) FROM v$rman_backup_job_details j`,
    `     WHERE ${DONE} AND j.input_type = 'DB INCR' AND j.end_time > SYSDATE - 15`,
    '     AND j.output_bytes / j.input_bytes < 0.5 * (SELECT MAX(k.output_bytes / k.input_bytes) FROM v$rman_backup_job_details k',
    "     WHERE k.status IN ('COMPLETED', 'COMPLETED WITH WARNINGS') AND k.input_type IN ('DB FULL', 'DB INCR') AND k.input_bytes > 0 AND k.end_time > SYSDATE - 35))",
    `  ${SEP}(SELECT ROUND(NVL(SUM(a.blocks * a.block_size), 0) / 1048576) FROM v$archived_log a`,
    "     WHERE a.deleted = 'NO' AND a.status = 'A' AND a.backup_count = 0 AND a.is_recovery_dest_file = 'YES')",
    // pico de archives por hora (7 dias): base da folga durante o backup
    `  ${SEP}(SELECT ROUND(NVL(MAX(SUM(a.blocks * a.block_size)), 0) / 1048576) FROM v$archived_log a`,
    "     WHERE a.first_time > SYSDATE - 7 AND a.standby_dest = 'NO' GROUP BY a.dest_id, TRUNC(a.first_time, 'HH24'))",
    `  ${SEP}(SELECT ROUND(MAX(j.elapsed_seconds) / 60) FROM v$rman_backup_job_details j WHERE ${DONE} AND j.end_time > SYSDATE - 35)`,
    `  ${SEP}(SELECT MAX(GREATEST(g.usable_file_mb, 0)) FROM v$asm_diskgroup_stat g WHERE ${ASM_DG})`,
    `  ${SEP}(SELECT MAX(ROUND(g.total_mb / DECODE(g.type, 'NORMAL', 2, 'HIGH', 3, 1))) FROM v$asm_diskgroup_stat g WHERE ${ASM_DG})`,
    'FROM v$recovery_file_dest f',
].join('\n');

// Separado: com o banco só montado o dicionário não abre e a medição principal continua valendo.
const PU_SQL = "SELECT 'PU~' || ROUND(SUM(bytes) / 1048576) FROM dba_segments";

const SQLPLUS_SET = ['SET PAGESIZE 0', 'SET LINESIZE 32767', 'SET HEADING OFF', 'SET FEEDBACK OFF', 'SET TRIMOUT ON', 'SET VERIFY OFF'];

function num(v) {
    const n = Number(v);
    return v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(n) ? null : n;
}

function parse(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim());
    const pf = lines.find((l) => l.startsWith('PF~'));
    if (!pf) return null;
    const f = pf.slice(3).split('|~|');
    const pu = lines.find((l) => l.startsWith('PU~'));
    return {
        dest: f[0] || null,
        limitMb: num(f[1]) || 0,
        usedMb: num(f[2]) || 0,
        reclaimMb: num(f[3]) || 0,
        spfile: f[4] || null,
        dbMb: num(f[5]) || 0,
        ratio: num(f[6]) != null ? num(f[6]) / 10000 : null,
        l1Mb: num(f[7]),
        unbackedMb: num(f[8]) || 0,
        peakHourMb: num(f[9]) || 0,
        backupMin: num(f[10]),
        asmFreeMb: num(f[11]),
        asmTotalMb: num(f[12]),
        usedDbMb: pu ? num(pu.slice(3)) : null,
    };
}

// ==========================================================================
// Estimativa e decisão (puras — o awk do Linux repete estas contas)
// ==========================================================================

function estimate(job, schedule, m) {
    const comp = !!schedule.compress;
    const usedDb = m.usedDbMb > 0 ? m.usedDbMb : (m.dbMb || 0);
    const fromHistory = comp && m.ratio > 0;
    // Sem compactação o RMAN copia só os blocos usados; compactado, ~40% deles até haver histórico.
    const l0 = comp ? (fromHistory ? (m.dbMb || 0) * Math.min(m.ratio, 1) : usedDb * 0.4) : usedDb;
    let dbPart = l0;
    if (job === 'level1') dbPart = m.l1Mb > 0 ? Math.min(l0, Math.max(m.l1Mb * 1.5, l0 * 0.1)) : l0 * 0.25;
    const arcPart = (m.unbackedMb || 0) * (comp ? 0.6 : 1);
    const estMb = Math.ceil((dbPart + arcPart) * 1.2);
    const hours = (m.backupMin > 0 ? m.backupMin : 120) / 60 + 1;
    const headroomMb = Math.ceil(Math.max(1024, (m.peakHourMb || 0) * hours));
    return { estMb, headroomMb, basis: fromHistory ? 'history' : comp ? 'size-compressed' : 'size' };
}

const reserveOf = (d, g) => Math.max((d.totalMb * g.diskReservePct) / 100, 2048);

/**
 * @param m      medição (parse)
 * @param disks  { fra: {freeMb,totalMb}|null, dir: {freeMb,totalMb}|null }
 * @returns {{verdict:'ok'|'grow'|'noroom'|'skip', where, why, toMb, needMb, availMb, ...}}
 */
function decide(job, schedule, guard, m, disks = {}) {
    if (!DB_JOBS.includes(job)) return { verdict: 'skip' };
    const e = estimate(job, schedule, m);
    const toDir = schedule.destination === 'dir';
    const eff = Math.max(0, (m.usedMb || 0) - (m.reclaimMb || 0));
    const free = (m.limitMb || 0) - eff;
    const out = {
        ...e, toDir, verdict: '', where: '-', why: '-', toMb: 0, availMb: 0,
        needMb: toDir ? e.headroomMb : e.estMb + e.headroomMb,
        scope: m.spfile ? 'BOTH' : 'MEMORY', limitMb: m.limitMb || 0, effMb: eff, freeMb: free,
    };
    if (toDir && disks.dir) {
        const avail = Math.floor(disks.dir.freeMb - reserveOf(disks.dir, guard));
        if (avail < e.estMb) return { ...out, verdict: 'noroom', where: 'dir', needMb: e.estMb, availMb: Math.max(0, avail) };
    }
    if (!m.dest || !(m.limitMb > 0)) return { ...out, verdict: 'ok', where: 'nofra' };
    if (free >= out.needMb) return { ...out, verdict: 'ok', where: 'fra' };
    out.where = 'fra';
    const asm = String(m.dest).startsWith('+');
    const disk = asm ? (m.asmTotalMb > 0 ? { freeMb: Math.max(0, m.asmFreeMb || 0), totalMb: m.asmTotalMb } : null) : (disks.fra || null);
    // Destino diretório: falta só folga na FRA para os archives — isso não impede o backup.
    if (!disk) return toDir ? { ...out, verdict: 'ok', why: 'disk-unknown' } : { ...out, verdict: 'noroom', why: 'disk-unknown', availMb: Math.max(0, free) };
    const minLimit = eff + out.needMb;
    const byDisk = m.usedMb + disk.freeMb - reserveOf(disk, guard);
    let top = byDisk;
    if (guard.maxSizeGb > 0) top = Math.min(top, guard.maxSizeGb * 1024);
    top = Math.floor(top);
    if (top < minLimit) {
        const why = guard.maxSizeGb > 0 && guard.maxSizeGb * 1024 < byDisk ? 'cap' : 'disk';
        return toDir ? { ...out, verdict: 'ok', why } : { ...out, verdict: 'noroom', why, availMb: Math.max(0, free, top - eff) };
    }
    // Depois do backup a FRA ainda fica abaixo do limite de "aumentar" do guardião.
    let to = Math.min(Math.ceil(minLimit / (guard.growPct / 100)), top);
    const whole = Math.ceil(to / 1024) * 1024;
    if (whole <= top) to = whole;
    return { ...out, verdict: 'grow', toMb: to, fromMb: m.limitMb };
}

/**
 * Quanto os backups do agendamento ocupam na FRA quando o destino é a própria FRA
 * (sugestão de tamanho). Conta o pico: a cópia nova convive com as antigas até o
 * DELETE OBSOLETE do fim da tarefa.
 * @param retention { type: 'recovery-window', days } | { type: 'redundancy', redundancy } | { type: 'other' }
 */
function fraBackupsAllowance(schedule, retention, dbSizeGb, redoPerDayGb) {
    if (schedule.destination !== 'fra') return { gb: 0, text: null };
    const comp = schedule.compress !== false;
    const fullGb = (Number(dbSizeGb) || 0) * (comp ? 0.6 : 1);
    const days = retention && retention.type === 'recovery-window' ? retention.days : null;
    const copies = retention && retention.type === 'redundancy' ? retention.redundancy : 1;
    const r1 = (n) => Math.round(n * 10) / 10;
    if (schedule.strategy === 'archivelog') {
        const keep = Number(schedule.archKeepDays) || 7;
        return { gb: (Number(redoPerDayGb) || 0) * keep * (comp ? 0.6 : 1), text: `backups de archivelog guardados por ${keep} dias` };
    }
    if (schedule.strategy === 'incremental') {
        const l0 = days != null ? Math.ceil(days / 7) + 1 : copies + 1;
        const l1 = days != null ? days + 7 : 7;
        return { gb: l0 * fullGb + l1 * fullGb * 0.15, text: `${l0} backups nível 0 de ~${r1(fullGb)} GB + ${l1} de nível 1 (~15% cada)` };
    }
    const n = days != null ? days + 2 : copies + 1;
    return { gb: n * fullGb, text: `${n} backups completos de ~${r1(fullGb)} GB` };
}

// ==========================================================================
// Texto do log (Windows; o awk escreve o equivalente sem acentos)
// ==========================================================================

function gb(mb) {
    return `${(Number(mb || 0) / 1024).toFixed(1).replace('.', ',')} GB`;
}

const BASIS_TEXT = {
    history: 'pelo histórico do RMAN',
    'size-compressed': 'pelo tamanho usado do banco, compactado (ainda sem histórico)',
    size: 'pelo tamanho usado do banco',
};

function describe(d, m, disks, schedule, guard) {
    const out = [`  backup estimado: ${gb(d.estMb)} (${BASIS_TEXT[d.basis]}) + folga para os archives gerados durante o backup: ${gb(d.headroomMb)}`];
    if (d.limitMb > 0) out.push(`  FRA (${m.dest}): limite ${gb(d.limitMb)}, em uso ${gb(d.effMb)} (descontado o reciclável), livre ${gb(d.freeMb)}`);
    if (disks.fra) out.push(`  disco da FRA: ${gb(disks.fra.freeMb)} livres de ${gb(disks.fra.totalMb)}`);
    if (d.toDir) out.push(`  destino dos backups (${schedule.directory}): ${disks.dir ? `${gb(disks.dir.freeMb)} livres de ${gb(disks.dir.totalMb)}` : 'espaço livre desconhecido'}`);
    if (d.verdict === 'ok' && d.why === '-') out.push('  → espaço suficiente: o backup começa agora.');
    if (d.verdict === 'ok' && d.why !== '-') out.push('  → pouca folga na FRA para os archives durante o backup e não foi possível aumentá-la; o guardião acompanha.');
    if (d.verdict === 'grow') out.push(`  → aumentando o limite da FRA de ${gb(d.limitMb)} para ${gb(d.toMb)} antes do backup...`);
    if (d.verdict === 'noroom') {
        if (d.where === 'dir') out.push(`  → SEM ESPAÇO no destino dos backups: precisa de ~${gb(d.needMb)}, há ${gb(d.availMb)} (descontada a reserva do disco).`);
        else if (d.why === 'cap') out.push(`  → SEM ESPAÇO: a FRA precisaria de ~${gb(d.needMb)} livres e o teto configurado (${guard.maxSizeGb} GB) não permite.`);
        else if (d.why === 'disk-unknown') out.push(`  → SEM ESPAÇO: a FRA precisaria de ~${gb(d.needMb)} livres e não foi possível medir o disco para aumentar o limite com segurança.`);
        else out.push(`  → SEM ESPAÇO: a FRA precisaria de ~${gb(d.needMb)} livres e o disco só comporta ${gb(d.availMb)} (mantendo a reserva de ${guard.diskReservePct}%).`);
    }
    return out;
}

const NOROOM_TEXT = [
    '     O backup do banco NÃO foi iniciado (lotaria a FRA e poderia parar o banco): só os archivelogs serão copiados.',
    '     Solução: aponte os backups para um diretório em outro disco (tela Backup → Proteção automática da FRA) ou libere espaço.',
];

// ==========================================================================
// Execução no Windows (bin/scheduled-job.js)
// ==========================================================================

function realDeps(serverOs) {
    const collect = require('./recovery/collect');
    const storage = require('./storage');
    return {
        async measure() {
            const r = await collect.runSysdba([...SQLPLUS_SET, `${PF_SQL};`, `${PU_SQL};`], { serverOs, timeoutMs: 180000 });
            const m = parse(r.output);
            if (!m) {
                const err = (r.output.match(/\b(?:ORA|SP2)-\d{4,5}[^\n]*/) || [])[0];
                throw new Error(err || 'sem resposta do sqlplus');
            }
            return m;
        },
        async disk(dir) {
            const d = await storage.getDiskForPath(dir).catch(() => null);
            if (!d || d.error || !Number.isFinite(Number(d.freeGB)) || !Number.isFinite(Number(d.totalGB))) return null;
            return { freeMb: Number(d.freeGB) * 1024, totalMb: Number(d.totalGB) * 1024 };
        },
        async grow(toMb, scope) {
            const r = await collect.runSysdba(['WHENEVER SQLERROR EXIT FAILURE', `ALTER SYSTEM SET db_recovery_file_dest_size = ${toMb}M SCOPE=${scope};`], { serverOs, timeoutMs: 120000 });
            const err = (r.output.match(/\b(?:ORA|SP2)-\d{4,5}[^\n]*/) || [])[0];
            return { ok: r.code === 0 && !err, error: err || (r.code !== 0 ? `sqlplus saiu com código ${r.code}` : null) };
        },
    };
}

/**
 * Verifica (e prepara) o espaço para a tarefa.
 * @returns {Promise<{verdict:string, decision?:object, text:string}>}
 *   verdict 'noroom' → rode só os archivelogs e termine com NOROOM_RC.
 */
async function run(job, settings, deps = realDeps('windows')) {
    if (!DB_JOBS.includes(job)) return { verdict: 'skip', text: '' };
    const head = 'Verificação de espaço antes do backup (Oracle Pulse):';
    let m;
    try {
        m = await deps.measure();
    } catch (err) {
        return { verdict: 'unknown', text: `${head}\n  não foi possível medir a FRA (${String(err.message || err).split('\n')[0]}); o backup segue sem a verificação.` };
    }
    const s = settings.schedule;
    const disks = {
        fra: m.dest && !String(m.dest).startsWith('+') ? await deps.disk(m.dest) : null,
        dir: s.destination === 'dir' && s.directory ? await deps.disk(s.directory) : null,
    };
    const d = decide(job, s, settings.guard, m, disks);
    const lines = [head, ...describe(d, m, disks, s, settings.guard)];
    if (d.verdict === 'grow') {
        const r = await deps.grow(d.toMb, d.scope);
        if (r.ok) {
            d.grown = true;
            lines.push(`     limite da FRA aumentado para ${gb(d.toMb)} (SCOPE=${d.scope}).`);
        } else {
            lines.push(`     FALHA ao aumentar o limite da FRA: ${r.error}`);
            if (!d.toDir) { d.verdict = 'noroom'; d.why = 'grow-failed'; }
        }
    }
    if (d.verdict === 'noroom') lines.push(...NOROOM_TEXT);
    return { verdict: d.verdict, decision: d, text: lines.join('\n') };
}

// ==========================================================================
// Linux (run-job.sh): arquivos instalados no servidor
// ==========================================================================

/** Parâmetros gravados no run-job.sh (o servidor não lê as configurações do painel). */
function params(schedule, guard) {
    const dir = schedule.destination === 'dir' ? String(schedule.directory || '') : '';
    if (/['\n]/.test(dir)) throw new Error('Diretório dos backups inválido para o script.');
    const int = (v) => Math.max(0, Math.round(Number(v) || 0));
    return {
        comp: schedule.compress ? 1 : 0,
        todir: schedule.destination === 'dir' ? 1 : 0,
        dir,
        growPct: int(guard.growPct) || 85,
        reservePct: int(guard.diskReservePct),
        maxGb: int(guard.maxSizeGb),
    };
}

function linuxSqlFile() {
    return [...SQLPLUS_SET, 'WHENEVER SQLERROR CONTINUE', `${PF_SQL};`, `${PU_SQL};`, 'EXIT'].join('\n') + '\n';
}

/**
 * Programa awk: lê a saída do preflight.sql e imprime a linha de máquina
 *   @@PF verdict where why toMb needMb availMb scope estMb headMb limitMb effMb freeMb
 * e o texto para o log. Mesmas contas de estimate()/decide().
 */
function linuxAwk() {
    return [
        '# Oracle Pulse - verificacao de espaco antes do backup. Gerado pelo painel: nao edite a mao.',
        'function ceil(x) { return (x == int(x)) ? x : (x > 0 ? int(x) + 1 : int(x)) }',
        'function floor(x) { return (x == int(x) || x > 0) ? int(x) : int(x) - 1 }',
        'function mx(a, b) { return a > b ? a : b }',
        'function mn(a, b) { return a < b ? a : b }',
        'function gb(v) { return sprintf("%.1f GB", v / 1024) }',
        '/^PF~/ && !have { sub(/^PF~/, ""); split($0, f, "[|]~[|]"); have = 1 }',
        '/^PU~/ && !hpu { sub(/^PU~/, ""); pu = $0; hpu = 1 }',
        'END {',
        '  if (!have) {',
        '    print "@@PF unknown - - 0 0 0 MEMORY 0 0 0 0 0"',
        '    print "Verificacao de espaco antes do backup (Oracle Pulse):"',
        '    print "  nao foi possivel medir a FRA (sqlplus); o backup segue sem a verificacao."',
        '    exit',
        '  }',
        '  dest = f[1]; limit = f[2] + 0; used = f[3] + 0; reclaim = f[4] + 0; spfile = f[5]',
        '  db = f[6] + 0; ratio = f[7] / 10000; l1 = f[8] + 0; unb = f[9] + 0; peak = f[10] + 0; bmin = f[11] + 0',
        '  asmfree = f[12] + 0; asmtotal = f[13] + 0',
        '  useddb = (hpu && pu + 0 > 0) ? pu + 0 : db',
        '  hist = 0',
        '  if (comp == 1) { hist = (ratio > 0); l0 = hist ? db * mn(ratio, 1) : useddb * 0.4 } else { l0 = useddb }',
        '  dbpart = l0',
        '  if (job == "level1") dbpart = (l1 > 0) ? mn(l0, mx(l1 * 1.5, l0 * 0.1)) : l0 * 0.25',
        '  arcpart = unb * (comp == 1 ? 0.6 : 1)',
        '  est = ceil((dbpart + arcpart) * 1.2)',
        '  hours = (bmin > 0 ? bmin : 120) / 60 + 1',
        '  head = ceil(mx(1024, peak * hours))',
        '  todirb = (todir == 1)',
        '  hasfra = (fradisk != ""); hasdir = (dirdisk != "")',
        '  split(fradisk, fd, " "); split(dirdisk, dd, " ")',
        '  verdict = ""; where = "-"; why = "-"; to = 0; avail = 0',
        '  scope = (spfile != "") ? "BOTH" : "MEMORY"',
        '  need = todirb ? head : est + head',
        '  eff = mx(0, used - reclaim); free = limit - eff',
        '  if (todirb && hasdir) {',
        '    adir = floor(dd[2] - mx(dd[1] * reservepct / 100, 2048))',
        '    if (adir < est) { verdict = "noroom"; where = "dir"; need = est; avail = mx(0, adir) }',
        '  }',
        '  if (verdict == "") {',
        '    if (dest == "" || !(limit > 0)) { verdict = "ok"; where = "nofra" }',
        '    else if (free >= need) { verdict = "ok"; where = "fra" }',
        '    else {',
        '      where = "fra"',
        '      if (substr(dest, 1, 1) == "+") { hasd = (asmtotal > 0); dfree = mx(0, asmfree); dtot = asmtotal }',
        '      else { hasd = hasfra; dfree = fd[2] + 0; dtot = fd[1] + 0 }',
        '      if (!hasd) {',
        '        why = "disk-unknown"',
        '        if (todirb) verdict = "ok"; else { verdict = "noroom"; avail = mx(0, free) }',
        '      } else {',
        '        minl = eff + need',
        '        bydisk = used + dfree - mx(dtot * reservepct / 100, 2048)',
        '        top = bydisk',
        '        if (maxgb > 0) top = mn(top, maxgb * 1024)',
        '        top = floor(top)',
        '        if (top < minl) {',
        '          why = (maxgb > 0 && maxgb * 1024 < bydisk) ? "cap" : "disk"',
        '          if (todirb) verdict = "ok"; else { verdict = "noroom"; avail = mx(0, mx(free, top - eff)) }',
        '        } else {',
        '          to = mn(ceil(minl / (growpct / 100)), top)',
        '          w = ceil(to / 1024) * 1024',
        '          if (w <= top) to = w',
        '          verdict = "grow"',
        '        }',
        '      }',
        '    }',
        '  }',
        '  print "@@PF", verdict, where, why, to, need, avail, scope, est, head, limit, eff, free',
        '  print "Verificacao de espaco antes do backup (Oracle Pulse):"',
        '  basis = hist ? "pelo historico do RMAN" : (comp == 1 ? "pelo tamanho usado do banco, compactado (ainda sem historico)" : "pelo tamanho usado do banco")',
        '  print "  backup estimado: " gb(est) " (" basis ") + folga para os archives gerados durante o backup: " gb(head)',
        '  if (limit > 0) print "  FRA (" dest "): limite " gb(limit) ", em uso " gb(eff) " (descontado o reciclavel), livre " gb(free)',
        '  if (hasfra) print "  disco da FRA: " gb(fd[2]) " livres de " gb(fd[1])',
        '  if (todirb) print "  destino dos backups: " (hasdir ? gb(dd[2]) " livres de " gb(dd[1]) : "espaco livre desconhecido")',
        '  if (verdict == "ok" && why == "-") print "  -> espaco suficiente: o backup comeca agora."',
        '  if (verdict == "ok" && why != "-") print "  -> pouca folga na FRA para os archives durante o backup e nao foi possivel aumenta-la; o guardiao acompanha."',
        '  if (verdict == "grow") print "  -> aumentando o limite da FRA de " gb(limit) " para " gb(to) " antes do backup..."',
        '  if (verdict == "noroom") {',
        '    if (where == "dir") print "  -> SEM ESPACO no destino dos backups: precisa de ~" gb(need) ", ha " gb(avail) " (descontada a reserva do disco)."',
        '    else if (why == "cap") print "  -> SEM ESPACO: a FRA precisaria de ~" gb(need) " livres e o teto configurado (" maxgb " GB) nao permite."',
        '    else if (why == "disk-unknown") print "  -> SEM ESPACO: a FRA precisaria de ~" gb(need) " livres e nao foi possivel medir o disco para aumentar o limite com seguranca."',
        '    else print "  -> SEM ESPACO: a FRA precisaria de ~" gb(need) " livres e o disco so comporta " gb(avail) " (mantendo a reserva de " reservepct "%)."',
        '  }',
        '}',
    ].join('\n') + '\n';
}

/** Trecho do run-job.sh (sh POSIX) que roda a verificação e, se preciso, troca o .rcv. */
function linuxShell() {
    return [
        'case "$JOB" in full|level0|level1)',
        '  if [ -f "$BASE/rman/preflight.sql" ] && [ -f "$BASE/bin/preflight.awk" ]; then',
        '    PFTMP="$BASE/status/$JOB.preflight"',
        '    "$ORACLE_HOME/bin/sqlplus" -s -L "/ as sysdba" @"$BASE/rman/preflight.sql" > "$PFTMP" 2>&1',
        '    DEST=$(awk -F\'[|]~[|]\' \'/^PF~/ { sub(/^PF~/, "", $1); print $1; exit }\' "$PFTMP")',
        '    FRADISK=""',
        '    case "$DEST" in /*) FRADISK=$(df -Pk "$DEST" 2>/dev/null | awk \'NR == 2 { print int($2 / 1024), int($4 / 1024) }\');; esac',
        '    DIRDISK=""',
        '    if [ "$PF_TODIR" = 1 ]; then DIRDISK=$(df -Pk "$PF_DIR" 2>/dev/null | awk \'NR == 2 { print int($2 / 1024), int($4 / 1024) }\'); fi',
        '    awk -v job="$JOB" -v comp="$PF_COMP" -v todir="$PF_TODIR" -v growpct="$PF_GROW" -v reservepct="$PF_RESERVE" -v maxgb="$PF_MAXGB" \\',
        '        -v fradisk="$FRADISK" -v dirdisk="$DIRDISK" -f "$BASE/bin/preflight.awk" "$PFTMP" > "$PFTMP.dec"',
        '    grep -v \'^@@PF\' "$PFTMP.dec" >> "$LOG"',
        '    set -- $(grep \'^@@PF\' "$PFTMP.dec")',
        '    V="$2"',
        '    if [ "$V" = unknown ]; then grep -E \'ORA-|SP2-\' "$PFTMP" | head -n 3 >> "$LOG"; fi',
        '    if [ "$V" = grow ]; then',
        '      GOUT=$({ echo "WHENEVER SQLERROR EXIT FAILURE"; echo "ALTER SYSTEM SET db_recovery_file_dest_size = ${5}M SCOPE=${8};"; echo "EXIT"; } | "$ORACLE_HOME/bin/sqlplus" -s -L "/ as sysdba" 2>&1)',
        '      GRC=$?',
        '      if [ "$GRC" -eq 0 ] && ! echo "$GOUT" | grep -q \'ORA-\'; then',
        '        echo "     limite da FRA aumentado para ${5} MB (SCOPE=${8})." >> "$LOG"',
        '      else',
        '        echo "     FALHA ao aumentar o limite da FRA:" >> "$LOG"',
        '        echo "$GOUT" | grep -E \'ORA-|SP2-\' | head -n 3 >> "$LOG"',
        '        if [ "$PF_TODIR" != 1 ]; then V=noroom; fi',
        '      fi',
        '    fi',
        '    if [ "$V" = noroom ]; then',
        '      echo "     O backup do banco NAO foi iniciado (lotaria a FRA e poderia parar o banco): so os archivelogs serao copiados." >> "$LOG"',
        '      echo "     Solucao: aponte os backups para um diretorio em outro disco (tela Backup > Protecao automatica da FRA) ou libere espaco." >> "$LOG"',
        '      RCV="$BASE/rman/fallback.rcv"',
        `      PFRC=${NOROOM_RC}`,
        '    fi',
        '    rm -f "$PFTMP" "$PFTMP.dec"',
        '    echo "" >> "$LOG"',
        '  fi',
        '  ;;',
        'esac',
    ];
}

module.exports = {
    DB_JOBS, NOROOM_RC, PF_SQL, PU_SQL,
    parse, estimate, decide, describe, run, params, linuxSqlFile, linuxAwk, linuxShell, fraBackupsAllowance,
};

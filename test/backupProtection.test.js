'use strict';
// Backups agendados (cron / Agendador de Tarefas) e guardião da FRA.
process.env.DEMO_MODE = 'false';
process.env.DB_ORACLE_HOME = '/u01/app/oracle/product/19.0.0/dbhome_1';
process.env.DB_ORACLE_SID = 'orcl';
process.env.DB_OS_USER = 'oracle';
process.env.SSH_HOST = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const bs = require('../src/backupSchedule');
const guard = require('../src/fraGuard');
const alerts = require('../src/alerts');

const G = { ...bs.DEFAULT_GUARD, emergencyDir: '/u05/emerg/' };
const M = { limitMb: 50 * 1024, reclaimMb: 0, archiver: 'STARTED', unbackedMb: 8000, rateMbMin: null, disk: { freeGB: 200, totalGB: 500 }, emergencyDisk: { freeGB: 300 } };
const CTX = { now: Date.now(), last: {}, failed: {}, automation: true, backupDest: 'fra' };
const decide = (m, ctx = {}, g = {}) => guard.decide({ ...M, ...m }, { ...G, ...g }, { ...CTX, ...ctx });

// ------------------------------------------------------------------ validação
test('agendamento: validação de horário, intervalo e diretório por SO', () => {
    const s = bs.validateSchedule({}, 'linux');
    assert.deepEqual([s.strategy, s.time, s.archivelogHours, s.destination, s.compress], ['full', '01:00', 4, 'fra', true]);
    assert.throws(() => bs.validateSchedule({ time: '25:00' }, 'linux'), /Horário inválido/);
    assert.throws(() => bs.validateSchedule({ archivelogHours: 5 }, 'linux'), /Intervalo/);
    assert.equal(bs.validateSchedule({ destination: 'dir', directory: '/u04/backup' }, 'linux').directory, '/u04/backup/');
    assert.equal(bs.validateSchedule({ destination: 'dir', directory: 'E:\\Backup\\ORCL' }, 'windows').directory, 'E:\\Backup\\ORCL\\');
    assert.throws(() => bs.validateSchedule({ destination: 'dir', directory: 'E:\\Backup' }, 'linux'), /Linux/);
    assert.throws(() => bs.validateSchedule({ destination: 'dir', directory: '+FRA' }, 'linux'), /ASM/);
    assert.throws(() => bs.validateSchedule({ destination: 'dir', directory: "/u04/x'; rm -rf /" }, 'linux'), /não permitidos/);
    assert.throws(() => bs.validateSchedule({ destination: 'dir', directory: '/u04/$HOME' }, 'linux'), /\$/);
    assert.throws(() => bs.validateGuard({ targetPct: 90, growPct: 85, emergencyPct: 95 }, 'linux'), /precisam crescer/);
    assert.equal(bs.validateGuard({ emergencyDir: '/u05/emerg' }, 'linux').emergencyDir, '/u05/emerg/');
});

test('comandos RMAN: destino, compressão, incremental e lotes de archives', () => {
    const dir = bs.validateSchedule({ destination: 'dir', directory: '/u04/bk', strategy: 'incremental' }, 'linux');
    assert.equal(bs.rmanLines('level0', dir)[0], "BACKUP AS COMPRESSED BACKUPSET INCREMENTAL LEVEL 0 DATABASE FORMAT '/u04/bk/%d_L0_%T_%U' PLUS ARCHIVELOG FORMAT '/u04/bk/%d_ARC_%T_%U' DELETE INPUT;");
    assert.equal(bs.rmanLines('level1', dir)[0].includes('INCREMENTAL LEVEL 1'), true);
    assert.deepEqual(bs.rmanLines('archivelog', dir), [
        "BACKUP AS COMPRESSED BACKUPSET ARCHIVELOG ALL NOT BACKED UP 1 TIMES FILESPERSET 8 FORMAT '/u04/bk/%d_ARC_%T_%U' DELETE INPUT;",
        'DELETE NOPROMPT ARCHIVELOG ALL BACKED UP 1 TIMES TO DEVICE TYPE DISK;',
    ]);
    const fra = bs.validateSchedule({ compress: false }, 'linux');
    assert.deepEqual(bs.rmanLines('full', fra), ['BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;', 'DELETE NOPROMPT OBSOLETE;', 'CROSSCHECK ARCHIVELOG ALL;', 'DELETE NOPROMPT EXPIRED ARCHIVELOG ALL;']);
    assert.throws(() => bs.rmanLines('x', fra), /desconhecida/);
});

test('cron: horários, dias do incremental e archivelogs fora do horário do backup', () => {
    const full = bs.validateSchedule({ time: '01:15', archivelogHours: 6 }, 'linux');
    assert.deepEqual(bs.cronLines(full, '/opt/oraclepulse', 'oracle'), [
        '15 1 * * * oracle /opt/oraclepulse/bin/run-job.sh full',
        '45 */6 * * * oracle /opt/oraclepulse/bin/run-job.sh archivelog',
    ]);
    const inc = bs.validateSchedule({ strategy: 'incremental', level0Day: 6, time: '22:30', archivelogHours: 0 }, 'linux');
    assert.deepEqual(bs.cronLines(inc, '/home/oracle/oraclepulse', null), [
        '30 22 * * 6 /home/oracle/oraclepulse/bin/run-job.sh level0',
        '30 22 * * 0,1,2,3,4,5 /home/oracle/oraclepulse/bin/run-job.sh level1',
    ]);
    assert.equal(bs.describeJob('level1', inc), 'demais dias às 22:30');
    assert.equal(bs.describeJob('level0', inc), 'sábado às 22:30');
});

test('próxima execução e avaliação de falha/atraso', () => {
    const s = { ...bs.validateSchedule({ strategy: 'incremental', level0Day: 0, time: '01:00', archivelogHours: 4 }, 'linux') };
    const sat = new Date(2026, 9, 17, 12, 0, 0).getTime(); // sábado 12:00
    assert.equal(new Date(bs.nextRun('level0', s, sat)).getDay(), 0);
    assert.equal(new Date(bs.nextRun('level1', s, sat)).getDay(), 1);
    assert.equal(new Date(bs.nextRun('archivelog', s, sat)).getHours(), 12);
    assert.equal(new Date(bs.nextRun('archivelog', s, sat)).getMinutes(), 30);

    const now = Date.now();
    const installed = { ...s, installed: { at: new Date(now - 3 * 86400000).toISOString() } };
    let ev = bs.evaluateJobs(installed, {
        level0: { start: now - 30 * 3600000, rc: 0, end: now - 29 * 3600000 },
        level1: { start: now - 5 * 3600000, rc: 2, end: now - 4 * 3600000 },
        archivelog: { start: now - 3600000, rc: 0, end: now - 3500000 },
    }, now);
    assert.deepEqual(ev.jobs.map((j) => j.state), ['ok', 'failed', 'ok']);
    assert.deepEqual(ev.alerts.map((a) => a.id).sort(), ['backup-failed:level1', 'backup-late']);
    ev = bs.evaluateJobs({ ...s, installed: { at: new Date(now - 3600000).toISOString() } }, {}, now);
    assert.equal(ev.alerts.length, 0, 'recém-instalado ainda não está atrasado');
    ev = bs.evaluateJobs(installed, { level0: { start: now - 13 * 3600000, rc: 'running' } }, now);
    assert.equal(ev.jobs[0].state, 'stuck');
});

test('marcadores dos scripts: status do Linux e tarefas do Windows', () => {
    const p = bs.parseMarkers([
        '@@OP:CRON:/etc/cron.d/oraclepulse',
        '@@OP:STATUS:full|1791900000|0|/opt/oraclepulse/logs/full_20261013_010000.log|1791900600',
        '@@OP:STATUS:archivelog|1791920000|running|/opt/oraclepulse/logs/archivelog_x.log|',
        '@@OP:TASK:Backup completo|Ready|2026-10-13T01:00:00|2026-10-14T01:00:00|0',
        '@@OP:BASE:/opt/oraclepulse', '@@OP:OK',
    ].join('\r\n'));
    assert.equal(p.ok, true);
    assert.deepEqual(p.status.full, { start: 1791900000000, rc: 0, log: '/opt/oraclepulse/logs/full_20261013_010000.log', end: 1791900600000 });
    assert.equal(p.status.archivelog.rc, 'running');
    assert.deepEqual(p.tasks['Backup completo'], { state: 'Ready', last: '2026-10-13T01:00:00', next: '2026-10-14T01:00:00', result: 0 });
});

// ------------------------------------------------------------------ scripts reais
const SH = ['sh', 'C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe'].find((c) => {
    try { return spawnSync(c, ['-c', 'exit 0'], { windowsHide: true }).status === 0; } catch { return false; }
});

test('Linux: instala (modo usuário), roda a tarefa e lê o status num sh real', { skip: !SH && 'sh não encontrado' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-cron-'));
    try {
        const home = path.join(dir, 'home');
        const stubs = path.join(dir, 'stubs');
        fs.mkdirSync(home);
        fs.mkdirSync(stubs);
        const stub = (n, body) => fs.writeFileSync(path.join(stubs, n), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        stub('id', 'case "$1" in -u) echo 1000;; -un) echo oracle;; -gn) echo oinstall;; *) echo "uid=1000(oracle)";; esac');
        stub('chown', 'exit 0');
        stub('crontab', `if [ "$1" = "-l" ]; then cat "${home.replace(/\\/g, '/')}/crontab.txt" 2>/dev/null; else cp "$1" "${home.replace(/\\/g, '/')}/crontab.txt"; fi`);
        // rman falso: grava o log pedido e sai com o código de RMAN_RC
        stub('rman', 'for a in "$@"; do case "$a" in log=*) L="${a#log=}";; cmdfile=*) C="${a#cmdfile=}";; esac; done; { echo "Recovery Manager"; cat "$C"; } > "$L"; exit "${RMAN_RC:-0}"');
        const home2 = path.join(dir, 'oh');
        fs.mkdirSync(path.join(home2, 'bin'), { recursive: true });
        fs.copyFileSync(path.join(stubs, 'rman'), path.join(home2, 'bin', 'rman'));

        const s = bs.validateSchedule({ strategy: 'full', time: '01:00', archivelogHours: 4, destination: 'dir', directory: '/u04/bk' }, 'linux');
        const posix = (p) => p.replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
        const ctx = { home: posix(home2), sid: 'orcl', runAs: 'oracle' };
        const shDir = path.isAbsolute(SH) ? path.dirname(SH) : null;
        const env = { ...process.env, HOME: posix(home), PATH: [stubs, shDir, process.env.PATH].filter(Boolean).join(path.delimiter) };
        const run = (script, extra = {}) => spawnSync(SH, ['-s'], { input: script, encoding: 'utf8', windowsHide: true, env: { ...env, ...extra } });

        const inst = run(bs.buildLinuxInstallScript(s, ctx));
        const p = bs.parseMarkers(inst.stdout);
        assert.equal(p.ok, true, inst.stdout + inst.stderr);
        assert.equal(p.mode, 'user');
        const base = path.join(home, 'oraclepulse');
        const cron = fs.readFileSync(path.join(home, 'crontab.txt'), 'utf8');
        assert.match(cron, /^0 1 \* \* \* .*\/oraclepulse\/bin\/run-job\.sh full # oraclepulse$/m);
        assert.match(cron, /^30 \*\/4 \* \* \* .*run-job\.sh archivelog # oraclepulse$/m);
        assert.doesNotMatch(cron, /@@BASE@@/);
        assert.equal(fs.readFileSync(path.join(base, 'rman', 'full.rcv'), 'utf8'), bs.rmanLines('full', s).join('\n') + '\n');
        const runJob = fs.readFileSync(path.join(base, 'bin', 'run-job.sh'), 'utf8');
        assert.doesNotMatch(runJob, /@@BASE@@/);

        // Executa a tarefa como o cron faria (sucesso e falha)
        const job = (name, rc) => spawnSync(SH, [path.join(base, 'bin', 'run-job.sh'), name], { encoding: 'utf8', windowsHide: true, env: { ...env, RMAN_RC: String(rc) } });
        assert.equal(job('full', 0).status, 0);
        assert.equal(job('archivelog', 3).status, 3);
        assert.equal(job('../../etc', 0).status, 2, 'tarefa desconhecida é recusada');

        const st = bs.parseMarkers(run(bs.buildLinuxStatusScript()).stdout);
        assert.equal(st.status.full.rc, 0);
        assert.equal(st.status.archivelog.rc, 3);
        assert.ok(st.status.full.end >= st.status.full.start);
        assert.match(fs.readFileSync(path.join(home, st.status.full.log.split('/home/')[1] || ''), 'utf8'), /BACKUP AS COMPRESSED BACKUPSET DATABASE/);
        const ev = bs.evaluateJobs({ ...s, installed: { at: new Date(Date.now() - 60000).toISOString() } }, st.status);
        assert.deepEqual(ev.jobs.map((j) => j.state), ['ok', 'failed']);

        const rm = run(bs.buildLinuxRemoveScript());
        assert.equal(bs.parseMarkers(rm.stdout).ok, true);
        assert.doesNotMatch(fs.readFileSync(path.join(home, 'crontab.txt'), 'utf8'), /oraclepulse/);
        assert.ok(!fs.existsSync(path.join(base, 'bin')));
        assert.ok(fs.existsSync(path.join(base, 'logs')), 'os logs ficam');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Windows: script do Agendador em ASCII, curto e sem erro de sintaxe', () => {
    const s = bs.validateSchedule({ strategy: 'incremental', level0Day: 0, time: '23:45', archivelogHours: 6, destination: 'dir', directory: 'E:\\Backup\\ORCL' }, 'windows');
    const script = bs.buildWindowsInstallScript(s, { node: 'C:\\Program Files\\OraclePulse\\runtime\\node.exe', script: "C:\\Program Files\\OraclePulse\\bin\\scheduled-job.js", workDir: 'C:\\Program Files\\OraclePulse' });
    assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(script));
    assert.ok(require('../src/osDisk').psEncoded(script).length < 8000, 'cabe no limite do cmd.exe');
    assert.match(script, /-Weekly -DaysOfWeek Sunday -At '23:45'/);
    assert.match(script, /-DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday,Saturday/);
    assert.match(script, /New-ScheduledTaskTrigger -Daily -At '00:15'/);
    assert.match(script, /-RepetitionInterval \(New-TimeSpan -Hours 6\)/);
    assert.match(script, /-UserId 'SYSTEM'/);
    if (process.platform === 'win32') {
        for (const src of [script, bs.buildWindowsStatusScript(), bs.buildWindowsRemoveScript()]) {
            const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
                '$e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); $e.Count'],
            { input: src, encoding: 'utf8', windowsHide: true });
            assert.equal(r.stdout.trim(), '0', r.stdout + r.stderr);
        }
    }
});

// ------------------------------------------------------------------ guardião
test('guardião: nível e ação conforme uso, ritmo e disco', () => {
    assert.equal(decide({ usedMb: 25 * 1024 }).level, 'ok');
    let d = decide({ usedMb: 36 * 1024 });
    assert.deepEqual([d.level, d.action.kind], ['act', 'backup-archivelog']);
    d = decide({ usedMb: 30 * 1024, rateMbMin: 700 });
    assert.equal(d.level, 'grow', 'enche em < 30 min: age antes do limite');
    d = decide({ usedMb: 44 * 1024 });
    assert.deepEqual([d.level, d.action.kind, d.action.newGb], ['grow', 'grow', 62]);
    d = decide({ usedMb: 44 * 1024, disk: { freeGB: 52, totalGB: 500 } });
    assert.equal(d.action.kind, 'dump', 'sem folga no disco e backup na FRA: despeja no outro disco');
    d = decide({ usedMb: 44 * 1024, disk: { freeGB: 52, totalGB: 500 } }, { backupDest: 'dir' });
    assert.equal(d.action.kind, 'backup-archivelog', 'backup em diretório próprio libera a FRA');
    d = decide({ usedMb: 40 * 1024, archiver: 'FAILED' });
    assert.deepEqual([d.level, d.action.kind], ['emergency', 'grow']);
    d = decide({ usedMb: 48.5 * 1024, disk: { freeGB: 10, totalGB: 500 } }, {}, { emergencyDir: '' });
    assert.deepEqual([d.action.kind, d.action.keepMinutes], ['force-delete', 60]);
    d = decide({ usedMb: 48.5 * 1024, disk: { freeGB: 10, totalGB: 500 } }, { last: { 'force-delete': Date.now() - 20 * 60000 } }, { emergencyDir: '' });
    assert.equal(d.action.keepMinutes, 15, 'segunda vez em 1 h: mantém só 15 min de archives');
    d = decide({ usedMb: 48.5 * 1024, disk: { freeGB: 10, totalGB: 500 } }, { last: { cleanup: Date.now() } }, { emergencyDir: '', lastResort: false });
    assert.equal(d.action, null, 'sem nenhuma saída: nenhuma ação (e o painel alerta)');
    assert.ok(d.skipped.some((s) => s.why === 'último recurso desligado'));
    d = decide({ usedMb: 44 * 1024 }, { last: { grow: Date.now() - 60000 } });
    assert.equal(d.action.kind, 'dump', 'aumento em espera: passa para a próxima medida');
    d = decide({ usedMb: 36 * 1024 }, { automation: false });
    assert.equal(d.action, null);
    assert.match(d.skipped[0].why, /RMAN não configurado/);
});

test('guardião: aumento respeita reserva do disco e teto', () => {
    const base = { limitMb: 50 * 1024, usedMb: 44 * 1024, reclaimMb: 0, disk: { freeGB: 200, totalGB: 500 } };
    assert.deepEqual(guard.growAmount(base, G), { addGb: 12, newGb: 62 });
    assert.equal(guard.growAmount({ ...base, disk: { freeGB: 20, totalGB: 100 } }, G).newGb, 54, 'não ultrapassa usado + livre − reserva: 44 + 20 − 10');
    assert.match(guard.growAmount({ ...base, disk: { freeGB: 5, totalGB: 500 } }, G).reason, /sem espaço no disco/);
    assert.equal(guard.growAmount(base, { ...G, maxSizeGb: 55 }).newGb, 55);
    assert.match(guard.growAmount({ ...base, limitMb: 55 * 1024 }, { ...G, maxSizeGb: 55 }).reason, /teto de 55 GB/);
    assert.match(guard.growAmount({ ...base, disk: null }, G).reason, /desconhecido/);
    assert.equal(guard.growthRate([{ t: 0, effMb: 1000 }, { t: 2 * 60000, effMb: 1100 }, { t: 5 * 60000, effMb: 1300 }]), 60);
    assert.equal(guard.growthRate([{ t: 0, effMb: 5000 }, { t: 60000, effMb: 1000 }, { t: 120000, effMb: 1010 }]), null, 'queda recente: ainda medindo');
    assert.deepEqual(guard.parseMeasure('R~/u01/fra|~|51200|~|46080|~|1024|~|STARTED|~|ARCHIVELOG|~|8000|~|/u01/spfile.ora|~|0'),
        { dest: '/u01/fra', limitMb: 51200, usedMb: 46080, reclaimMb: 1024, archiver: 'STARTED', logMode: 'ARCHIVELOG', unbackedMb: 8000, spfile: '/u01/spfile.ora', rmanBusy: false });
    assert.equal(guard.parseMeasure('R~/u01/fra|~|1|~|1|~|0|~|STARTED|~|ARCHIVELOG|~|0|~||~|2').rmanBusy, true, 'backup RMAN em andamento');
    // Durante um backup o ritmo vale com 1 min de amostras (15 s entre medições)
    const fast = [{ t: 0, effMb: 1000 }, { t: 30000, effMb: 1300 }, { t: 60000, effMb: 1600 }];
    assert.equal(guard.growthRate(fast), null);
    assert.equal(guard.growthRate(fast, 1), 600);
    const act = guard.actionRman({ kind: 'force-delete', keepMinutes: 15 }, { guard: G, schedule: bs.DEFAULT_SCHEDULE });
    assert.equal(act[1], "DELETE NOPROMPT FORCE ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE-15/1440';");
    assert.match(guard.actionRman({ kind: 'dump' }, { guard: G, schedule: bs.DEFAULT_SCHEDULE })[0], /FILESPERSET 8 FORMAT '\/u05\/emerg\/%d_EMERG_%T_%U' DELETE INPUT;/);
    assert.ok(guard.actionRman({ kind: 'cleanup' }, { guard: G, schedule: bs.DEFAULT_SCHEDULE }).includes('DELETE NOPROMPT OBSOLETE;'));
});

// ------------------------------------------------------------------ somente archivelogs
test('estratégia "somente archivelogs": só a tarefa de archives, retenção por dias e sem cobrança de backup do banco', () => {
    assert.throws(() => bs.validateSchedule({ strategy: 'archivelog', archivelogHours: 0 }, 'linux'), /somente archivelogs/);
    assert.throws(() => bs.validateSchedule({ strategy: 'archivelog', archKeepDays: 0 }, 'linux'), /dias/);
    const s = bs.validateSchedule({ strategy: 'archivelog', time: '01:10', archivelogHours: 2, archKeepDays: 10 }, 'linux');
    assert.deepEqual(bs.activeJobs(s), ['archivelog']);
    assert.deepEqual(bs.cronLines(s, '/opt/oraclepulse', 'oracle'), ['40 */2 * * * oracle /opt/oraclepulse/bin/run-job.sh archivelog']);
    assert.deepEqual(bs.rmanLines('archivelog', s), [
        'BACKUP AS COMPRESSED BACKUPSET ARCHIVELOG ALL NOT BACKED UP 1 TIMES FILESPERSET 8 DELETE INPUT;',
        'DELETE NOPROMPT ARCHIVELOG ALL BACKED UP 1 TIMES TO DEVICE TYPE DISK;',
        "DELETE NOPROMPT BACKUP OF ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE-10';",
    ]);
    // Nas outras estratégias a retenção continua com o DELETE OBSOLETE do RMAN
    assert.equal(bs.rmanLines('archivelog', bs.validateSchedule({}, 'linux')).length, 2);
    // Guardião: sem DELETE OBSOLETE (não há backup do banco no RMAN como referência)
    const settings = { guard: G, schedule: s };
    for (const kind of ['backup-archivelog', 'cleanup']) {
        const lines = guard.actionRman({ kind }, settings);
        assert.ok(!lines.includes('DELETE NOPROMPT OBSOLETE;'), kind);
        assert.ok(lines.includes("DELETE NOPROMPT BACKUP OF ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE-10';"), kind);
    }
    // Windows: só a tarefa de archivelogs
    const win = bs.buildWindowsInstallScript(bs.validateSchedule({ strategy: 'archivelog', archivelogHours: 4 }, 'windows'), { node: 'C:\\n\\node.exe', script: 'C:\\n\\job.js', workDir: 'C:\\n' });
    assert.deepEqual((win.match(/Add-Job '[^']+' '(\w+)'/g) || []).map((x) => x.split(' ').pop()), ["'archivelog'"]);
    // Sem "nenhum backup do banco em 26 h"; o atraso dos archives continua valendo
    const installed = { at: new Date(Date.now() - 3 * 86400000).toISOString() };
    const ev = bs.evaluateJobs({ ...s, installed }, {});
    assert.deepEqual(ev.alerts.map((a) => a.id), ['backup-arch-late']);
});

test('alertas externos: publicar, expirar e sincronizar', async () => {
    alerts.setExternal('fraguard-x', { severity: 'warning', message: 'teste' }, 50);
    assert.ok(alerts.getActive().some((a) => a.id === 'fraguard-x'));
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(!alerts.getActive().some((a) => a.id === 'fraguard-x'), 'expira sozinho');
    alerts.syncExternal('backup-', [{ id: 'backup-late', severity: 'critical', message: 'atrasado' }]);
    assert.ok(alerts.getActive().some((a) => a.id === 'backup-late'));
    alerts.evaluate({ tablespaces: [], disks: [] });
    assert.ok(alerts.getActive().some((a) => a.id === 'backup-late'), 'avaliação de métricas não apaga alertas externos');
    alerts.syncExternal('backup-', []);
    assert.ok(!alerts.getActive().some((a) => a.id === 'backup-late'));
});

'use strict';
// Verificação de espaço antes dos backups agendados (ORA-19809 com o backup na FRA).
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
const pf = require('../src/backupPreflight');

const GB = 1024;
const G = { ...bs.DEFAULT_GUARD };
const FULL_FRA = bs.validateSchedule({ strategy: 'full' }, 'linux');
const INCR_FRA = bs.validateSchedule({ strategy: 'incremental' }, 'linux');
const FULL_DIR = bs.validateSchedule({ strategy: 'full', destination: 'dir', directory: '/u04/bk' }, 'linux');

// O caso do log: FRA de 5 GB, banco com 20 GB usados e nenhum backup completo ainda.
const M0 = {
    dest: '/u01/fra', limitMb: 5 * GB, usedMb: 2 * GB, reclaimMb: 0, spfile: '/u01/spfileorcl.ora',
    dbMb: 30 * GB, ratio: null, l1Mb: null, unbackedMb: 1500, peakHourMb: 300, backupMin: null,
    asmFreeMb: null, asmTotalMb: null, usedDbMb: 20 * GB,
};
const BIG = { fra: { freeMb: 150 * GB, totalMb: 300 * GB } };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1, `${msg || ''} ${a} ≈ ${b}`);

/** Saída do preflight.sql para uma medição (o que o sqlplus imprimiria). */
function pfText(m) {
    const v = (x) => (x == null ? '' : x);
    const line = 'PF~' + [v(m.dest), m.limitMb, m.usedMb, m.reclaimMb, v(m.spfile), m.dbMb, m.ratio != null ? Math.round(m.ratio * 10000) : '',
        v(m.l1Mb), m.unbackedMb, m.peakHourMb, v(m.backupMin), v(m.asmFreeMb), v(m.asmTotalMb)].join('|~|');
    return [line, ...(m.usedDbMb != null ? [`PU~${m.usedDbMb}`] : [])].join('\n') + '\n';
}

// ------------------------------------------------------------------ medição
test('parse: linha PF do sqlplus (campos vazios = sem histórico) e PU opcional', () => {
    assert.deepEqual(pf.parse(`\nSQL*Plus\n${pfText(M0)}`), M0);
    const mounted = pf.parse(pfText({ ...M0, usedDbMb: null }));
    assert.equal(mounted.usedDbMb, null, 'banco só montado: sem dba_segments');
    assert.equal(pf.parse(pfText({ ...M0, ratio: 0.3125, l1Mb: 900, backupMin: 42 })).ratio, 0.3125);
    assert.equal(pf.parse('ORA-01034: ORACLE not available'), null);
    assert.ok(pf.PF_SQL.split('\n').every((l) => l.length < 2400 && l.trim() !== ''), 'linhas curtas e sem linha em branco (SQL*Plus)');
});

test('estimativa: histórico do RMAN quando existe; senão o tamanho usado do banco', () => {
    const e0 = pf.estimate('full', FULL_FRA, M0);
    near(e0.estMb, (20 * GB * 0.4 + 1500 * 0.6) * 1.2, 'compactado sem histórico: 40% do usado + archives');
    assert.equal(e0.headroomMb, 1024, 'folga mínima de 1 GB');
    assert.equal(e0.basis, 'size-compressed');
    const hist = pf.estimate('full', FULL_FRA, { ...M0, ratio: 0.25, backupMin: 30, peakHourMb: 2000 });
    near(hist.estMb, (30 * GB * 0.25 + 900) * 1.2, 'histórico: proporção × tamanho alocado');
    assert.equal(hist.headroomMb, 3000, 'pico/hora × (duração + 1 h)');
    assert.equal(hist.basis, 'history');
    near(pf.estimate('level1', INCR_FRA, M0).estMb, (20 * GB * 0.4 * 0.25 + 900) * 1.2, 'nível 1 sem histórico: 25% do nível 0');
    near(pf.estimate('level1', INCR_FRA, { ...M0, ratio: 0.25, l1Mb: 500 }).estMb, (30 * GB * 0.25 * 0.1 + 900) * 1.2, 'nível 1 pequeno: piso de 10% do nível 0');
    const raw = pf.estimate('full', { ...FULL_FRA, compress: false }, { ...M0, ratio: 0.25 });
    near(raw.estMb, (20 * GB + 1500) * 1.2, 'sem compactação: os blocos usados');
    assert.equal(raw.basis, 'size');
});

// ------------------------------------------------------------------ decisão
test('decisão: o caso do ORA-19809 — FRA de 5 GB aumenta antes do backup (disco com folga)', () => {
    const d = pf.decide('level0', INCR_FRA, G, M0, BIG);
    assert.equal(d.verdict, 'grow');
    assert.equal(d.toMb % GB, 0, 'GB inteiros');
    assert.ok(d.toMb >= d.effMb + d.needMb, 'cabe o backup + a folga');
    assert.ok(d.toMb >= Math.ceil((d.effMb + d.needMb) / 0.85), 'e ainda fica abaixo do limite de "aumentar" do guardião');
    assert.equal(d.scope, 'BOTH');
    assert.equal(pf.decide('level0', INCR_FRA, G, { ...M0, spfile: null }, BIG).scope, 'MEMORY');
});

test('decisão: cabe, não cabe no disco, teto, disco desconhecido, ASM e tarefas sem verificação', () => {
    assert.equal(pf.decide('full', FULL_FRA, G, { ...M0, limitMb: 40 * GB }, BIG).verdict, 'ok');
    const small = pf.decide('full', FULL_FRA, G, M0, { fra: { freeMb: 6 * GB, totalMb: 100 * GB } });
    assert.deepEqual([small.verdict, small.where, small.why, small.availMb], ['noroom', 'fra', 'disk', 3 * GB]);
    const cap = pf.decide('full', FULL_FRA, { ...G, maxSizeGb: 10 }, M0, BIG);
    assert.deepEqual([cap.verdict, cap.why], ['noroom', 'cap']);
    assert.equal(pf.decide('full', FULL_FRA, { ...G, maxSizeGb: 40 }, M0, BIG).verdict, 'grow');
    const unknown = pf.decide('full', FULL_FRA, G, M0, {});
    assert.deepEqual([unknown.verdict, unknown.why], ['noroom', 'disk-unknown'], 'sem medir o disco não aumenta às cegas');
    const asm = { ...M0, dest: '+FRA', asmFreeMb: 200 * GB, asmTotalMb: 400 * GB };
    assert.equal(pf.decide('full', FULL_FRA, G, asm, {}).verdict, 'grow');
    assert.equal(pf.decide('full', FULL_FRA, G, { ...asm, asmTotalMb: null }, {}).why, 'disk-unknown');
    assert.equal(pf.decide('archivelog', FULL_FRA, G, M0, BIG).verdict, 'skip');
    assert.equal(pf.decide('full', FULL_FRA, G, { ...M0, dest: null, limitMb: 0 }, BIG).where, 'nofra');
});

test('decisão com destino em diretório: o disco do diretório decide; a FRA só precisa da folga', () => {
    const dirSmall = pf.decide('full', FULL_DIR, G, M0, { ...BIG, dir: { freeMb: 8 * GB, totalMb: 100 * GB } });
    assert.deepEqual([dirSmall.verdict, dirSmall.where, dirSmall.availMb], ['noroom', 'dir', 0]);
    const dirOk = { ...BIG, dir: { freeMb: 500 * GB, totalMb: 1000 * GB } };
    assert.equal(pf.decide('full', FULL_DIR, G, M0, dirOk).verdict, 'ok', '3 GB livres na FRA bastam para a folga');
    const tinyFra = { ...M0, limitMb: 2 * GB, usedMb: 1800 };
    assert.equal(pf.decide('full', FULL_DIR, G, tinyFra, dirOk).verdict, 'grow');
    const noGrow = pf.decide('full', FULL_DIR, G, tinyFra, { ...dirOk, fra: { freeMb: 1 * GB, totalMb: 50 * GB } });
    assert.deepEqual([noGrow.verdict, noGrow.why], ['ok', 'disk'], 'folga curta na FRA não impede backup em outro disco');
});

// ------------------------------------------------------------------ execução (Windows)
test('run(): aumenta e registra; falha ao aumentar = backup do banco não começa; sem medição segue', async () => {
    const settings = { schedule: INCR_FRA, guard: G };
    const calls = [];
    const deps = (over = {}) => ({
        measure: async () => M0,
        disk: async (dir) => (dir === '/u01/fra' ? BIG.fra : null),
        grow: async (toMb, scope) => { calls.push([toMb, scope]); return { ok: true }; },
        ...over,
    });
    const r = await pf.run('level0', settings, deps());
    assert.equal(r.verdict, 'grow');
    assert.equal(r.decision.grown, true);
    assert.deepEqual(calls, [[r.decision.toMb, 'BOTH']]);
    assert.match(r.text, /aumentado para \d+,0 GB/);
    assert.match(r.text, /tamanho usado do banco, compactado/);

    const bad = await pf.run('level0', settings, deps({ grow: async () => ({ ok: false, error: 'ORA-32001: write to SPFILE requested' }) }));
    assert.equal(bad.verdict, 'noroom');
    assert.match(bad.text, /ORA-32001/);
    assert.match(bad.text, /NÃO foi iniciado/);

    const blind = await pf.run('full', settings, deps({ measure: async () => { throw new Error('ORA-01017: invalid username/password'); } }));
    assert.equal(blind.verdict, 'unknown');
    assert.match(blind.text, /segue sem a verificação/);
    assert.deepEqual(await pf.run('archivelog', settings, deps()), { verdict: 'skip', text: '' });
});

test('sugestão da FRA: backups com destino na FRA entram na conta (pico = cópia nova + retidas)', () => {
    const win3 = { type: 'recovery-window', days: 3 };
    near(pf.fraBackupsAllowance(FULL_FRA, win3, 100, 10).gb, 5 * 60, 'completo diário, janela de 3 dias: 5 cópias de 60%');
    const inc = pf.fraBackupsAllowance(INCR_FRA, win3, 100, 10);
    near(inc.gb, 2 * 60 + 10 * 60 * 0.15);
    assert.match(inc.text, /2 backups nível 0/);
    near(pf.fraBackupsAllowance(FULL_FRA, { type: 'redundancy', redundancy: 2 }, 100, 10).gb, 3 * 60);
    assert.equal(pf.fraBackupsAllowance(FULL_DIR, win3, 100, 10).gb, 0, 'diretório próprio: nada na FRA');
    near(pf.fraBackupsAllowance(bs.validateSchedule({ strategy: 'archivelog', archKeepDays: 7 }, 'linux'), win3, 100, 10).gb, 10 * 7 * 0.6);
});

// ------------------------------------------------------------------ Linux: awk e run-job.sh
const SH = ['sh', 'C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe'].find((c) => {
    try { return spawnSync(c, ['-c', 'exit 0'], { windowsHide: true }).status === 0; } catch { return false; }
});
const posix = (p) => p.replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
const shEnv = (extra = {}) => {
    const shDir = SH && path.isAbsolute(SH) ? path.dirname(SH) : null;
    const { PATH: first, ...rest } = extra;
    return { ...process.env, ...rest, PATH: [first, shDir, process.env.PATH].filter(Boolean).join(path.delimiter) };
};

function vectors() {
    const out = [
        ['level0', INCR_FRA, G, M0, BIG],
        ['full', FULL_FRA, G, M0, { fra: { freeMb: 6 * GB, totalMb: 100 * GB } }],
        ['full', FULL_FRA, { ...G, maxSizeGb: 10 }, M0, BIG],
        ['full', FULL_FRA, G, M0, {}],
        ['full', FULL_FRA, G, { ...M0, limitMb: 40 * GB, spfile: null }, BIG],
        ['level1', INCR_FRA, G, { ...M0, ratio: 0.3125, l1Mb: 700, backupMin: 95, peakHourMb: 1800 }, BIG],
        ['full', FULL_DIR, G, M0, { ...BIG, dir: { freeMb: 8 * GB, totalMb: 100 * GB } }],
        ['full', FULL_DIR, G, { ...M0, limitMb: 2 * GB, usedMb: 1800 }, { fra: { freeMb: 1 * GB, totalMb: 50 * GB }, dir: { freeMb: 500 * GB, totalMb: 1000 * GB } }],
        ['full', FULL_FRA, G, { ...M0, dest: '+FRA', asmFreeMb: 200 * GB, asmTotalMb: 400 * GB }, {}],
        ['full', { ...FULL_FRA, compress: false }, G, { ...M0, usedDbMb: null }, BIG],
        ['full', FULL_FRA, G, { ...M0, dest: null, limitMb: 0 }, BIG],
    ];
    // Valores aleatórios (semente fixa): pega diferenças de arredondamento entre JS e awk.
    let seed = 20261014;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
    for (let i = 0; i < 150; i++) {
        const limitMb = 1024 + rnd(200 * GB);
        const m = {
            ...M0, limitMb, usedMb: rnd(limitMb), reclaimMb: rnd(4 * GB), dbMb: 512 + rnd(800 * GB), usedDbMb: rnd(3) ? rnd(600 * GB) : null,
            ratio: rnd(2) ? (1 + rnd(9999)) / 10000 : null, l1Mb: rnd(2) ? rnd(50 * GB) : null, unbackedMb: rnd(30 * GB), peakHourMb: rnd(8 * GB),
            backupMin: rnd(2) ? rnd(600) : null, spfile: rnd(4) ? '/u01/spfile.ora' : null,
            ...(rnd(6) ? {} : { dest: '+FRA', asmFreeMb: rnd(500 * GB), asmTotalMb: rnd(4) ? 1 + rnd(900 * GB) : null }),
        };
        const sched = [FULL_FRA, INCR_FRA, FULL_DIR, { ...FULL_FRA, compress: false }][rnd(4)];
        const disk = () => (rnd(5) ? (() => { const t = 1 + rnd(2000 * GB); return { totalMb: t, freeMb: rnd(t) }; })() : null);
        const g = { ...G, growPct: 40 + rnd(58), diskReservePct: 2 + rnd(48), maxSizeGb: rnd(3) ? 0 : rnd(500) };
        out.push([['full', 'level0', 'level1'][rnd(3)], sched, g, m, { fra: disk(), dir: disk() }]);
    }
    return out;
}

test('Linux: o awk do run-job.sh decide exatamente como o painel (paridade em 160 casos)', { skip: !SH && 'sh não encontrado' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-pf-'));
    try {
        fs.writeFileSync(path.join(dir, 'preflight.awk'), pf.linuxAwk());
        const vs = vectors();
        const script = ['cd "$1"'];
        vs.forEach(([job, sched, g, m, disks], i) => {
            assert.deepEqual(pf.parse(pfText(m)), m, `caso ${i}: a medição sobrevive à ida e volta pelo sqlplus`);
            fs.writeFileSync(path.join(dir, `${i}.pf`), pfText(m));
            const p = pf.params(sched, g);
            const d = (x) => (x ? `${x.totalMb} ${x.freeMb}` : '');
            const fra = m.dest && !String(m.dest).startsWith('+') ? d(disks.fra) : '';
            script.push(`echo "### ${i}"`,
                `awk -v job=${job} -v comp=${p.comp} -v todir=${p.todir} -v growpct=${p.growPct} -v reservepct=${p.reservePct} -v maxgb=${p.maxGb} -v fradisk="${fra}" -v dirdisk="${p.todir ? d(disks.dir) : ''}" -f preflight.awk ${i}.pf`);
        });
        const r = spawnSync(SH, ['-s', posix(dir)], { input: script.join('\n') + '\n', encoding: 'utf8', windowsHide: true, env: shEnv() });
        assert.equal(r.status, 0, r.stderr);
        const blocks = r.stdout.split(/^### /m).slice(1);
        assert.equal(blocks.length, vs.length);
        const verdicts = new Set();
        blocks.forEach((b, i) => {
            const [job, sched, g, m, disks] = vs[i];
            const js = pf.decide(job, sched, g, m, { fra: m.dest && !String(m.dest).startsWith('+') ? disks.fra : null, dir: sched.destination === 'dir' ? disks.dir : null });
            const line = b.split('\n').find((l) => l.startsWith('@@PF'));
            const f = line.split(/\s+/);
            const got = { verdict: f[1], where: f[2], why: f[3], toMb: +f[4], needMb: +f[5], availMb: +f[6], scope: f[7], estMb: +f[8], headroomMb: +f[9], limitMb: +f[10], effMb: +f[11], freeMb: +f[12] };
            const want = { verdict: js.verdict, where: js.where, why: js.why, toMb: js.toMb, needMb: js.needMb, availMb: js.availMb, scope: js.scope, estMb: js.estMb, headroomMb: js.headroomMb, limitMb: js.limitMb, effMb: js.effMb, freeMb: js.freeMb };
            assert.deepEqual(got, want, `caso ${i}: ${JSON.stringify(vs[i])}`);
            assert.match(b, /Verificacao de espaco antes do backup/);
            verdicts.add(`${js.verdict}:${js.where}`);
        });
        for (const v of ['grow:fra', 'ok:fra', 'noroom:fra', 'noroom:dir', 'ok:nofra']) assert.ok(verdicts.has(v), `cobertura: ${v}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Linux: run-job.sh real — aumenta a FRA, ou faz só os archivelogs (código 3) quando não cabe', { skip: !SH && 'sh não encontrado' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-pfrun-'));
    try {
        const home = path.join(dir, 'home');
        const stubs = path.join(dir, 'stubs');
        const oh = path.join(dir, 'oh');
        fs.mkdirSync(home);
        fs.mkdirSync(stubs);
        fs.mkdirSync(path.join(oh, 'bin'), { recursive: true });
        const stub = (file, body) => fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        stub(path.join(stubs, 'id'), 'case "$1" in -u) echo 1000;; -un) echo oracle;; -gn) echo oinstall;; *) echo "uid=1000(oracle)";; esac');
        stub(path.join(stubs, 'chown'), 'exit 0');
        stub(path.join(stubs, 'crontab'), `if [ "$1" = "-l" ]; then cat "${posix(home)}/crontab.txt" 2>/dev/null; else cp "$1" "${posix(home)}/crontab.txt"; fi`);
        // run-job.sh põe $ORACLE_HOME/bin à frente do PATH: o df falso fica lá
        stub(path.join(oh, 'bin', 'df'), 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/sdb1 $DF_TOTAL_KB 0 $DF_FREE_KB 50% /u01"');
        // sqlplus falso: com @arquivo devolve a medição; pela entrada padrão grava o comando
        stub(path.join(oh, 'bin', 'sqlplus'), 'for a in "$@"; do case "$a" in @*) cat "$PF_FIXTURE"; exit 0;; esac; done; cat >> "$SQL_LOG"; [ -n "$SQL_ORA" ] && echo "$SQL_ORA"; exit 0');
        stub(path.join(oh, 'bin', 'rman'), 'A=; for a in "$@"; do case "$a" in log=*) L="${a#log=}";; cmdfile=*) C="${a#cmdfile=}";; append) A=1;; esac; done; [ -n "$A" ] || : > "$L"; { echo "Recovery Manager"; cat "$C"; } >> "$L"; exit 0');

        const s = bs.validateSchedule({ strategy: 'incremental', level0Day: 0, time: '01:00', archivelogHours: 4 }, 'linux');
        const env = shEnv({ HOME: posix(home), PATH: stubs });
        const inst = spawnSync(SH, ['-s'], { input: bs.buildLinuxInstallScript(s, { home: posix(oh), sid: 'orcl', runAs: 'oracle' }, G), encoding: 'utf8', windowsHide: true, env });
        assert.equal(bs.parseMarkers(inst.stdout).ok, true, inst.stdout + inst.stderr);
        const base = path.join(home, 'oraclepulse');
        for (const f of ['rman/preflight.sql', 'bin/preflight.awk', 'rman/fallback.rcv']) assert.ok(fs.existsSync(path.join(base, f)), f);
        assert.equal(fs.readFileSync(path.join(base, 'rman', 'fallback.rcv'), 'utf8'), bs.rmanLines('archivelog', s).join('\n') + '\n');

        const fixture = path.join(dir, 'pf.txt');
        fs.writeFileSync(fixture, `\n${pfText(M0)}`);
        const sqlLog = path.join(dir, 'sql.log');
        const job = (name, extra) => {
            fs.rmSync(sqlLog, { force: true });
            const r = spawnSync(SH, [path.join(base, 'bin', 'run-job.sh'), name], { encoding: 'utf8', windowsHide: true, env: { ...env, PF_FIXTURE: posix(fixture), SQL_LOG: posix(sqlLog), ...extra } });
            const st = bs.parseMarkers(spawnSync(SH, ['-s'], { input: bs.buildLinuxStatusScript(), encoding: 'utf8', windowsHide: true, env }).stdout).status[name];
            const log = fs.readFileSync(path.join(home, st.log.split('/home/')[1]), 'utf8');
            return { rc: r.status, st, log, sql: fs.existsSync(sqlLog) ? fs.readFileSync(sqlLog, 'utf8') : '' };
        };
        const bigDisk = { DF_TOTAL_KB: String(300 * GB * 1024), DF_FREE_KB: String(150 * GB * 1024) };

        // 1) Disco com folga: o limite sobe antes e o nível 0 roda
        const want = pf.decide('level0', s, G, M0, BIG);
        const ok = job('level0', bigDisk);
        assert.equal(ok.rc, 0, ok.log);
        assert.match(ok.sql, new RegExp(`ALTER SYSTEM SET db_recovery_file_dest_size = ${want.toMb}M SCOPE=BOTH;`));
        assert.match(ok.log, /Verificacao de espaco antes do backup/);
        assert.match(ok.log, new RegExp(`limite da FRA aumentado para ${want.toMb} MB`));
        assert.match(ok.log, /INCREMENTAL LEVEL 0 DATABASE/, 'o RMAN acrescenta ao mesmo log');

        // 2) Disco cheio: o nível 0 não começa, os archives são copiados, código 3
        const full = job('level0', { DF_TOTAL_KB: String(100 * GB * 1024), DF_FREE_KB: String(6 * GB * 1024) });
        assert.equal(full.rc, pf.NOROOM_RC);
        assert.equal(full.sql, '', 'sem ALTER SYSTEM');
        assert.match(full.log, /SEM ESPACO/);
        assert.match(full.log, /NAO foi iniciado/);
        assert.match(full.log, /ARCHIVELOG ALL NOT BACKED UP 1 TIMES FILESPERSET 8/);
        assert.doesNotMatch(full.log, /INCREMENTAL LEVEL 0 DATABASE/);
        const ev = bs.evaluateJobs({ ...s, installed: { at: new Date(Date.now() - 60000).toISOString() } }, { level0: full.st });
        assert.equal(ev.jobs[0].state, 'noroom');
        assert.match(ev.alerts.find((a) => a.id === 'backup-failed:level0').message, /NÃO foi iniciado/);

        // 3) O ALTER SYSTEM falha: mesmo caminho seguro
        const refused = job('level0', { ...bigDisk, SQL_ORA: 'ORA-02097: parameter cannot be modified' });
        assert.equal(refused.rc, pf.NOROOM_RC);
        assert.match(refused.log, /FALHA ao aumentar[\s\S]*ORA-02097/);

        // 4) Sem conseguir medir (sqlplus com erro): o backup segue como antes
        fs.writeFileSync(fixture, 'ERROR:\nORA-01034: ORACLE not available\n');
        const blind = job('level1', bigDisk);
        assert.equal(blind.rc, 0);
        assert.match(blind.log, /nao foi possivel medir[\s\S]*ORA-01034/);
        assert.match(blind.log, /INCREMENTAL LEVEL 1 DATABASE/);

        // 5) Archivelog: sem verificação
        const arch = job('archivelog', bigDisk);
        assert.equal(arch.rc, 0);
        assert.doesNotMatch(arch.log, /Verificacao/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

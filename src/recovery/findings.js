/**
 * FINDINGS.JS - Transforma os sinais coletados em PROBLEMAS (com severidade,
 * evidências e o procedimento recomendado) e num checklist de PRONTIDÃO para
 * recuperação. Função pura: recebe o diagnóstico, devolve o laudo.
 *
 * Correlação (para não repetir o mesmo problema várias vezes):
 *  - mensagens complementares (ORA-01110, ORA-27037...) viram evidência do erro
 *    principal, nunca um problema próprio;
 *  - erros do alert log sobre um arquivo/membro já tratado por uma regra
 *    específica entram como evidência dessa regra;
 *  - o que aconteceu ANTES da última abertura do banco e não se repetiu é
 *    histórico; o que importa para um banco que não abre é o que veio DEPOIS
 *    do último startup;
 *  - erros dentro de jobs agendados (ORA-12012) têm impacto restrito ao job.
 */
const kb = require('./knowledge');
const { CATALOG, STATE_LABEL, badTempfiles } = require('./playbooks');
const sp = require('../storagePaths');

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const DOWNGRADE = { critical: 'high', high: 'medium', medium: 'low', low: 'info', info: 'info' };
const DAY = 86400000;

const pct = (n) => (n == null ? '--' : `${String(n).replace('.', ',')}%`);

function ageDays(text, now = Date.now()) {
    if (!text) return null;
    const t = Date.parse(String(text).replace(' ', 'T'));
    return Number.isFinite(t) ? (now - t) / DAY : null;
}

function fmtAge(days) {
    if (days == null) return 'nunca';
    if (days < 1 / 24) return 'há minutos';
    if (days < 1) return `há ${Math.round(days * 24)} h`;
    return `há ${Math.round(days)} dia(s)`;
}

/** Playbook aplicável ao estado atual? (UNKNOWN deixa passar: o plano revalida). */
function applicable(id, state) {
    const p = CATALOG[id];
    if (!p) return false;
    return state === 'UNKNOWN' || p.states.includes(state);
}

function pb(id, params = {}, recommended = false, reason = null, label = null) {
    return { id, params, recommended, reason, label };
}

// ==========================================================================
// Acesso ao alert log
// ==========================================================================

const alertGroups = (s) => (s.alert && s.alert.groups) || [];
const alertRecords = (s) => (s.alert && s.alert.records) || [];
const lifecycle = (s) => (s.alert && s.alert.lifecycle) || {};
const lastOpenEpoch = (s) => (lifecycle(s).lastOpen ? lifecycle(s).lastOpen.epoch : null);
const lastStartupEpoch = (s) => (lifecycle(s).lastStartup ? lifecycle(s).lastStartup.epoch : null);

/** Registros do alert log da instância atual (desde o último startup). */
function currentRecords(s) {
    const since = lastStartupEpoch(s);
    return alertRecords(s).filter((r) => !since || r.epoch == null || r.epoch >= since);
}

function findInRecords(records, pred) {
    for (let i = records.length - 1; i >= 0; i--) {
        const c = records[i].codes.find(pred);
        if (c) return { record: records[i], code: c };
    }
    return null;
}

function recentGroup(s, codes, sinceDays = 7) {
    const now = Date.now();
    return alertGroups(s).find((g) => codes.includes(g.code) && (g.lastEpoch == null || now - g.lastEpoch <= sinceDays * DAY));
}

function groupsAbout(s, { fileNo, logPath }) {
    return alertGroups(s).filter((g) => (fileNo != null && g.files.some((f) => f.fileNo === fileNo)) || (logPath && g.logs.some((l) => l.path === logPath)));
}

function samplesOf(groups) {
    const out = [];
    for (const g of groups) for (const x of g.samples) if (out.length < 3 && !out.some((o) => o.text === x.text)) out.push(x);
    return out;
}

// ==========================================================================
// Montador do laudo
// ==========================================================================

class Builder {
    constructor(s) {
        this.s = s;
        this.items = [];
        this.handledCodes = new Set();
        this.handledFiles = new Set();
        this.handledLogs = new Set();
        this.handledKcratr = false;
    }

    add(f) {
        const playbooks = (f.playbooks || []).filter((p) => applicable(p.id, this.s.state));
        if (playbooks.length && !playbooks.some((p) => p.recommended)) playbooks[0].recommended = true;
        const entry = f.code ? kb.lookup(f.code, f.arg || null) : null;
        const category = f.category || (entry && entry.category) || 'recovery';
        this.items.push({
            id: f.id,
            severity: f.severity,
            status: f.status || 'active',
            code: f.code || null,
            arg: f.arg || null,
            category,
            categoryLabel: kb.CATEGORIES[category] || 'Recuperação',
            title: f.title,
            detail: f.detail || (entry && entry.meaning) || '',
            evidence: (f.evidence || []).filter(Boolean).slice(0, 12),
            samples: f.samples || [],
            actions: f.actions || (entry && entry.actions) || [],
            causes: f.causes || (entry && entry.causes) || [],
            lastSeen: f.lastSeen || null,
            count: f.count || null,
            playbooks,
            link: f.link || (entry && entry.link) || null,
        });
        if (f.code) this.handledCodes.add(f.code);
        (f.alsoHandles || []).forEach((c) => this.handledCodes.add(c));
        (f.files || []).forEach((n) => this.handledFiles.add(n));
        (f.logs || []).forEach((p) => this.handledLogs.add(p));
    }
}

// ==========================================================================
// Regras: estado da instância
// ==========================================================================

function ruleState(b) {
    const s = b.s;
    const conn = s.connection || {};
    const err = conn.error || null;

    if (s.state === 'DOWN') {
        const crash = lifecycle(s).lastCrash;
        const lo = lastOpenEpoch(s);
        const recentCrash = crash && (!lo || crash.epoch >= lo) ? crash : null;
        const cause = recentCrash && recentCrash.crashCode ? kb.lookup(recentCrash.crashCode) : null;
        const causeGroup = recentCrash && recentCrash.crashCode ? alertGroups(s).find((g) => g.code === recentCrash.crashCode) : null;
        b.add({
            id: 'state-down', severity: 'critical', code: 'ORA-01034', category: 'instance',
            title: recentCrash ? `A instância caiu${cause ? ` (${recentCrash.crashCode})` : ''} e está parada` : 'A instância está parada',
            detail: recentCrash
                ? `A instância foi derrubada em ${recentCrash.time}${cause ? ` por ${recentCrash.crashCode} — ${cause.meaning}` : '.'} Inicie-a; a recuperação de instância é automática. Se a abertura falhar, o painel mostrará o motivo e o próximo passo.`
                : 'Não há instância em execução. Inicie-a; se a abertura falhar, o painel mostrará o motivo e o próximo passo.',
            evidence: [
                err && err.message,
                recentCrash ? `${recentCrash.time}: ${recentCrash.text.split('\n').slice(-1)[0]}` : null,
                cause ? `Causa da queda — ${cause.title}` : null,
                ...(cause ? cause.actions.filter((a) => !/^Inicie/i.test(a)).map((a) => `Depois de subir: ${a.charAt(0).toLowerCase()}${a.slice(1)}`) : []),
            ],
            samples: causeGroup ? causeGroup.samples : (recentCrash ? [{ time: recentCrash.time, text: recentCrash.text }] : []),
            playbooks: [pb('startup', {}, true)],
            alsoHandles: ['ORA-27101', ...(recentCrash && recentCrash.crashCode ? [recentCrash.crashCode] : [])],
        });
        return;
    }

    if (!conn.ok && err && s.state === 'UNKNOWN') {
        const entry = err.code ? kb.lookup(err.code) : null;
        const playbooks = [];
        if (['DOWN?', 'NOT_OPEN'].includes(err.state)) playbooks.push(pb('startup', {}, true));
        if (err.code === 'ORA-12541' || err.code === 'ORA-12560') playbooks.push(pb('listener-start', {}, err.code === 'ORA-12541'));
        if (err.code === 'ORA-28000') playbooks.push(pb('unlock-account', {}, true));
        if (err.code === 'ORA-00257') playbooks.push(pb('fra-free', {}, true));
        b.add({
            id: 'connect-failed', severity: err.state === 'OPEN?' ? 'high' : 'critical', code: err.code, category: 'connectivity',
            title: entry ? `O painel não consegue conectar: ${entry.title}` : 'O painel não consegue conectar ao banco',
            detail: (entry ? `${entry.meaning} ` : '') + (s.capabilities && s.capabilities.canSysdba
                ? ''
                : 'Para um diagnóstico completo com o banco fora do ar, configure DB_ORACLE_HOME, DB_ORACLE_SID e DB_SYS_PASSWORD (o painel passa a consultar como SYSDBA no servidor).'),
            evidence: [err.message, s.sysdbaError ? `sqlplus SYSDBA: ${s.sysdbaError}` : null],
            playbooks,
        });
        return;
    }

    const cur = currentRecords(s);

    if (s.state === 'STARTED') {
        const cfCodes = ['ORA-00205', 'ORA-00202', 'ORA-00210', 'ORA-00214', 'ORA-00227'];
        const cf = findInRecords(cur, (c) => cfCodes.includes(c.code));
        b.add({
            id: 'state-nomount', severity: 'critical', code: cf ? cf.code.code : 'ORA-01507', category: 'instance',
            title: cf ? 'Banco parado em NOMOUNT: controlfile ilegível' : 'Banco parado em NOMOUNT',
            detail: cf
                ? 'A instância subiu mas não conseguiu ler o controlfile. Restaure-o de uma cópia boa ou do autobackup.'
                : 'A instância está no ar, mas o controlfile ainda não foi montado. Monte e abra o banco.',
            evidence: cf ? [`${cf.record.time}: ${cf.record.text.split('\n').slice(0, 3).join(' · ')}`, ...cf.record.controlfiles.map((c) => `Controlfile com erro: ${c}`)] : [],
            samples: cf ? [{ time: cf.record.time, text: cf.record.text }] : [],
            playbooks: cf ? [pb('controlfile-restore', {}, true), pb('startup')] : [pb('startup', {}, true), pb('controlfile-restore')],
            alsoHandles: cf ? cfCodes : [],
        });
        return;
    }

    if (s.state === 'MOUNTED') {
        const rec = s.recoverFiles || [];
        const lostCurrent = (s.logs || []).find((g) => ['CURRENT', 'ACTIVE'].includes(g.status) && g.memberList.length && g.memberList.every((m) => m.status === 'INVALID'));
        const kcratr = findInRecords(cur, (c) => c.code === 'ORA-00600' && /^kcratr_/i.test(c.arg || ''));
        const resetlogs = findInRecords(cur, (c) => c.code === 'ORA-01589');
        const openErr = findInRecords(cur, (c) => !kb.COMPANIONS.includes(c.code) && !kb.BENIGN_RECOVERY.includes(c.code));
        const backupCf = s.database && s.database.controlfileType === 'BACKUP';
        const missing = rec.filter((r) => /NOT FOUND|CANNOT OPEN|MISSING|WRONG/i.test(r.error || ''));
        const ev = [
            `Instância ${STATE_LABEL.MOUNTED}${s.instance && s.instance.startup ? ` desde ${s.instance.startup}` : ''}.`,
            rec.length ? `${rec.length} datafile(s) em V$RECOVER_FILE: ${rec.slice(0, 6).map((r) => `#${r.fileNo}${r.error ? ` (${r.error})` : ''}`).join(', ')}${rec.length > 6 ? '…' : ''}` : null,
            lostCurrent ? `Grupo de redo ${lostCurrent.group} (${lostCurrent.status}) sem nenhum membro válido: ${lostCurrent.memberList.map((m) => m.path).join(', ')}` : null,
            kcratr ? `ORA-00600 [${kcratr.code.arg}] em ${kcratr.record.time}.` : null,
            !kcratr && openErr ? `Último erro desde o startup: ${openErr.code.code} em ${openErr.record.time}.` : null,
            backupCf ? 'Controlfile atual é de BACKUP.' : null,
        ];
        let title = 'Banco montado, mas não aberto';
        let detail = 'O banco está em MOUNT. ';
        let playbooks;
        let code = rec.length ? 'ORA-01113' : 'ORA-01109';
        let arg = null;
        if (lostCurrent) {
            title = 'Banco não abre: redo log corrente perdido';
            detail += 'O grupo de redo que estava em uso não pode ser lido: a recuperação completa é impossível. Recupere até o último redo arquivado e abra com RESETLOGS (as transações que estavam só nesse log são perdidas).';
            playbooks = [pb('incomplete-recovery', {}, true), pb('restore-database')];
            code = 'ORA-00313';
        } else if (resetlogs || (backupCf && !rec.length)) {
            title = 'Banco aguardando OPEN RESETLOGS';
            detail += 'A recuperação incompleta (ou com controlfile de backup) já foi feita; falta abrir com RESETLOGS.';
            playbooks = [pb('open-resetlogs', {}, true), pb('incomplete-recovery')];
            code = 'ORA-01589';
        } else if (backupCf) {
            title = 'Banco montado com controlfile de backup';
            detail += 'É preciso recuperar usando o controlfile de backup e abrir com RESETLOGS.';
            playbooks = [pb('incomplete-recovery', { usingBackupControlfile: true }, true)];
            code = 'ORA-01207';
        } else if (missing.length) {
            title = 'Banco não abre: datafile ausente';
            detail += `${missing.length} datafile(s) não foram encontrados/abertos. Se o volume estiver desmontado, monte-o; se o arquivo foi perdido, restaure do backup.`;
            playbooks = [pb('datafile-restore', { fileNo: missing[0].fileNo }, true), pb('restore-database')];
            code = 'ORA-01157';
        } else if (rec.length || kcratr) {
            title = kcratr ? 'Banco não abre após queda (recuperação de instância falhou)' : 'Banco não abre: arquivos precisam de recuperação';
            detail += 'Os datafiles estão atrás do redo. Aplique o redo (RECOVER DATABASE) e abra — recuperação completa, sem perda de dados.';
            playbooks = [pb('crash-recovery', {}, true)];
            if (rec.length === 1 && String(rec[0].ts).toUpperCase() !== 'SYSTEM') playbooks.push(pb('datafile-recover', { fileNo: rec[0].fileNo }));
            if (kcratr) { code = 'ORA-00600'; arg = kcratr.code.arg; }
        } else {
            detail += 'Nenhum impedimento foi encontrado no controlfile: tente abrir. Se falhar, o erro será analisado.';
            playbooks = [pb('startup', {}, true), pb('crash-recovery')];
        }
        const curCodes = [...new Set(cur.flatMap((r) => r.codes.map((c) => c.code)))];
        b.add({
            id: 'state-mounted', severity: 'critical', code, arg, category: 'instance', title, detail, evidence: ev,
            samples: cur.filter((r) => r.codes.length).slice(-3).map((r) => ({ time: r.time, text: r.text })),
            playbooks,
            // Os erros desta abertura fazem parte deste mesmo problema.
            alsoHandles: [...curCodes.filter((c) => c !== 'ORA-00600'), 'ORA-01113', 'ORA-01110', 'ORA-01033', 'ORA-01589'],
            logs: lostCurrent ? lostCurrent.memberList.map((m) => m.path) : [],
            files: rec.map((r) => r.fileNo),
        });
        b.handledKcratr = !!kcratr;
        b.currentOpenCodes = new Set(curCodes);
    }

    if (s.state === 'OPEN' && err && !conn.ok) {
        // Banco aberto (visto pelo SYSDBA), mas a conta do painel não entra (ex.: ORA-00257, ORA-28000)
        const entry = err.code ? kb.lookup(err.code) : null;
        const playbooks = [];
        if (err.code === 'ORA-28000') playbooks.push(pb('unlock-account', {}, true));
        if (err.code === 'ORA-00257') playbooks.push(pb('fra-free', { mode: 'grow' }, true));
        b.add({
            id: 'connect-failed-open', severity: 'critical', code: err.code, category: 'connectivity',
            title: entry ? `Banco aberto, mas o painel não conecta: ${entry.title}` : 'Banco aberto, mas o painel não conecta',
            detail: entry ? entry.meaning : err.message, evidence: [err.message], playbooks,
        });
    }
}

// ==========================================================================
// Regras: arquivos, corrupção, redo, controlfile, FRA, temp, inválidos
// ==========================================================================

function ruleDatafiles(b) {
    const s = b.s;
    if (s.state !== 'OPEN') return;
    const rec = s.recoverFiles || [];
    for (const r of rec.slice(0, 10)) {
        const missing = /NOT FOUND|CANNOT OPEN|MISSING|WRONG/i.test(r.error || '');
        const sys = String(r.ts || '').toUpperCase() === 'SYSTEM';
        const related = groupsAbout(s, { fileNo: r.fileNo });
        const last = related.reduce((a, g) => (!a || (g.lastEpoch || 0) > (a.lastEpoch || 0) ? g : a), null);
        b.add({
            id: `recover-${r.fileNo}`, severity: sys ? 'critical' : 'high', code: missing ? 'ORA-01157' : 'ORA-01113', category: 'media',
            title: `Datafile #${r.fileNo} (${r.ts || '?'}) ${missing ? 'não encontrado — precisa de restauração' : 'offline — precisa de recuperação'}`,
            detail: missing
                ? 'O Oracle não encontrou/abriu o arquivo. Se o volume está desmontado, monte-o e use "Recuperar datafile"; se o arquivo foi perdido, restaure do backup. Os objetos dessa tablespace estão inacessíveis.'
                : 'O arquivo ficou offline e atrás do redo (o Oracle o tirou de uso após um erro de I/O, por exemplo). Os objetos dessa tablespace estão inacessíveis até a recuperação — sem perda de dados.',
            evidence: [
                r.name,
                `Status: ${r.onlineStatus || '?'}${r.error ? ` · ${r.error}` : ''}${r.time ? ` · precisa de redo desde ${r.time}` : ''}`,
                ...related.filter((g) => !kb.COMPANIONS.includes(g.code)).slice(0, 3).map((g) => `${g.code}${g.arg ? ` [${g.arg}]` : ''}: ${(kb.lookup(g.code) || {}).title || ''} — ${g.count}x, último em ${g.last}`),
            ],
            samples: samplesOf(related),
            lastSeen: last ? last.last : null,
            playbooks: missing
                ? [pb('datafile-restore', { fileNo: r.fileNo }, true), pb('datafile-recover', { fileNo: r.fileNo })]
                : [pb('datafile-recover', { fileNo: r.fileNo }, true), pb('datafile-restore', { fileNo: r.fileNo })],
            alsoHandles: ['ORA-00376', 'ORA-01113'],
            files: [r.fileNo],
        });
    }
    if (rec.length > 10) b.add({ id: 'recover-more', severity: 'high', category: 'media', title: `Mais ${rec.length - 10} datafiles precisam de recuperação`, playbooks: [], files: rec.slice(10).map((r) => r.fileNo) });

    const recSet = new Set(rec.map((r) => r.fileNo));
    for (const d of (s.datafiles || []).filter((x) => x.status && !['ONLINE', 'SYSTEM'].includes(x.status) && !recSet.has(x.fileNo)).slice(0, 10)) {
        b.add({
            id: `offline-${d.fileNo}`, severity: 'medium', code: 'ORA-00376', category: 'media',
            title: `Datafile #${d.fileNo} (${d.ts}) está ${d.status}`,
            detail: 'O arquivo está fora de uso. Se ficou offline por erro, recupere e coloque online.',
            evidence: [d.name],
            samples: samplesOf(groupsAbout(s, { fileNo: d.fileNo })),
            playbooks: [pb('datafile-recover', { fileNo: d.fileNo }, true)],
            files: [d.fileNo],
        });
    }
}

function ruleCorruption(b) {
    const s = b.s;
    const corr = s.corruption || [];
    const segs = s.corruptSegments || [];
    const fromAlert = segs.filter((x) => x.fromAlert);
    const confirmed = segs.filter((x) => !x.fromAlert);
    const alertGroup = alertGroups(s).find((g) => g.code === 'ORA-01578');
    if (!corr.length && !fromAlert.length && !(alertGroup && alertGroup.blocks.length)) return;

    const segLabel = (c) => (c.segment ? `${c.segment.type} ${c.segment.owner}.${c.segment.name}${c.segment.partition ? ` (${c.segment.partition})` : ''}` : 'objeto não identificado (bloco livre ou fora de segmento)');
    const all = [...confirmed, ...fromAlert];
    const indexes = [...new Set(all.filter((c) => c.segment && /INDEX/.test(c.segment.type)).map((c) => `${c.segment.owner}.${c.segment.name}`))];
    const onlyIndexes = all.length > 0 && all.every((c) => c.segment && /INDEX/.test(c.segment.type));
    const totalBlocks = corr.reduce((a, c) => a + (c.blocks || 1), 0) || (alertGroup ? alertGroup.blocks.length : 0);
    const files = [...new Set(all.map((c) => c.fileNo).concat(corr.map((c) => c.fileNo)).concat(alertGroup ? alertGroup.blocks.map((x) => x.fileNo) : []))];
    const playbooks = [];
    if (onlyIndexes) indexes.forEach((ix, i) => playbooks.push(pb('index-rebuild', { index: ix }, i === 0, 'Os blocos são de índice: reconstruir resolve sem backup.')));
    playbooks.push(pb('block-recover', {}, !onlyIndexes));
    if (!onlyIndexes) indexes.forEach((ix) => playbooks.push(pb('index-rebuild', { index: ix })));
    if (files.length === 1) playbooks.push(pb('datafile-restore', { fileNo: files[0] }));
    b.add({
        id: 'corruption', severity: onlyIndexes ? 'high' : 'critical', code: 'ORA-01578', category: 'corruption',
        title: onlyIndexes ? `Blocos corrompidos em índice (${indexes.join(', ')})` : `Blocos de dados corrompidos (${totalBlocks || all.length})`,
        detail: onlyIndexes
            ? 'Os blocos ruins pertencem só a índice(s): os dados da tabela estão íntegros. Reconstruir o índice (ONLINE, sem parar o sistema) resolve; consultas que usam o índice falham até lá.'
            : 'Consultas que passam por esses blocos falham com ORA-01578. Com backup + archives é possível recuperar só os blocos, com o banco aberto.',
        evidence: [
            corr.length ? `${totalBlocks} bloco(s) em V$DATABASE_BLOCK_CORRUPTION: ${corr.slice(0, 5).map((c) => `arquivo ${c.fileNo} bloco ${c.block}${c.blocks > 1 ? `+${c.blocks - 1}` : ''} (${c.type})`).join('; ')}` : 'Ainda não validado pelo RMAN (só citado no alert log).',
            ...all.slice(0, 6).map((c) => `Arquivo ${c.fileNo}, bloco ${c.block}: ${segLabel(c)}${c.fromAlert ? ' — citado no alert log' : ''}`),
            alertGroup ? `ORA-01578 no alert log: ${alertGroup.count}x, último em ${alertGroup.last}.` : null,
        ],
        samples: alertGroup ? alertGroup.samples : [],
        lastSeen: alertGroup ? alertGroup.last : null,
        count: alertGroup ? alertGroup.count : null,
        playbooks,
        alsoHandles: ['ORA-01578'],
        files,
    });
}

// ---------------------------------------------------------------- membro de redo recém-adicionado
// Ao receber um membro novo, o grupo que estava em uso (ou ainda não arquivado) é
// arquivado em seguida com esse arquivo ainda vazio: o archiver registra ORA-00313/
// ORA-00312 para ELE e arquiva pelo membro original. É esperado e passa sozinho
// quando o grupo volta a ser o corrente — não é falha do banco.
const REDO_ERR_CODES = ['ORA-00312', 'ORA-00313', 'ORA-00321', 'ORA-00354', 'ORA-00353', 'ORA-00316', 'ORA-00327'];
const ADD_NOISE_WINDOW_MS = 2 * 3600000;

function memberAdds(s) {
    const out = [];
    for (const r of alertRecords(s)) for (const a of r.addedMembers || []) out.push({ ...a, epoch: r.epoch, time: r.time });
    return out;
}

function recordRedoGroup(r) {
    const l = (r.logs || [])[0];
    const g = (r.redoGroups || [])[0];
    return l ? l.group : g ? g.group : null;
}

function isAddNoise(s, r, adds = memberAdds(s)) {
    if (!r.epoch || !r.codes.some((c) => REDO_ERR_CODES.includes(c.code))) return false;
    const grp = recordRedoGroup(r);
    const paths = (r.logs || []).map((l) => sp.fileKey(l.path));
    return adds.some((a) => a.epoch && r.epoch >= a.epoch - 5000 && r.epoch - a.epoch <= ADD_NOISE_WINDOW_MS
        && (grp == null || grp === a.group)
        // Com caminho no erro, só vale se for o membro NOVO (erro no original é problema real).
        && (!paths.length || paths.every((p) => p === sp.fileKey(a.path))));
}

function ruleRedoAdded(b) {
    const s = b.s;
    const adds = memberAdds(s);
    if (!adds.length) return;
    const redoErrs = alertRecords(s).filter((r) => r.codes.some((c) => REDO_ERR_CODES.includes(c.code)));
    const noise = redoErrs.filter((r) => isAddNoise(s, r, adds));
    const memberNow = (path) => {
        for (const g of s.logs || []) for (const m of g.memberList) if (sp.fileKey(m.path) === sp.fileKey(path)) return m;
        return null;
    };
    // Membro novo ainda INVALID (o grupo não voltou a ser o corrente) e sem erro real sobre ele.
    const pending = adds.filter((a) => { const m = memberNow(a.path); return m && m.status === 'INVALID' && !isBadInAlert(s, a.path); });
    if (!noise.length) {
        if (!pending.length) return;
        b.add({
            id: 'redo-member-added', severity: 'low', status: 'active', code: null, category: 'redo',
            title: `Membro de redo novo aguardando o primeiro uso (grupo ${[...new Set(pending.map((a) => a.group))].join(', ')})`,
            detail: 'Um membro recém-adicionado fica INVALID até o grupo voltar a ser o corrente — é o comportamento normal do Oracle, não um defeito. Some sozinho nas próximas trocas de log.',
            evidence: pending.slice(0, 4).map((a) => `Adicionado em ${a.time}: grupo ${a.group} → ${a.path}`),
            actions: ['Nenhuma ação corretiva é necessária.', 'Para validar na hora: ALTER SYSTEM SWITCH LOGFILE; (uma vez por grupo).'],
            playbooks: [],
            logs: pending.map((a) => a.path),
        });
        return;
    }
    const onlyNoise = noise.length === redoErrs.length;
    const groups = [...new Set(noise.map(recordRedoGroup).filter((g) => g != null))].sort((a, c) => a - c);
    const added = adds.filter((a) => !groups.length || groups.includes(a.group));
    const last = noise[noise.length - 1];
    b.add({
        id: 'redo-member-added', severity: 'low', status: pending.length ? 'active' : 'historical',
        code: onlyNoise ? 'ORA-00313' : null, category: 'redo',
        title: `Aviso esperado após adicionar membro de redo${groups.length ? ` (grupo ${groups.join(', ')})` : ''}`,
        detail: 'Na primeira vez que o grupo foi arquivado depois de receber o membro novo, esse arquivo ainda não tinha sido gravado: o archiver registrou ORA-00313/ORA-00312 para ele e arquivou pelo membro original. Não houve perda de dados nem parada. '
            + (pending.length ? 'O membro novo fica INVALID até o grupo voltar a ser o corrente: some sozinho nas próximas trocas de log.' : 'O membro novo já está válido: nada a fazer.'),
        evidence: [
            ...added.slice(0, 4).map((a) => `Membro adicionado em ${a.time}: grupo ${a.group} → ${a.path}${memberNow(a.path) ? ` (status agora: ${memberNow(a.path).status || 'válido'})` : ''}`),
            `${noise.length} registro(s) de erro entre a inclusão e ${last.time}, todos sobre o membro novo.`,
        ],
        samples: noise.slice(-3).map((r) => ({ time: r.time, text: r.text })),
        lastSeen: last.time,
        actions: [
            'Nenhuma ação corretiva é necessária: NÃO recrie o membro nem limpe o grupo por causa deste aviso.',
            'Para confirmar: SELECT group#, member, status FROM v$logfile ORDER BY group#; — membros válidos aparecem com STATUS vazio.',
            'Para validar o membro novo na hora: ALTER SYSTEM SWITCH LOGFILE; (uma vez por grupo).',
        ],
        causes: ['Membro de redo adicionado a um grupo que estava em uso ou aguardando arquivamento.'],
        playbooks: [],
        alsoHandles: onlyNoise ? REDO_ERR_CODES : [],
        logs: pending.map((a) => a.path),
    });
}

function isBadInAlert(s, p) {
    const lo = lastOpenEpoch(s);
    const key = sp.fileKey(p);
    const adds = memberAdds(s);
    return alertRecords(s).some((r) => r.codes.some((c) => REDO_ERR_CODES.includes(c.code))
        && (r.logs || []).some((l) => sp.fileKey(l.path) === key)
        && !isAddNoise(s, r, adds)
        && (!lo || !r.epoch || r.epoch >= lo - 60000));
}

function ruleRedo(b) {
    const s = b.s;
    for (const g of s.logs || []) {
        // Membro recém-adicionado aguardando o primeiro uso já foi tratado (ruleRedoAdded): não é "inválido".
        const invalid = g.memberList.filter((m) => (m.status === 'INVALID' || isBadInAlert(s, m.path)) && !b.handledLogs.has(m.path));
        if (!invalid.length) continue;
        const valid = g.memberList.filter((m) => !invalid.includes(m));
        const related = invalid.flatMap((m) => groupsAbout(s, { logPath: m.path }));
        if (valid.length) {
            for (const m of invalid) {
                const rel = groupsAbout(s, { logPath: m.path });
                b.add({
                    id: `redo-member-${g.group}-${m.path}`, severity: 'medium', code: 'ORA-00313', category: 'redo',
                    title: `Membro de redo inválido no grupo ${g.group}`,
                    detail: 'O grupo continua funcionando pelo outro membro, mas perdeu a proteção da multiplexação: se o outro membro falhar, o banco para. Recrie o membro (sem impacto).',
                    evidence: [m.path, `Grupo ${g.group}: ${g.status}, ${g.memberList.length} membro(s), arquivado: ${g.archived}`, `Membro válido: ${valid.map((v) => v.path).join(', ')}`],
                    samples: samplesOf(rel),
                    lastSeen: rel[0] ? rel[0].last : null,
                    playbooks: [pb('redo-member', { member: `${g.group}|${m.path}` }, true)],
                    alsoHandles: ['ORA-00313', 'ORA-00321'],
                    logs: [m.path],
                });
            }
        } else if (['INACTIVE', 'UNUSED'].includes(g.status)) {
            b.add({
                id: `redo-group-${g.group}`, severity: 'high', code: 'ORA-00313', category: 'redo',
                title: `Grupo de redo ${g.group} sem membros válidos (inativo)`,
                detail: 'Quando o banco chegar nesse grupo na troca de log, ele vai parar. Como o grupo está inativo, dá para limpá-lo sem perder transações.',
                evidence: g.memberList.map((m) => m.path),
                samples: samplesOf(related),
                playbooks: [pb('redo-clear', { group: g.group }, true)],
                alsoHandles: ['ORA-00313', 'ORA-00321', 'ORA-00353', 'ORA-00354'],
                logs: g.memberList.map((m) => m.path),
            });
        } else if (s.state === 'OPEN') {
            b.add({
                id: `redo-group-${g.group}`, severity: 'critical', code: 'ORA-00313', category: 'redo',
                title: `Grupo de redo ${g.group} (${g.status}) sem membros válidos`,
                detail: 'O grupo em uso está inacessível. Force a troca de log e limpe o grupo; se a instância cair, será necessária recuperação incompleta.',
                evidence: g.memberList.map((m) => m.path),
                samples: samplesOf(related),
                playbooks: [pb('redo-clear', { group: g.group }, true)],
                alsoHandles: ['ORA-00313'],
                logs: g.memberList.map((m) => m.path),
            });
        }
    }
}

function ruleControlfile(b) {
    const s = b.s;
    const bad = (s.controlfiles || []).filter((c) => c.status === 'INVALID');
    if (!bad.length) return;
    b.add({
        id: 'controlfile-invalid', severity: 'high', code: 'ORA-00205', category: 'controlfile',
        title: 'Cópia de controlfile inválida',
        detail: 'Uma das cópias multiplexadas do controlfile está inválida: se a instância reiniciar, ela não monta (ORA-00205).',
        evidence: bad.map((c) => c.name),
        playbooks: [pb('controlfile-restore', { mode: 'copy' }, true)],
    });
}

function ruleFra(b) {
    const s = b.s;
    const fra = s.fra;
    const stuck = recentGroup(s, ['ORA-00257', 'ORA-19809', 'ORA-16038', 'ORA-16014', 'ORA-19804'], 2);
    const lc = lifecycle(s);
    const freedAfter = stuck && lc.lastArchiverOk && lc.lastArchiverOk.epoch > (stuck.lastEpoch || 0);
    const warn = recentGroup(s, ['ORA-19815'], 2);
    const destErr = (s.archiveDests || []).filter((d) => d.status === 'ERROR' || d.status === 'FULL');
    const p = fra ? fra.usedPct : null;
    let sev = null;
    if ((stuck && !freedAfter) || (p != null && p >= 95) || destErr.some((d) => /19809|0*257|16014|space|espa/i.test(d.error || '') || d.status === 'FULL')) sev = 'critical';
    else if (p != null && p >= 85) sev = 'high';
    else if ((p != null && p >= 75) || warn) sev = 'medium';
    if (!sev && !destErr.length) return;
    const critical = sev === 'critical';
    b.add({
        id: 'fra', severity: sev || 'high', code: stuck && !freedAfter ? 'ORA-00257' : (critical ? 'ORA-19809' : 'ORA-19815'), category: 'archive',
        title: critical ? (stuck && !freedAfter ? 'Archiver travado: FRA cheia' : 'FRA praticamente cheia — o banco vai parar') : `FRA com ${pct(p)} de uso`,
        detail: critical
            ? 'Sem espaço para arquivar o redo, o banco congela todas as transações quando os grupos de redo enchem (só SYSDBA conecta). Aumentar o limite libera na hora; a limpeza remove o que é seguro apagar.'
            : 'A Fast Recovery Area está enchendo. Libere espaço antes que o archiver trave e o banco pare.',
        evidence: [
            fra ? `FRA ${fra.dest}: ${pct(p)} usada (${Math.round((fra.usedMb - fra.reclaimableMb) / 1024)} de ${Math.round(fra.limitMb / 1024)} GB; ${Math.round(fra.reclaimableMb / 1024)} GB recicláveis).` : null,
            stuck ? `${stuck.code} no alert log: ${stuck.count}x, último em ${stuck.last}${freedAfter ? ' (archiver liberado depois)' : ''}.` : null,
            warn && !stuck ? `ORA-19815 (aviso de FRA) em ${warn.last}.` : null,
            ...destErr.map((d) => `Destino ${d.id} (${d.destination}): ${d.status}${d.error ? ` — ${d.error}` : ''}`),
        ],
        samples: stuck ? stuck.samples : (warn ? warn.samples : []),
        lastSeen: stuck ? stuck.last : (warn ? warn.last : null),
        playbooks: fra
            ? [pb('fra-free', { mode: 'grow' }, true, null, 'Aumentar o limite da FRA'), pb('fra-free', { mode: 'cleanup' }, false, null, 'Limpar a FRA (o que é seguro apagar)')]
            : [pb('fra-free', { mode: 'cleanup' }, true, null, 'Limpar archives e backups obsoletos')],
        alsoHandles: ['ORA-00257', 'ORA-19809', 'ORA-19815', 'ORA-16038', 'ORA-16014', 'ORA-19804', 'ORA-00255', 'ORA-00270'],
    });
}

function ruleTemp(b) {
    const s = b.s;
    if (s.state !== 'OPEN') return;
    const bad = badTempfiles(s);
    if (!(s.tempfiles || []).length) {
        b.add({
            id: 'temp-empty', severity: 'medium', code: 'ORA-01187', category: 'space',
            title: 'Nenhum tempfile na tablespace temporária',
            detail: 'Ordenações grandes falharão (ORA-25153). Comum após restore/clone: recrie o tempfile.',
            playbooks: [pb('temp-recreate', {}, true)],
        });
    } else if (bad.length) {
        b.add({
            id: 'temp-bad', severity: 'medium', code: 'ORA-01187', category: 'space',
            title: 'Tempfile com erro',
            detail: 'Um tempfile registrado não pode ser usado. Tempfiles não guardam dados: recriar não tem risco.',
            evidence: bad,
            playbooks: [pb('temp-recreate', {}, true)],
            alsoHandles: ['ORA-01187'],
        });
    }
}

function ruleInvalid(b) {
    const inv = b.s.invalid;
    if (!inv || !inv.total) return;
    b.add({
        id: 'invalid-objects', severity: inv.sys ? 'medium' : 'low', category: 'dictionary',
        title: `${inv.total} objeto(s) inválido(s)${inv.sys ? ` — ${inv.sys} em SYS/SYSTEM` : ''}`,
        detail: inv.sys
            ? 'Objetos do dicionário inválidos costumam aparecer após recuperação/patch e podem causar erros em funcionalidades do banco. Recompile com o utlrp.sql.'
            : 'Objetos de aplicação inválidos: o Oracle tenta recompilá-los no uso, mas falhas aparecem como ORA-04063/ORA-06508.',
        evidence: inv.byOwner.map((o) => `${o.owner}: ${o.count}`),
        playbooks: [pb('recompile-invalid', {}, true)],
    });
}

/** Erros do alert log que nenhuma regra específica tratou. */
function ruleAlert(b) {
    const s = b.s;
    const lo = lastOpenEpoch(s);
    const skip = new Set([...kb.COMPANIONS, ...kb.BENIGN_RECOVERY, 'ORA-00264', 'ORA-12012']);
    for (const g of alertGroups(s)) {
        if (skip.has(g.code)) continue;
        const isKcratr = g.code === 'ORA-00600' && /^kcratr_/i.test(g.arg || '');
        if (b.handledCodes.has(g.code) && !(g.code === 'ORA-00600' && !(b.handledKcratr && isKcratr))) continue;
        if (g.files.length && g.files.every((f) => b.handledFiles.has(f.fileNo))) continue;
        if (g.logs.length && g.logs.every((l) => b.handledLogs.has(l.path))) continue;
        const entry = kb.lookup(g.code, g.arg);
        if (!entry || entry.severity === 'info') continue;

        let severity = entry.severity;
        let status = 'active';
        let note = '';
        let playbooks = entry.playbooks.map((id) => {
            const params = {};
            if (['datafile-recover', 'datafile-restore'].includes(id) && g.files[0]) params.fileNo = g.files[0].fileNo;
            return pb(id, params);
        });
        const jobOnly = g.jobCount > 0 && g.jobCount === g.count;

        if (lo && g.lastEpoch && g.lastEpoch < lo && !['corruption', 'space'].includes(entry.category)) {
            // Anterior à última abertura e não se repetiu depois: já superado.
            status = 'historical';
            severity = DOWNGRADE[DOWNGRADE[severity]] || 'low';
            note = `Ocorreu antes da última abertura do banco (${lifecycle(s).lastOpen.time}) e não se repetiu depois — provavelmente já resolvido. `;
            playbooks = [];
        } else if (jobOnly) {
            severity = SEV_ORDER[severity] < SEV_ORDER.low ? 'low' : severity;
            note = 'Aconteceu dentro de um job agendado (ORA-12012): o impacto foi restrito ao job — o banco seguiu funcionando. ';
            playbooks = [];
        } else if (entry.correlate && s.state === 'OPEN') {
            // Sintoma (sessão caiu): com a instância aberta, a causa foi local à sessão ou já passou.
            severity = 'medium';
            note = 'A instância está aberta: a queda afetou sessões, não o banco. Veja o trace/alert no horário para a causa. ';
            playbooks = [];
        }
        b.add({
            id: `alert-${g.code}-${g.arg || ''}`, severity, status, code: g.code, arg: g.arg,
            title: `${g.code}${g.arg ? ` [${g.arg}]` : ''}: ${entry.title}${jobOnly ? ' (em job agendado)' : ''}`,
            detail: note + entry.meaning,
            evidence: [
                `${g.count} ocorrência(s) nos últimos ${s.alert.days} dia(s); última em ${g.last}${g.incidents.length ? ` · incidente(s) ${g.incidents.join(', ')}` : ''}.`,
                g.with.length ? `Registrado junto com: ${g.with.slice(0, 6).join(', ')}.` : null,
                ...g.files.slice(0, 3).map((f) => `Datafile ${f.fileNo}${f.path ? `: ${f.path}` : ''}`),
                ...g.logs.slice(0, 3).map((l) => `Redo grupo ${l.group}: ${l.path}`),
                ...g.controlfiles.slice(0, 3).map((c) => `Controlfile: ${c}`),
            ],
            samples: g.samples,
            lastSeen: g.last,
            count: g.count,
            playbooks,
        });
    }
}

// ==========================================================================
// Prontidão para recuperação
// ==========================================================================

function readiness(s) {
    const items = [];
    // action: procedimento que resolve o item (botão na tela).
    const add = (id, status, label, detail, weight = 1, action = null) => items.push({ id, status, label, detail, weight, ...(action ? { action } : {}) });
    const db = s.database;
    const now = Date.now();

    if (db) {
        add('archivelog', db.logMode === 'ARCHIVELOG' ? 'ok' : 'bad', 'Modo ARCHIVELOG',
            db.logMode === 'ARCHIVELOG' ? 'Recuperação até o último commit é possível.' : 'Sem archivelog só dá para voltar ao último backup: tudo o que veio depois é perdido. Ative na tela Backup.', 2);
        const b = s.backups || {};
        const dAge = ageDays(b.lastDb, now);
        add('backup', dAge == null ? 'bad' : dAge <= 1.5 ? 'ok' : dAge <= 7 ? 'warn' : 'bad', 'Backup recente dos datafiles',
            b.lastDb ? `Último backup que cobre todos os datafiles: ${b.lastDb} (${fmtAge(dAge)}).` : (b.newestAny ? `Há backups (${b.newestAny}), mas nem todos os datafiles atuais têm cópia.` : 'Nenhum backup registrado no controlfile.'), 2);
        if (db.logMode === 'ARCHIVELOG') {
            const aAge = ageDays(b.lastArch, now);
            add('archbackup', aAge == null ? 'warn' : aAge <= 1 ? 'ok' : aAge <= 3 ? 'warn' : 'bad', 'Backup dos archivelogs',
                b.lastArch ? `Último: ${b.lastArch} (${fmtAge(aAge)}).` : 'Nenhum backup de archivelog registrado.');
        }
        const auto = (s.rmanConfig || {})['CONTROLFILE AUTOBACKUP'];
        const ver = s.instance && s.instance.version ? parseFloat(s.instance.version) : null;
        const autoOn = auto ? /ON/i.test(auto) : (ver != null && ver >= 12.2);
        add('autobackup', autoOn ? 'ok' : 'warn', 'Autobackup do controlfile',
            auto ? `CONTROLFILE AUTOBACKUP ${auto}.` : (autoOn ? 'Padrão ON (12.2+).' : 'Desligado: perder o controlfile sem cópia fica muito mais difícil. RMAN: CONFIGURE CONTROLFILE AUTOBACKUP ON;'));
    }
    if ((s.logs || []).length) {
        const single = s.logs.filter((g) => g.memberList.length < 2);
        const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '').toUpperCase();
        const sameDir = s.logs.filter((g) => g.memberList.length >= 2 && new Set(g.memberList.map((m) => dirOf(m.path))).size < 2);
        add('redomux', single.length || sameDir.length ? 'warn' : 'ok', 'Redo logs multiplexados',
            single.length ? `${single.length} de ${s.logs.length} grupo(s) com um só membro: perder esse arquivo pode exigir recuperação incompleta.`
                : sameDir.length ? `${sameDir.length} grupo(s) com os membros no mesmo diretório (mesmo disco).` : `Todos os ${s.logs.length} grupos têm 2+ membros.`,
            1, single.length ? { id: 'redo-multiplex', label: 'Multiplexar agora' } : null);
    }
    const cfs = s.controlFileParam || [];
    if (cfs.length) {
        const dirs = new Set(cfs.map((c) => c.replace(/[\\/][^\\/]*$/, '').toUpperCase()));
        const cfWarn = cfs.length < 2 || dirs.size < 2;
        add('cfmux', cfWarn ? 'warn' : 'ok', 'Controlfile multiplexado',
            cfs.length < 2 ? 'Uma única cópia do controlfile.' : dirs.size < 2 ? `${cfs.length} cópias, mas no mesmo diretório (mesmo disco).` : `${cfs.length} cópias em diretórios diferentes.`,
            1, cfWarn ? { id: 'controlfile-multiplex', label: 'Criar cópia em outro disco' } : null);
    }
    if (s.fra) {
        const p = s.fra.usedPct;
        add('fra', p < 75 ? 'ok' : p < 90 ? 'warn' : 'bad', 'Espaço na FRA', `${pct(p)} usada de ${Math.round(s.fra.limitMb / 1024)} GB.`);
    } else if (db) {
        add('fra', 'warn', 'Fast Recovery Area', 'FRA não configurada (DB_RECOVERY_FILE_DEST vazio).', 0.5);
    }
    const ck = String((s.params || {}).db_block_checksum || '').toUpperCase();
    if (ck) add('checksum', ['TYPICAL', 'FULL', 'TRUE'].includes(ck) ? 'ok' : 'warn', 'Checksum de blocos', `DB_BLOCK_CHECKSUM = ${ck}${['TYPICAL', 'FULL', 'TRUE'].includes(ck) ? '' : ' — corrupções passam despercebidas. Use TYPICAL.'}`, 0.5);
    if (db) {
        add('corruption', (s.corruption || []).length ? 'bad' : 'ok', 'Sem blocos corrompidos conhecidos', (s.corruption || []).length ? `${s.corruption.length} registro(s) em V$DATABASE_BLOCK_CORRUPTION.` : 'Nenhum registro em V$DATABASE_BLOCK_CORRUPTION.');
        add('recoverfiles', (s.recoverFiles || []).length ? 'bad' : 'ok', 'Nenhum datafile precisando de recuperação', (s.recoverFiles || []).length ? `${s.recoverFiles.length} em V$RECOVER_FILE.` : 'V$RECOVER_FILE vazio.');
        const fbOn = db.flashbackOn === 'YES';
        const fbDetail = fbOn ? 'Ativo: dá para voltar o banco no tempo sem restore.'
            : s.edition && s.edition !== 'EE' ? 'Indisponível nesta edição (exclusivo da Enterprise Edition).'
                : 'Desligado (opcional): com ele, erros lógicos se desfazem em minutos.';
        add('flashback', fbOn ? 'ok' : 'info', 'Flashback Database', fbDetail, 0,
            !fbOn && (!s.edition || s.edition === 'EE') ? { id: 'flashback-on', label: 'Ativar' } : null);
    }
    if (s.protection && db && db.logMode === 'ARCHIVELOG') {
        const archOnly = s.protection.strategy === 'archivelog';
        add('scheduled', s.protection.scheduleInstalled && !archOnly ? 'ok' : 'warn', 'Backups agendados no servidor',
            !s.protection.scheduleInstalled ? 'Sem agendamento: configure em Backup → Proteção automática da FRA.'
                : archOnly ? 'Só archivelogs: o backup do banco precisa vir de outra ferramenta (sem ele os archives não restauram nada).'
                    : 'Instalados pelo painel (rodam mesmo com o painel desligado).');
        add('fraguard', s.protection.guardEnabled ? 'ok' : 'warn', 'Guardião da FRA',
            s.protection.guardEnabled ? 'Ativo: age antes de a FRA encher.' : 'Desligado: a FRA pode encher e parar o banco.', 0.5);
    }
    const snap = s.snapshot;
    add('dbid', snap && snap.dbid ? 'ok' : 'warn', 'DBID e controlfiles guardados pelo painel',
        snap && snap.dbid ? `DBID ${snap.dbid} registrado em ${String(snap.at || '').slice(0, 16).replace('T', ' ')}.` : 'Abra esta tela com o banco no ar: o painel guarda o DBID, necessário para restaurar o controlfile do autobackup.', 0.5);
    const cap = s.capabilities || {};
    add('automation', cap.automation && cap.passwordAuth ? 'ok' : 'warn', 'Execução automática pelo painel',
        cap.automation ? (cap.passwordAuth ? 'sqlplus/RMAN como SYSDBA configurados.' : 'Sem DB_SYS_PASSWORD: usa autenticação por SO (exige usuário no grupo dba).') : 'Configure DB_ORACLE_HOME, DB_ORACLE_SID e DB_SYS_PASSWORD para o painel executar os procedimentos.', 0.5);

    // Sem o controlfile montado não dá para avaliar archivelog, backups e redo: nada de nota parcial.
    if (!db) {
        return { score: null, grade: 'Indisponível', items, note: 'Com o banco fora do ar só parte da prontidão pode ser avaliada: a nota volta quando o banco estiver montado.' };
    }
    const counted = items.filter((i) => i.weight > 0 && i.status !== 'info');
    const total = counted.reduce((a, i) => a + i.weight, 0);
    const got = counted.reduce((a, i) => a + i.weight * (i.status === 'ok' ? 1 : i.status === 'warn' ? 0.5 : 0), 0);
    const score = total ? Math.round((got / total) * 100) : null;
    return { score, grade: score == null ? '—' : score >= 85 ? 'Boa' : score >= 60 ? 'Regular' : 'Fraca', items };
}

// ==========================================================================
// Laudo
// ==========================================================================

function evaluate(s) {
    const b = new Builder(s);
    ruleState(b);
    ruleDatafiles(b);
    ruleCorruption(b);
    ruleRedoAdded(b);
    ruleRedo(b);
    ruleControlfile(b);
    ruleFra(b);
    ruleTemp(b);
    ruleInvalid(b);
    ruleAlert(b);

    const findings = b.items.sort((a, c) => (a.status === c.status ? 0 : a.status === 'active' ? -1 : 1) || SEV_ORDER[a.severity] - SEV_ORDER[c.severity]);
    const active = findings.filter((f) => f.status === 'active');
    const count = (sev) => active.filter((f) => f.severity === sev).length;
    const overall = count('critical') ? 'critical' : count('high') ? 'warning' : count('medium') ? 'attention' : 'ok';
    const top = active.find((f) => f.playbooks.some((p) => p.recommended)) || null;
    return {
        overall,
        counts: { critical: count('critical'), high: count('high'), medium: count('medium'), low: count('low'), historical: findings.length - active.length },
        findings,
        readiness: readiness(s),
        recommended: top ? { findingId: top.id, ...top.playbooks.find((p) => p.recommended) } : null,
    };
}

/** Consulta de um erro colado pelo usuário, cruzada com o diagnóstico atual. */
function lookupText(text, s, report) {
    const items = kb.analyzeText(text);
    return items.map((it) => {
        const entry = it.entry;
        const related = [];
        if (report && entry) {
            for (const f of report.findings.filter((x) => x.status === 'active')) {
                const shares = (f.playbooks || []).some((p) => (entry.playbooks || []).includes(p.id)) || f.code === it.code;
                if (shares || (entry.correlate && ['critical', 'high'].includes(f.severity))) related.push({ id: f.id, title: f.title, severity: f.severity });
            }
        }
        return {
            code: it.code, arg: it.arg, known: it.known,
            entry: entry ? { ...entry, playbooks: (entry.playbooks || []).map((id) => ({ id, applicable: applicable(id, s ? s.state : 'UNKNOWN') })) } : null,
            related,
        };
    });
}

module.exports = { evaluate, readiness, lookupText, applicable, SEV_ORDER };

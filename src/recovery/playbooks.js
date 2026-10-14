/**
 * PLAYBOOKS.JS - Procedimentos de recuperação: catálogo + montagem do plano.
 *
 * Um plano é uma lista de PASSOS. Cada passo roda por um canal:
 *   sql      conexão do painel (banco ABERTO; não precisa de acesso ao SO)
 *   sqlplus  sqlplus como SYSDBA no servidor (qualquer estado da instância)
 *   rman     RMAN no servidor (comandos dentro de RUN { } param no 1º erro)
 *   os       PowerShell no servidor Windows (ex.: iniciar OracleService<SID>)
 *   lsnrctl  utilitário do listener
 *   mkdir    cria uma pasta no servidor (Windows: PowerShell; Linux: como o dono do Oracle)
 * Passos que dependem do estado da instância trazem "variants" (o que fazer se
 * ela estiver parada, em NOMOUNT, montada ou aberta). O executor consulta o
 * estado imediatamente antes do passo e usa a variante certa.
 *
 * Segurança:
 *  - nenhum texto livre do usuário vira SQL: números são validados, caminhos e
 *    nomes vêm do próprio dicionário/diagnóstico (ou passam por validação
 *    estrita) e identificadores são citados;
 *  - o plano tem um hash: a execução remonta o plano com o estado ATUAL e só
 *    prossegue se for idêntico ao que o DBA revisou.
 */
const crypto = require('crypto');
const { config } = require('../config');
const sp = require('../storagePaths');
const storage = require('../storage');

class PlanError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

const STATE_LABEL = {
    OPEN: 'aberta (OPEN)', MOUNTED: 'montada (MOUNT)', STARTED: 'em NOMOUNT', DOWN: 'parada', UNKNOWN: 'em estado desconhecido',
};
const CHANNEL_LABEL = { sql: 'SQL (conexão do painel)', sqlplus: 'sqlplus / as sysdba', rman: 'RMAN', os: 'PowerShell no servidor', lsnrctl: 'lsnrctl', mkdir: 'Pasta no servidor' };
const RISK_LABEL = { low: 'Baixo risco', medium: 'Risco moderado', high: 'Alto risco' };

// ==========================================================================
// Helpers de validação
// ==========================================================================

/** Caminho de arquivo vindo do dicionário, seguro para literal SQL. */
function lit(p) {
    const s = String(p == null ? '' : p);
    if (!s || /['\r\n\x00]/.test(s)) throw new PlanError(`Caminho inválido para uso em SQL: ${s.slice(0, 120)}`);
    return `'${s}'`;
}

/** Identificador Oracle padrão (maiúsculas), citado. */
function ident(name, label = 'nome') {
    const s = String(name == null ? '' : name).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_$#]{0,127}$/.test(s)) throw new PlanError(`${label} inválido: "${String(name).slice(0, 60)}".`);
    return `"${s}"`;
}

function intParam(v, label, min, max) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new PlanError(`${label} inválido (esperado inteiro entre ${min} e ${max}).`);
    return n;
}

const bool = (v, def) => (v === undefined || v === null || v === '' ? def : v === true || v === 'true' || v === 'on' || v === 1 || v === '1');

function sidOk(sid) {
    return typeof sid === 'string' && /^[A-Za-z][A-Za-z0-9_$#]{0,29}$/.test(sid);
}

function newestFile(list) {
    return list.slice().sort((a, b) => (b.fileNo || 0) - (a.fileNo || 0))[0] || null;
}

/** Diretório de destino e nome para um arquivo novo ao lado de `ref` (ASM → só o disk group). */
function siblingPath(ref, ts, s) {
    if (!ref) throw new PlanError('Não há arquivo de referência para escolher o diretório.');
    if (sp.pathStyle(ref) === 'asm') return { path: sp.asmDiskGroup(ref), omf: true };
    const dir = sp.normalizeDir(sp.dirOf(ref));
    const keys = new Set([...(s.datafiles || []), ...(s.tempfiles || [])].map((f) => sp.fileKey(f.name)));
    const name = sp.suggestNextFileName(ref, ts, dir, keys);
    return { path: dir + name, omf: false };
}

/**
 * "Raiz de volume" de um caminho, sem consultar o SO: letra de unidade (Windows),
 * primeiro diretório (Linux: /u01, /u02... costumam ser montagens distintas) ou
 * disk group (ASM). Heurística para sugerir uma cópia em OUTRO disco.
 */
function volumeRoot(p) {
    const s = String(p || '');
    const st = sp.pathStyle(s);
    if (st === 'windows') return s.slice(0, 2).toUpperCase();
    if (st === 'asm') return sp.asmDiskGroup(s);
    if (st === 'posix') return `/${s.split('/').filter(Boolean)[0] || ''}`;
    return null;
}

/**
 * Diretório sugerido para multiplexar `existing` (redo/controlfile): primeiro um
 * diretório de datafiles/tempfiles em outro volume, depois a FRA (o DBCA põe ali a
 * 2ª cópia do controlfile), por fim uma subpasta ao lado dos arquivos atuais.
 */
function suggestMirrorDir(s, existing, { sub, allowAsm = false } = {}) {
    const roots = new Set(existing.map(volumeRoot));
    const dbName = String((s.database && s.database.name) || (s.params || {}).db_name || '').toUpperCase();
    const style = sp.pathStyle(existing[0]);
    const sep = style === 'windows' ? '\\' : '/';
    const cands = [];
    for (const f of [...(s.datafiles || []), ...(s.tempfiles || [])]) cands.push(sp.dirOf(f.name));
    const fra = (s.params || {}).db_recovery_file_dest || (s.fra && s.fra.dest) || '';
    if (fra && sp.pathStyle(fra) === 'asm') { if (allowAsm) cands.push(sp.asmDiskGroup(fra)); } else if (fra && dbName) cands.push(sp.normalizeDir(fra) + dbName + sep);
    for (const c of cands) {
        const st = sp.pathStyle(c);
        if (!c || (st === 'asm' && !allowAsm) || (st !== 'asm' && st !== style)) continue;
        if (!roots.has(volumeRoot(c))) return { dir: st === 'asm' ? sp.asmDiskGroup(c) : sp.normalizeDir(c), otherVolume: true };
    }
    if (style === 'asm') return { dir: sp.asmDiskGroup(existing[0]), otherVolume: false };
    // Mesmo disco: em diretório próprio (protege contra perda/corrupção do arquivo).
    if (fra && sp.pathStyle(fra) === style && dbName) return { dir: sp.normalizeDir(fra) + dbName + sep, otherVolume: false };
    return { dir: sp.normalizeDir(sp.dirOf(existing[0]) + sub), otherVolume: false };
}

/** Diretório informado pelo DBA: absoluto, no estilo do SO do banco (ou disk group ASM, se permitido). */
function mirrorDirParam(raw, refPath, { allowAsm = false } = {}) {
    const style = sp.pathStyle(refPath) === 'asm' ? null : (sp.pathStyle(refPath) === 'windows' ? 'windows' : 'posix');
    let dir;
    try {
        dir = sp.validateCustomDir(raw, style || 'asm');
    } catch (err) {
        throw new PlanError(err.message);
    }
    if (sp.pathStyle(dir) === 'asm') {
        if (!allowAsm) throw new PlanError('Informe um diretório do sistema de arquivos (ASM não é suportado neste procedimento).');
        return sp.asmDiskGroup(dir);
    }
    if (/\$/.test(dir)) throw new PlanError('O diretório não pode conter "$".');
    return dir;
}

/** Passo que cria a pasta no servidor (Windows: PowerShell; Linux: como o dono do Oracle). */
function mkdirStep(id, dir, serverOs) {
    const d = String(dir).replace(/[\\/]$/, '');
    const shown = serverOs === 'windows' || sp.pathStyle(d) === 'windows'
        ? `New-Item -ItemType Directory -Force -Path '${d}'`
        : `mkdir -p '${d}'   # como o dono do Oracle`;
    return { id, title: `Criar a pasta ${d} (se não existir)`, channel: 'mkdir', dir: d, lines: [shown] };
}

/** Próximo nome livre a partir de `base` (REDO01.LOG → REDO01B.LOG; CONTROL02.CTL → CONTROL03.CTL). */
function nextFreeName(dir, candidates, taken) {
    for (const name of candidates) if (!taken.has(sp.fileKey(dir + name))) return name;
    throw new PlanError('Não foi possível escolher um nome livre para o novo arquivo.');
}

const versionAtLeast = (v, major, minor = 0) => {
    const [a, b] = String(v || '').split('.').map(Number);
    return Number.isFinite(a) && (a > major || (a === major && (b || 0) >= minor));
};

// ==========================================================================
// Construtores de passo
// ==========================================================================

const step = (channel) => (id, title, body, extra = {}) => (
    channel === 'sql' ? { id, title, channel, statements: body, ...extra } : { id, title, channel, lines: body, ...extra }
);
const sqlplusStep = step('sqlplus');
const rmanStep = step('rman');
const sqlStep = step('sql');
const osStep = step('os');

const MOUNT_VARIANTS = (fromOpen) => ({
    DOWN: ['STARTUP MOUNT;'],
    STARTED: ['ALTER DATABASE MOUNT;'],
    MOUNTED: [],
    ...(fromOpen ? { OPEN: ['SHUTDOWN ABORT;', 'STARTUP MOUNT;'] } : {}),
});
// Sem variante para OPEN de propósito: nunca derrubar um banco aberto para isto.
const NOMOUNT_VARIANTS = () => ({
    DOWN: ['STARTUP NOMOUNT;'],
    STARTED: [],
    MOUNTED: ['SHUTDOWN ABORT;', 'STARTUP NOMOUNT;'],
});
const OPEN_VARIANTS = () => ({
    DOWN: ['STARTUP;'],
    STARTED: ['ALTER DATABASE MOUNT;', 'ALTER DATABASE OPEN;'],
    MOUNTED: ['ALTER DATABASE OPEN;'],
    OPEN: [],
});

/** sql (banco aberto e conexão ok) ou sqlplus (demais casos). */
function sqlChannel(ctx) {
    return ctx.state === 'OPEN' && ctx.s.connection && ctx.s.connection.ok ? 'sql' : 'sqlplus';
}

/** Passo SQL que roda pela conexão (statements) ou pelo sqlplus (linhas com ;). */
function flexStep(ctx, id, title, sqls, extra = {}) {
    if (sqlChannel(ctx) === 'sql') return sqlStep(id, title, sqls.map((sql) => ({ sql, plsql: /^\s*(BEGIN|DECLARE)\b/i.test(sql) })), extra);
    return sqlplusStep(id, title, sqls.map((sql) => (/^\s*(BEGIN|DECLARE)\b/i.test(sql) ? `${sql}\n/` : `${sql};`)), extra);
}

/** PL/SQL: troca de log até o grupo deixar de ser o corrente e faz checkpoint (grupo fica INACTIVE). */
function leaveGroupSql(group) {
    const g = Number(group);
    return `DECLARE s VARCHAR2(16); BEGIN FOR i IN 1..6 LOOP SELECT status INTO s FROM v$log WHERE group# = ${g}; EXIT WHEN s <> 'CURRENT'; EXECUTE IMMEDIATE 'ALTER SYSTEM SWITCH LOGFILE'; END LOOP; EXECUTE IMMEDIATE 'ALTER SYSTEM CHECKPOINT'; END;`;
}

/**
 * PL/SQL: deixa o grupo INATIVO e (em ARCHIVELOG) ARQUIVADO e só então executa os
 * comandos nos membros. Assim o archiver nunca lê um membro recém-criado/vazio —
 * mexer num grupo em uso ou ainda não arquivado gera ORA-00313/ORA-00312 no alert
 * log (o archiver usa o outro membro, mas o aviso assusta em produção).
 * Espera até 2 min; se o grupo não ficar pronto, nada é alterado (ORA-20001).
 */
function idleGroupSql(group, { archivelog, version }, statements) {
    const g = Number(group);
    const sleep = versionAtLeast(version, 18) ? 'DBMS_SESSION.SLEEP(1)' : 'DBMS_LOCK.SLEEP(1)';
    const ready = archivelog ? "(s = 'UNUSED' OR (s = 'INACTIVE' AND a = 'YES'))" : "s IN ('INACTIVE', 'UNUSED')";
    const exec = statements.map((st) => `EXECUTE IMMEDIATE '${st.replace(/'/g, "''")}';`).join(' ');
    return 'DECLARE s VARCHAR2(16); a VARCHAR2(3); BEGIN '
        + `FOR i IN 1..6 LOOP SELECT status INTO s FROM v$log WHERE group# = ${g}; EXIT WHEN s <> 'CURRENT'; EXECUTE IMMEDIATE 'ALTER SYSTEM SWITCH LOGFILE'; END LOOP; `
        + "EXECUTE IMMEDIATE 'ALTER SYSTEM CHECKPOINT'; "
        + `FOR i IN 1..120 LOOP SELECT status, archived INTO s, a FROM v$log WHERE group# = ${g}; EXIT WHEN ${ready}; ${sleep}; END LOOP; `
        + `IF NOT ${ready} THEN RAISE_APPLICATION_ERROR(-20001, 'O grupo ${g} nao ficou inativo${archivelog ? ' e arquivado' : ''} em 2 min (status ' || s || ', arquivado ' || a || '): nada foi alterado.'); END IF; `
        + `${exec} END;`;
}

function backupStep(id = 'backup') {
    return rmanStep(id, 'Backup completo do banco + archivelogs', ['BACKUP DATABASE PLUS ARCHIVELOG;'], {
        note: 'Obrigatório depois de RESETLOGS/limpeza de redo: os backups antigos não cobrem a nova sequência de logs. Pode levar bastante tempo.',
    });
}

// ==========================================================================
// Pré-condições comuns
// ==========================================================================

function requireAutomation(ctx, out) {
    const ok = ctx.automation;
    out.preconditions.push({
        ok,
        label: 'Execução no servidor configurada (sqlplus/RMAN como SYSDBA)',
        detail: ok
            ? (config.oracleServer.usesPasswordAuth ? 'DB_ORACLE_HOME, DB_ORACLE_SID e DB_SYS_PASSWORD definidos.' : 'Autenticação por SO (sem DB_SYS_PASSWORD).')
            : 'Defina DB_ORACLE_HOME, DB_ORACLE_SID e DB_SYS_PASSWORD no .env (e SSH_* se o banco for Linux remoto). Sem isso, copie os comandos e rode manualmente.',
    });
    if (!ok) out.manualOnly = true;
}

function requireStates(ctx, out, allowed, hint) {
    if (ctx.state === 'UNKNOWN') {
        out.warnings.push('O estado da instância não pôde ser lido; ele será verificado antes de cada passo.');
        return;
    }
    const ok = allowed.includes(ctx.state);
    out.preconditions.push({ ok, label: `Instância ${allowed.map((st) => STATE_LABEL[st]).join(' ou ')}`, detail: `Agora: ${STATE_LABEL[ctx.state]}.` });
    if (!ok) out.blockers.push(hint || `Este procedimento não se aplica com a instância ${STATE_LABEL[ctx.state]}.`);
}

function requireArchivelog(ctx, out, why) {
    const mode = ctx.s.database && ctx.s.database.logMode;
    if (!mode) return;
    const ok = mode === 'ARCHIVELOG';
    out.preconditions.push({ ok, label: 'Banco em ARCHIVELOG', detail: ok ? 'Archivelog ativo.' : 'Banco em NOARCHIVELOG.' });
    if (!ok) out.blockers.push(why || 'Exige ARCHIVELOG: sem os archives não há redo para recuperar o arquivo.');
}

function backupPrecondition(ctx, out, fileNo) {
    const b = ctx.s.backups || {};
    const when = fileNo ? (b.byFile || {})[fileNo] : b.lastDb || b.newestAny;
    out.preconditions.push({
        ok: when ? true : null,
        label: fileNo ? `Backup do datafile ${fileNo}` : 'Backup do banco',
        detail: when ? `Último: ${when}.` : 'Não encontrado no controlfile — o primeiro passo (validação) confirma antes de alterar qualquer coisa.',
    });
}

// ==========================================================================
// Catálogo
// ==========================================================================

function datafileOptions(s, prefer) {
    const rec = new Map((s.recoverFiles || []).map((r) => [r.fileNo, r]));
    const list = (s.datafiles || []).map((d) => {
        const r = rec.get(d.fileNo);
        const flags = [r ? `precisa de recuperação${r.error ? ` (${r.error})` : ''}` : null, d.status && !['ONLINE', 'SYSTEM'].includes(d.status) ? d.status : null, d.hdrError || null].filter(Boolean);
        return { value: d.fileNo, label: `#${d.fileNo} ${d.ts} — ${d.name}${flags.length ? ` · ${flags.join(' · ')}` : ''}`, flagged: flags.length > 0 };
    });
    list.sort((a, b) => (b.flagged - a.flagged) || (a.value - b.value));
    const def = prefer && list.some((o) => o.value === prefer) ? prefer : (list[0] ? list[0].value : null);
    return { options: list.map(({ value, label }) => ({ value, label })), def };
}

function findDatafile(s, fileNo) {
    const d = (s.datafiles || []).find((x) => x.fileNo === fileNo);
    if (!d) throw new PlanError(`Datafile ${fileNo} não existe neste banco.`);
    return d;
}

const isSystemTs = (ts) => ['SYSTEM'].includes(String(ts || '').toUpperCase());
const isUndoTs = (s, ts) => String(ts || '').toUpperCase() === String((s.params || {}).undo_tablespace || '').toUpperCase();

const CATALOG = {
    // ---------------------------------------------------------------- instância
    startup: {
        title: 'Iniciar / abrir o banco',
        summary: 'Sobe a instância e abre o banco, ou conclui a abertura se ela parou em NOMOUNT/MOUNT.',
        when: 'ORA-01034/ORA-27101 (instância parada), ORA-01033, ORA-01507, ORA-01109.',
        category: 'instance', risk: 'low', downtime: false, dataLoss: false, confirm: 'simple',
        states: ['DOWN', 'STARTED', 'MOUNTED'],
        schema: () => [],
        build(ctx, out) {
            requireAutomation(ctx, out);
            requireStates(ctx, out, ['DOWN', 'STARTED', 'MOUNTED'], 'O banco já está aberto.');
            if (ctx.serverOs === 'windows' && sidOk(ctx.sid)) {
                out.steps.push(osStep('service', `Garantir o serviço OracleService${ctx.sid} em execução`, [
                    "$ErrorActionPreference = 'Stop'",
                    `$n = 'OracleService${ctx.sid}'`,
                    '$s = Get-Service -Name $n',
                    "if ($s.Status -ne 'Running') { Start-Service -Name $n; Start-Sleep -Seconds 8; Write-Output ('Servico ' + $n + ' iniciado.') } else { Write-Output ('Servico ' + $n + ' ja estava em execucao.') }",
                ], { note: 'No Windows a instância só existe com o serviço no ar (ele pode abrir o banco sozinho).' }));
            }
            out.steps.push(sqlplusStep('open', 'Abrir o banco', ["SELECT 'Estado: '||status AS estado FROM v$instance;"], {
                variants: OPEN_VARIANTS(), restartsInstance: true,
                note: 'Se a abertura falhar, o erro devolvido é analisado e o painel indica o procedimento seguinte.',
            }));
        },
    },

    'listener-start': {
        title: 'Iniciar o listener',
        summary: 'Executa "lsnrctl start" no servidor.',
        when: 'ORA-12541 (no listener), ORA-12560 em conexões pelo alias.',
        category: 'connectivity', risk: 'low', downtime: false, dataLoss: false, confirm: 'simple',
        states: ['OPEN', 'MOUNTED', 'STARTED', 'DOWN'],
        schema: () => [],
        build(ctx, out) {
            requireAutomation(ctx, out);
            out.steps.push({ id: 'lsnr', title: 'Iniciar o listener', channel: 'lsnrctl', args: 'start', benign: ['TNS-01106'], lines: ['lsnrctl start'] });
        },
    },

    'unlock-account': {
        title: 'Desbloquear a conta do painel',
        summary: 'ALTER USER ... ACCOUNT UNLOCK como SYSDBA (a conta do painel não consegue se desbloquear).',
        when: 'ORA-28000 na conexão do painel.',
        category: 'connectivity', risk: 'low', downtime: false, dataLoss: false, confirm: 'simple',
        states: ['OPEN'],
        schema: (ctx) => [{ name: 'user', label: 'Usuário', type: 'text', value: (ctx.p.user || config.db.user || '').toUpperCase(), hint: 'Padrão: o usuário do painel (DB_USER).' }],
        build(ctx, out) {
            requireAutomation(ctx, out);
            requireStates(ctx, out, ['OPEN']);
            const u = ident(ctx.p.user || config.db.user, 'Usuário');
            out.steps.push(sqlplusStep('unlock', `Desbloquear ${u}`, [`ALTER USER ${u} ACCOUNT UNLOCK;`]));
            out.warnings.push('Corrija a aplicação que tentou a senha errada, senão a conta volta a ser bloqueada.');
        },
    },

    'flush-shared-pool': {
        title: 'Liberar o shared pool',
        summary: 'ALTER SYSTEM FLUSH SHARED_POOL — alívio imediato para ORA-04031 (os SQLs serão reanalisados).',
        when: 'ORA-04031 (unable to allocate shared memory).',
        category: 'memory', risk: 'low', downtime: false, dataLoss: false, confirm: 'simple',
        states: ['OPEN'],
        schema: () => [],
        build(ctx, out) {
            requireStates(ctx, out, ['OPEN']);
            out.steps.push(flexStep(ctx, 'flush', 'Liberar o shared pool', ['ALTER SYSTEM FLUSH SHARED_POOL']));
            out.warnings.push('Alívio temporário: por alguns minutos o banco reanalisa os SQLs (mais CPU). A solução definitiva é dimensionar a SGA (tela Memória) e usar bind variables.');
        },
    },

    // ---------------------------------------------------------------- recuperação de instância/mídia
    'crash-recovery': {
        title: 'Recuperar após queda (RECOVER DATABASE)',
        summary: 'Monta o banco, aplica todo o redo disponível (archives e logs online) e abre. Recuperação COMPLETA: sem perda de dados.',
        when: 'Banco não abre após queda de energia/abort: ORA-00600 [kcratr_scan_lastbwr], ORA-01113 em vários arquivos, ORA-01033 persistente.',
        category: 'media', risk: 'medium', downtime: true, dataLoss: false, confirm: 'ack',
        states: ['DOWN', 'STARTED', 'MOUNTED'],
        schema: () => [],
        build(ctx, out) {
            requireAutomation(ctx, out);
            requireStates(ctx, out, ['DOWN', 'STARTED', 'MOUNTED'], 'O banco está aberto: a recuperação de instância já foi feita. Para um arquivo específico use "Recuperar datafile".');
            const lostCurrent = (ctx.s.logs || []).find((g) => ['CURRENT', 'ACTIVE'].includes(g.status) && g.memberList.length && g.memberList.every((m) => m.status === 'INVALID'));
            if (lostCurrent) out.blockers.push(`O grupo de redo ${lostCurrent.group} (${lostCurrent.status}) está inacessível: a recuperação completa não terá o redo dele. Use "Recuperação incompleta".`);
            out.steps.push(rmanStep('recover', 'Montar, aplicar o redo e abrir', ['RECOVER DATABASE;', 'ALTER DATABASE OPEN;'], {
                variants: MOUNT_VARIANTS(false), restartsInstance: true,
                note: 'O RMAN localiza sozinho os archives necessários (FRA/destinos de archive) e os logs online.',
            }));
        },
    },

    'datafile-recover': {
        title: 'Recuperar datafile',
        summary: 'Aplica o redo a um datafile atrasado/offline e o coloca online. Com o banco aberto, só a tablespace dele fica indisponível durante o processo.',
        when: 'ORA-01113, ORA-00376, datafile OFFLINE ou listado em V$RECOVER_FILE.',
        category: 'media', risk: 'low', downtime: false, dataLoss: false, confirm: 'ack',
        states: ['OPEN', 'MOUNTED'],
        schema(ctx) {
            const prefer = (ctx.s.recoverFiles || [])[0] ? ctx.s.recoverFiles[0].fileNo : null;
            const { options, def } = datafileOptions(ctx.s, prefer);
            const fields = [{ name: 'fileNo', label: 'Datafile', type: 'select', options, value: ctx.p.fileNo != null ? Number(ctx.p.fileNo) : def }];
            if (ctx.state === 'MOUNTED') fields.push({ name: 'openAfter', label: 'Abrir o banco ao final', type: 'checkbox', value: bool(ctx.p.openAfter, (ctx.s.recoverFiles || []).length <= 1) });
            return fields;
        },
        build(ctx, out) {
            requireStates(ctx, out, ['OPEN', 'MOUNTED']);
            const n = intParam(ctx.p.fileNo, 'Datafile', 1, 65533);
            const d = findDatafile(ctx.s, n);
            const isOnline = ['ONLINE', 'SYSTEM'].includes(d.status);
            if (ctx.state === 'OPEN') {
                if (isSystemTs(d.ts) || (isUndoTs(ctx.s, d.ts) && isOnline)) {
                    out.blockers.push(`O datafile ${n} é da tablespace ${d.ts}: não pode ficar offline com o banco aberto. Use "Recuperar após queda" com o banco montado.`);
                }
                if (isOnline && ctx.s.database && ctx.s.database.logMode !== 'ARCHIVELOG') {
                    out.blockers.push('Banco em NOARCHIVELOG: não é possível colocar o datafile offline com o banco aberto (ORA-01145). Monte o banco e use "Recuperar após queda".');
                }
                if (ctx.automation) {
                    const lines = [];
                    if (isOnline) lines.push(`SQL 'ALTER DATABASE DATAFILE ${n} OFFLINE';`);
                    lines.push(`RECOVER DATAFILE ${n};`, `SQL 'ALTER DATABASE DATAFILE ${n} ONLINE';`);
                    out.steps.push(rmanStep('recover', `Recuperar o datafile ${n} e colocá-lo online`, lines));
                } else {
                    const sqls = [];
                    if (isOnline) sqls.push(`ALTER DATABASE DATAFILE ${n} OFFLINE`);
                    sqls.push(`ALTER DATABASE RECOVER AUTOMATIC DATAFILE ${n}`, `ALTER DATABASE DATAFILE ${n} ONLINE`);
                    out.steps.push(sqlStep('recover', `Recuperar o datafile ${n} e colocá-lo online`, sqls.map((sql) => ({ sql }))));
                    out.preconditions.push({ ok: true, label: 'Execução pela conexão do painel', detail: 'Sem acesso ao SO: usa ALTER DATABASE RECOVER pela própria conexão (exige privilégio ALTER DATABASE).' });
                }
            } else {
                requireAutomation(ctx, out);
                out.steps.push(rmanStep('recover', `Recuperar o datafile ${n}`, [`RECOVER DATAFILE ${n};`, `SQL 'ALTER DATABASE DATAFILE ${n} ONLINE';`]));
                if (bool(ctx.p.openAfter, true)) out.steps.push(sqlplusStep('open', 'Abrir o banco', ['ALTER DATABASE OPEN;'], { restartsInstance: true }));
            }
            if (d.hdrError && /NOT FOUND|CANNOT OPEN|WRONG FILE|FILE MISSING/i.test(d.hdrError)) {
                out.warnings.push(`O cabeçalho do arquivo indica "${d.hdrError}": se o arquivo não existe mais, use "Restaurar datafile do backup".`);
            }
        },
    },

    'datafile-restore': {
        title: 'Restaurar datafile do backup',
        summary: 'Valida o backup, restaura o datafile, aplica o redo até agora e o coloca online. Sem perda de dados (ARCHIVELOG).',
        when: 'Arquivo apagado/perdido (ORA-01157, ORA-01116, ORA-27041), truncado (ORA-01200) ou corrompido demais.',
        category: 'media', risk: 'medium', downtime: false, dataLoss: false, confirm: 'ack',
        states: ['OPEN', 'MOUNTED'],
        schema(ctx) {
            const missing = (ctx.s.recoverFiles || []).find((r) => /NOT FOUND|CANNOT OPEN|MISSING/i.test(r.error || ''));
            const { options, def } = datafileOptions(ctx.s, missing ? missing.fileNo : (ctx.p.fileNo != null ? Number(ctx.p.fileNo) : null));
            const fields = [{ name: 'fileNo', label: 'Datafile', type: 'select', options, value: ctx.p.fileNo != null ? Number(ctx.p.fileNo) : def }];
            if (ctx.state === 'MOUNTED') fields.push({ name: 'openAfter', label: 'Abrir o banco ao final', type: 'checkbox', value: bool(ctx.p.openAfter, true) });
            return fields;
        },
        build(ctx, out) {
            requireAutomation(ctx, out);
            requireStates(ctx, out, ['OPEN', 'MOUNTED']);
            requireArchivelog(ctx, out, 'Exige ARCHIVELOG: em NOARCHIVELOG só é possível restaurar o banco inteiro do último backup (procedimento manual).');
            const n = intParam(ctx.p.fileNo, 'Datafile', 1, 65533);
            const d = findDatafile(ctx.s, n);
            backupPrecondition(ctx, out, n);
            if (ctx.state === 'OPEN' && (isSystemTs(d.ts) || isUndoTs(ctx.s, d.ts))) {
                out.blockers.push(`O datafile ${n} é da tablespace ${d.ts}: restaure com o banco montado (desligue o banco e use este procedimento em MOUNT, ou "Restaurar o banco").`);
            }
            out.steps.push(rmanStep('validate', `Validar o backup do datafile ${n} (não altera nada)`, [`RESTORE DATAFILE ${n} VALIDATE;`]));
            const lines = [];
            if (ctx.state === 'OPEN' && ['ONLINE', 'SYSTEM'].includes(d.status)) lines.push(`SQL 'ALTER DATABASE DATAFILE ${n} OFFLINE';`);
            lines.push(`RESTORE DATAFILE ${n};`, `RECOVER DATAFILE ${n};`, `SQL 'ALTER DATABASE DATAFILE ${n} ONLINE';`);
            out.steps.push(rmanStep('restore', `Restaurar e recuperar o datafile ${n}`, lines, { note: `Arquivo: ${d.name}` }));
            if (ctx.state === 'MOUNTED' && bool(ctx.p.openAfter, true)) out.steps.push(sqlplusStep('open', 'Abrir o banco', ['ALTER DATABASE OPEN;'], { restartsInstance: true }));
        },
    },

    'block-recover': {
        title: 'Recuperar blocos corrompidos',
        summary: 'Valida os datafiles, registra os blocos ruins e recupera SÓ esses blocos a partir do backup + archives, com o banco aberto.',
        when: 'ORA-01578, ORA-00600 de bloco ([kddummy_blkchk], [ktbair2]...), linhas em V$DATABASE_BLOCK_CORRUPTION.',
        category: 'corruption', risk: 'low', downtime: false, dataLoss: false, confirm: 'ack',
        states: ['OPEN', 'MOUNTED'],
        schema(ctx) {
            const files = affectedFiles(ctx.s);
            return [{
                name: 'scope', label: 'Validar', type: 'select', value: ctx.p.scope || (files.length ? 'files' : 'database'),
                options: [
                    ...(files.length ? [{ value: 'files', label: `Só os datafiles afetados (${files.join(', ')})` }] : []),
                    { value: 'database', label: 'O banco inteiro (mais demorado)' },
                ],
            }];
        },
        build(ctx, out) {
            requireAutomation(ctx, out);
            requireStates(ctx, out, ['OPEN', 'MOUNTED']);
            requireArchivelog(ctx, out, 'Exige ARCHIVELOG: a recuperação de blocos aplica o redo dos archives.');
            const ee = ctx.s.edition;
            if (ee) {
                out.preconditions.push({ ok: ee === 'EE', label: 'Enterprise Edition (recuperação de blocos)', detail: ctx.s.banner || ee });
                if (ee !== 'EE') out.blockers.push('A recuperação de blocos (block media recovery) exige Enterprise Edition. Use "Restaurar datafile do backup" ou reconstrua o objeto (se for índice).');
            }
            backupPrecondition(ctx, out, null);
            const files = affectedFiles(ctx.s);
            const scope = ctx.p.scope === 'files' && files.length ? `DATAFILE ${files.join(', ')}` : 'DATABASE';
            out.steps.push(rmanStep('validate', 'Validar e registrar os blocos corrompidos', [`BACKUP VALIDATE CHECK LOGICAL ${scope};`], { note: 'Lê os arquivos sem gerar backup; preenche V$DATABASE_BLOCK_CORRUPTION.' }));
            out.steps.push(rmanStep('recover', 'Recuperar os blocos (RECOVER CORRUPTION LIST)', ['RECOVER CORRUPTION LIST;']));
            out.steps.push(rmanStep('revalidate', 'Validar novamente', [`BACKUP VALIDATE CHECK LOGICAL ${scope};`]));
            const idx = (ctx.s.corruptSegments || []).filter((c) => c.segment && /INDEX/.test(c.segment.type));
            if (idx.length) out.warnings.push(`Os blocos de ${idx.map((c) => `${c.segment.owner}.${c.segment.name}`).join(', ')} são de ÍNDICE: reconstruir o índice resolve sem precisar de backup.`);
        },
    },

    'index-rebuild': {
        title: 'Reconstruir índice corrompido',
        summary: 'Recria o índice a partir da tabela (REBUILD ONLINE: leituras e escritas continuam) e valida a tabela.',
        when: 'ORA-01578 em bloco de índice, ORA-08102, ORA-01499, ORA-01410, ORA-00600 [kdsgrp1]/[13013]/[6006].',
        category: 'corruption', risk: 'low', downtime: false, dataLoss: false, confirm: 'ack',
        states: ['OPEN'],
        schema(ctx) {
            const cands = indexCandidates(ctx.s);
            return [{
                name: 'index', label: 'Índice (DONO.NOME)', type: 'text', value: ctx.p.index || (cands[0] || ''),
                suggestions: cands, hint: cands.length ? 'Sugestões: índices em blocos corrompidos.' : 'Informe o índice citado no erro/trace.',
            }, { name: 'validate', label: 'Validar a tabela ao final (ANALYZE ... VALIDATE STRUCTURE CASCADE ONLINE)', type: 'checkbox', value: bool(ctx.p.validate, true) }];
        },
        async build(ctx, out) {
            requireStates(ctx, out, ['OPEN']);
            const raw = String(ctx.p.index || '').trim();
            const m = /^([A-Za-z][A-Za-z0-9_$#]*)\.([A-Za-z][A-Za-z0-9_$#]*)$/.exec(raw);
            if (!m) throw new PlanError('Informe o índice como DONO.NOME (ex.: VENDAS.IDX_PEDIDOS_CLIENTE).');
            const owner = ident(m[1], 'Dono');
            const name = ident(m[2], 'Índice');
            const info = await ctx.indexInfo(m[1].toUpperCase(), m[2].toUpperCase());
            if (!info) throw new PlanError(`Índice ${raw.toUpperCase()} não encontrado em DBA_INDEXES.`);
            if (/LOB|DOMAIN|IOT|CLUSTER/i.test(info.indexType || '')) out.blockers.push(`Índice do tipo ${info.indexType}: a reconstrução automática não se aplica (trate pelo objeto dono).`);
            const online = ctx.s.edition === 'EE' ? ' ONLINE' : '';
            if (!online) out.warnings.push('Standard Edition: REBUILD sem ONLINE bloqueia DML na tabela durante a reconstrução — faça fora do horário de pico. Se falhar por ler o bloco corrompido do próprio índice, recrie o índice (DROP + CREATE) com o DDL de DBMS_METADATA.GET_DDL.');
            const sqls = info.partitions && info.partitions.length
                ? info.partitions.slice(0, 200).map((p) => `ALTER INDEX ${owner}.${name} REBUILD PARTITION ${ident(p, 'Partição')}${online}`)
                : [`ALTER INDEX ${owner}.${name} REBUILD${online}`];
            out.steps.push(sqlStep('rebuild', `Reconstruir ${raw.toUpperCase()}`, sqls.map((sql) => ({ sql })), { note: `Tabela: ${info.tableOwner}.${info.tableName}${info.partitions && info.partitions.length ? ` · ${info.partitions.length} partição(ões)` : ''}` }));
            if (bool(ctx.p.validate, true)) {
                out.steps.push(sqlStep('analyze', `Validar ${info.tableOwner}.${info.tableName} e seus índices`, [{ sql: `ANALYZE TABLE ${ident(info.tableOwner)}.${ident(info.tableName)} VALIDATE STRUCTURE CASCADE ONLINE` }], { note: 'Em tabelas grandes pode demorar; não bloqueia a tabela.' }));
            }
        },
    },

    // ---------------------------------------------------------------- archive / FRA
    'fra-free': {
        title: 'Liberar a FRA / destravar o archiver',
        summary: 'Libera espaço na Fast Recovery Area: aumentando o limite, apagando o que é seguro apagar ou fazendo backup dos archives.',
        when: 'ORA-00257, ORA-19809, ORA-19815, ORA-16038, ORA-16014; FRA acima de 85%.',
        category: 'archive', risk: 'low', downtime: false, dataLoss: false, confirm: 'ack',
        states: ['OPEN', 'MOUNTED'],
        schema(ctx) {
            const fra = ctx.s.fra;
            const suggested = fraSuggestedGb(fra);
            const modes = [
                ...(fra ? [{ value: 'grow', label: `Aumentar o limite da FRA (imediato) — hoje ${Math.round(fra.limitMb / 1024)} GB` }] : []),
                { value: 'cleanup', label: 'Apagar o que é seguro (expirados, obsoletos e archives já copiados)' },
                { value: 'archive-backup', label: 'Backup compactado dos archives + apagar os originais' },
                { value: 'force', label: 'ÚLTIMO RECURSO: apagar archives ainda sem backup' },
            ];
            const mode = ctx.p.mode || (fra ? 'grow' : 'cleanup');
            return [
                { name: 'mode', label: 'Como liberar', type: 'select', options: modes, value: mode },
                { name: 'addGb', label: 'Aumentar em (GB)', type: 'number', min: 1, max: 10240, value: ctx.p.addGb != null ? Number(ctx.p.addGb) : suggested, showIf: { mode: 'grow' }, hint: `Sugestão: ${suggested} GB (deixa a FRA perto de 70%).` },
                { name: 'keepDays', label: 'Manter archives dos últimos (dias)', type: 'number', min: 0, max: 30, value: ctx.p.keepDays != null ? Number(ctx.p.keepDays) : 1, showIf: { mode: 'force' } },
            ];
        },
        async build(ctx, out) {
            requireStates(ctx, out, ['OPEN', 'MOUNTED']);
            const mode = ctx.p.mode || (ctx.s.fra ? 'grow' : 'cleanup');
            const fra = ctx.s.fra;
            if (mode === 'grow') {
                if (!fra) throw new PlanError('A FRA não está configurada (DB_RECOVERY_FILE_DEST vazio): use a limpeza.');
                const add = intParam(ctx.p.addGb != null ? ctx.p.addGb : fraSuggestedGb(fra), 'Aumento (GB)', 1, 10240);
                const newGb = Math.ceil(fra.limitMb / 1024) + add;
                const disk = await ctx.diskFor(fra.dest);
                if (disk && !disk.error && Number.isFinite(disk.freeGB)) {
                    const ok = disk.freeGB - add >= 1;
                    out.preconditions.push({ ok, label: `Espaço livre no volume da FRA (${fra.dest})`, detail: `${disk.freeGB} GB livres; aumento de ${add} GB.` });
                    if (!ok) out.blockers.push(`O volume da FRA tem só ${disk.freeGB} GB livres: aumentar ${add} GB encheria o disco. Use a limpeza ou um aumento menor.`);
                } else {
                    out.preconditions.push({ ok: null, label: 'Espaço livre no volume da FRA', detail: disk && disk.error ? disk.error : 'Não foi possível medir — confira antes.' });
                }
                const scope = (ctx.s.params || {}).spfile ? 'BOTH' : 'MEMORY';
                if (scope === 'MEMORY') out.warnings.push('A instância usa PFILE: o novo tamanho vale até o próximo reinício. Atualize o init.ora também.');
                out.steps.push(flexStep(ctx, 'grow', `Aumentar DB_RECOVERY_FILE_DEST_SIZE para ${newGb} GB`, [`ALTER SYSTEM SET db_recovery_file_dest_size = ${newGb}G SCOPE=${scope}`], {
                    note: 'Com o archiver travado (ORA-00257) só SYSDBA conecta — por isso o painel usa sqlplus quando a conexão normal falha.',
                }));
            } else {
                requireAutomation(ctx, out);
                if (mode === 'cleanup') {
                    out.steps.push(rmanStep('cleanup', 'Apagar expirados, obsoletos e archives já copiados', [
                        'CROSSCHECK ARCHIVELOG ALL;', 'CROSSCHECK BACKUP;',
                        'DELETE NOPROMPT EXPIRED ARCHIVELOG ALL;', 'DELETE NOPROMPT EXPIRED BACKUP;',
                        'DELETE NOPROMPT OBSOLETE;',
                        'DELETE NOPROMPT ARCHIVELOG ALL BACKED UP 1 TIMES TO DEVICE TYPE DISK;',
                    ], { note: 'Só remove o que o RMAN considera seguro: arquivos que já não existem, obsoletos pela retenção e archives que já têm backup.' }));
                } else if (mode === 'archive-backup') {
                    out.steps.push(rmanStep('archbackup', 'Backup compactado dos archives e remoção dos originais', ['BACKUP AS COMPRESSED BACKUPSET ARCHIVELOG ALL DELETE INPUT;']));
                    out.warnings.push('Se o destino de backup for a própria FRA, o ganho é só a compactação (tipicamente 50–80%).');
                } else if (mode === 'force') {
                    const keep = intParam(ctx.p.keepDays != null ? ctx.p.keepDays : 1, 'Dias a manter', 0, 30);
                    out.steps.push(rmanStep('force', `Apagar archives com mais de ${keep} dia(s), mesmo sem backup`, [
                        'CROSSCHECK ARCHIVELOG ALL;',
                        `DELETE NOPROMPT FORCE ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE-${keep}';`,
                    ]));
                    out.steps.push(backupStep('backup'));
                    out.overrides = { risk: 'high', dataLoss: false, confirm: 'dbname' };
                    out.warnings.push('Archives sem backup serão apagados: até o próximo backup completo, NÃO será possível recuperar o banco para um ponto anterior. O backup completo ao final é fortemente recomendado (precisa de espaço no destino).');
                } else {
                    throw new PlanError('Modo de liberação inválido.');
                }
            }
        },
    },

    // ---------------------------------------------------------------- redo
    'redo-member': {
        title: 'Recriar membro de redo log',
        summary: 'Remove o membro inválido e o cria de novo no mesmo caminho. O grupo continua funcionando pelo outro membro: sem impacto.',
        when: 'ORA-00313/ORA-00321/ORA-00354 em um membro, com outro membro válido no grupo.',
        category: 'redo', risk: 'low', downtime: false, dataLoss: false, confirm: 'ack',
        states: ['OPEN', 'MOUNTED'],
        schema(ctx) {
            const opts = [];
            for (const g of ctx.s.logs || []) {
                for (const m of g.memberList) {
                    const bad = m.status === 'INVALID' || badMemberFromAlert(ctx.s, m.path);
                    opts.push({ value: `${g.group}|${m.path}`, label: `Grupo ${g.group} (${g.status}) — ${m.path}${bad ? ' · INVÁLIDO' : ''}`, bad });
                }
            }
            opts.sort((a, b) => b.bad - a.bad);
            return [{ name: 'member', label: 'Membro a recriar', type: 'select', options: opts.map(({ value, label }) => ({ value, label })), value: ctx.p.member || (opts[0] ? opts[0].value : '') }];
        },
        build(ctx, out) {
            requireStates(ctx, out, ['OPEN', 'MOUNTED']);
            const [gs, ...rest] = String(ctx.p.member || '').split('|');
            const path = rest.join('|');
            const g = (ctx.s.logs || []).find((x) => x.group === Number(gs));
            if (!g || !g.memberList.some((m) => m.path === path)) throw new PlanError('Escolha um membro de redo existente.');
            const others = g.memberList.filter((m) => m.path !== path && m.status !== 'INVALID');
            out.preconditions.push({ ok: others.length > 0, label: 'Outro membro válido no grupo', detail: others.length ? others.map((m) => m.path).join(', ') : 'Nenhum.' });
            if (!others.length) out.blockers.push(`O grupo ${g.group} não tem outro membro válido: use "Limpar grupo de redo" (grupo inativo) ou "Recuperação incompleta" (grupo corrente).`);
            if (ctx.state !== 'OPEN') requireAutomation(ctx, out);
            const recreate = [`ALTER DATABASE DROP LOGFILE MEMBER ${lit(path)}`, `ALTER DATABASE ADD LOGFILE MEMBER ${lit(path)} REUSE TO GROUP ${g.group}`];
            let sqls = recreate;
            if (ctx.state === 'OPEN') {
                // O status do grupo muda a cada troca de log: o bloco garante, na hora, que
                // ele está INATIVO e ARQUIVADO (o archiver não lê o membro recriado vazio).
                const opts = { archivelog: (ctx.s.database || {}).logMode === 'ARCHIVELOG', version: (ctx.s.instance || {}).version };
                sqls = [idleGroupSql(g.group, opts, recreate)];
            } else if (g.status === 'CURRENT') {
                out.blockers.push('O grupo é o CORRENTE e o banco não está aberto: abra o banco primeiro (o painel troca de log antes de recriar).');
            }
            out.steps.push(flexStep(ctx, 'recreate', `Recriar o membro do grupo ${g.group}`, sqls, { note: path }));
        },
    },

    'redo-clear': {
        title: 'Limpar grupo de redo corrompido',
        summary: 'Reinicializa um grupo de redo INATIVO cujos membros estão perdidos/corrompidos (ALTER DATABASE CLEAR LOGFILE).',
        when: 'ORA-00313/ORA-00353/ORA-00354/ORA-00316 em grupo INACTIVE/UNUSED sem membro válido.',
        category: 'redo', risk: 'medium', downtime: false, dataLoss: false, confirm: 'ack',
        states: ['OPEN', 'MOUNTED'],
        schema(ctx) {
            const opts = (ctx.s.logs || []).map((g) => ({
                value: g.group,
                label: `Grupo ${g.group} — ${g.status}, arquivado: ${g.archived}${g.memberList.every((m) => m.status === 'INVALID') ? ' · todos os membros inválidos' : ''}`,
            }));
            const bad = (ctx.s.logs || []).find((g) => g.memberList.every((m) => m.status === 'INVALID'));
            const fields = [{ name: 'group', label: 'Grupo', type: 'select', options: opts, value: ctx.p.group != null ? Number(ctx.p.group) : (bad ? bad.group : (opts[0] || {}).value) }];
            fields.push({ name: 'backupAfter', label: 'Backup completo ao final (recomendado se o grupo não estava arquivado)', type: 'checkbox', value: bool(ctx.p.backupAfter, true) });
            if (ctx.state === 'MOUNTED') fields.push({ name: 'openAfter', label: 'Abrir o banco ao final', type: 'checkbox', value: bool(ctx.p.openAfter, true) });
            return fields;
        },
        build(ctx, out) {
            requireStates(ctx, out, ['OPEN', 'MOUNTED']);
            const n = intParam(ctx.p.group, 'Grupo', 1, 10000);
            const g = (ctx.s.logs || []).find((x) => x.group === n);
            if (!g) throw new PlanError(`Grupo de redo ${n} não existe.`);
            if (['CURRENT', 'ACTIVE'].includes(g.status) && ctx.state !== 'OPEN') {
                out.blockers.push(`O grupo ${n} está ${g.status} e o banco não está aberto: o redo dele é necessário. Use "Recuperação incompleta".`);
            }
            const unarchived = ctx.s.database && ctx.s.database.logMode === 'ARCHIVELOG' && g.archived === 'NO';
            if (ctx.state !== 'OPEN') requireAutomation(ctx, out);
            const sqls = [];
            if (ctx.state === 'OPEN') sqls.push(leaveGroupSql(n));
            sqls.push(`ALTER DATABASE CLEAR ${unarchived ? 'UNARCHIVED ' : ''}LOGFILE GROUP ${n}`);
            if (ctx.state === 'MOUNTED' && bool(ctx.p.openAfter, true)) sqls.push('ALTER DATABASE OPEN');
            out.steps.push(flexStep(ctx, 'clear', `Limpar o grupo ${n}${unarchived ? ' (não arquivado)' : ''}`, sqls, { restartsInstance: ctx.state === 'MOUNTED' }));
            if (unarchived) {
                out.warnings.push('O grupo não foi arquivado: haverá um "buraco" na sequência de archives e os backups anteriores não poderão ser recuperados além deste ponto. Faça um backup completo em seguida.');
                out.overrides = { risk: 'medium' };
            }
            if (bool(ctx.p.backupAfter, true)) {
                requireAutomation(ctx, out);
                out.steps.push(backupStep('backup'));
            }
        },
    },

    'redo-multiplex': {
        title: 'Multiplexar os redo logs',
        summary: 'Acrescenta um 2º membro a cada grupo de redo que tem um só arquivo, de preferência em outro disco. Cada grupo só recebe o membro quando está inativo e já arquivado. Feito com o banco no ar, sem parada.',
        when: 'Prontidão: "Redo logs multiplexados" em alerta (grupos com um só membro). Perder o único membro do grupo corrente obriga a uma recuperação incompleta.',
        category: 'redo', risk: 'low', downtime: false, dataLoss: false, confirm: 'ack',
        states: ['OPEN'],
        schema(ctx) {
            const existing = (ctx.s.logs || []).flatMap((g) => g.memberList.map((m) => m.path)).filter(Boolean);
            const sug = existing.length ? suggestMirrorDir(ctx.s, existing, { sub: 'REDO_B', allowAsm: true }) : { dir: '', otherVolume: false };
            return [{
                name: 'dir', label: 'Diretório dos novos membros', type: 'text', value: ctx.p.dir || sug.dir,
                hint: sug.otherVolume ? 'Sugerido: outro disco, onde o banco já tem arquivos.'
                    : 'Não encontrei outro disco com arquivos do banco: a sugestão fica no mesmo disco, em pasta própria. Se o servidor tiver outro disco, informe uma pasta nele.',
            }];
        },
        build(ctx, out) {
            requireStates(ctx, out, ['OPEN'], 'Abra o banco: cada membro é adicionado depois que o grupo fica inativo e arquivado (exige trocas de log).');
            const logs = ctx.s.logs || [];
            if (!logs.length) throw new PlanError('Os grupos de redo não foram lidos no diagnóstico (banco montado?).');
            const single = logs.filter((g) => g.memberList.length < 2);
            out.preconditions.push({
                ok: single.length > 0, label: 'Grupos com um só membro',
                detail: single.length ? `${single.length} de ${logs.length}: ${single.map((g) => `grupo ${g.group}`).join(', ')}` : 'Nenhum: todos já têm 2+ membros.',
            });
            if (!single.length) { out.blockers.push('Todos os grupos de redo já têm 2 ou mais membros.'); return; }
            const existing = logs.flatMap((g) => g.memberList.map((m) => m.path)).filter(Boolean);
            const dir = mirrorDirParam(ctx.p.dir, existing[0], { allowAsm: true });
            const asm = sp.pathStyle(dir) === 'asm';
            const taken = new Set(existing.map(sp.fileKey));
            const adds = single.map((g) => {
                if (asm) return { g, path: dir };
                const cur = g.memberList[0].path;
                if (sp.dirKey(sp.dirOf(cur)) === sp.dirKey(dir)) out.blockers.push('O diretório escolhido é o mesmo dos membros atuais: escolha OUTRO diretório (de preferência em outro disco).');
                const base = sp.baseName(cur);
                const dot = base.lastIndexOf('.');
                const stem = dot > 0 ? base.slice(0, dot) : base;
                const ext = dot > 0 ? base.slice(dot) : '.log';
                const upper = base === base.toUpperCase();
                const name = nextFreeName(dir, ['B', 'C', 'D', 'E'].map((x) => `${stem}${upper ? x : x.toLowerCase()}${ext}`), taken);
                taken.add(sp.fileKey(dir + name));
                return { g, path: dir + name };
            });
            const sameVolume = !asm && existing.some((p) => volumeRoot(p) === volumeRoot(dir));
            out.preconditions.push({
                ok: sameVolume ? null : true, label: 'Novos membros em outro disco',
                detail: sameVolume ? `${volumeRoot(dir)} é o mesmo disco dos membros atuais: protege contra perda/corrupção de um arquivo, não contra falha do disco.` : `${dir}`,
            });
            const totalMb = single.reduce((n, g) => n + (Number(g.sizeMb) || 0), 0);
            if (totalMb) out.preconditions.push({ ok: null, label: 'Espaço necessário', detail: `~${Math.ceil(totalMb)} MB no destino (um membro do tamanho do grupo).` });
            if (!asm) {
                if (ctx.automation) out.steps.push(mkdirStep('mkdir', dir, ctx.serverOs));
                else out.warnings.push(`Crie a pasta ${dir} no servidor (com escrita para o Oracle) antes de rodar os comandos.`);
            }
            // Um grupo por vez: só recebe o membro quando está INATIVO e ARQUIVADO — o archiver
            // nunca lê o arquivo novo ainda vazio (sem ORA-00313/ORA-00312 no alert log).
            const opts = { archivelog: (ctx.s.database || {}).logMode === 'ARCHIVELOG', version: (ctx.s.instance || {}).version };
            out.steps.push(flexStep(ctx, 'add', `Adicionar ${adds.length} membro(s) de redo (cada grupo inativo e arquivado)`,
                adds.map((a) => idleGroupSql(a.g.group, opts, [`ALTER DATABASE ADD LOGFILE MEMBER ${lit(a.path)} TO GROUP ${a.g.group}`])),
                { note: adds.map((a) => `grupo ${a.g.group} → ${a.path}`).join(' · ') }));
            const n = logs.length;
            out.steps.push(flexStep(ctx, 'switch', 'Trocar de log para validar os novos membros',
                [`BEGIN FOR i IN 1..${n} LOOP EXECUTE IMMEDIATE 'ALTER SYSTEM SWITCH LOGFILE'; END LOOP; EXECUTE IMMEDIATE 'ALTER SYSTEM CHECKPOINT'; END;`],
                { note: `Um membro novo fica INVALID até o grupo ser usado: ${n} trocas de log passam por todos os grupos (gera ${n} archives pequenos).` }));
            if (!versionAtLeast(opts.version, 18)) out.warnings.push('Versão anterior ao 18c: a espera usa DBMS_LOCK.SLEEP. Se o usuário do painel não tiver EXECUTE nele, o primeiro passo falha antes de alterar qualquer coisa.');
        },
    },

    'incomplete-recovery': {
        title: 'Recuperação incompleta (UNTIL CANCEL + RESETLOGS)',
        summary: 'Aplica todo o redo arquivado disponível, cancela no ponto onde o redo foi perdido e abre com RESETLOGS. As transações que estavam só no log perdido são PERDIDAS.',
        when: 'Grupo de redo CORRENTE/ATIVO perdido ou corrompido, ORA-00742, archive inexistente, controlfile de backup (ORA-01207).',
        category: 'recovery', risk: 'high', downtime: true, dataLoss: true, confirm: 'dbname',
        states: ['DOWN', 'STARTED', 'MOUNTED'],
        schema(ctx) {
            const backupCf = ctx.s.database && ctx.s.database.controlfileType === 'BACKUP';
            return [
                { name: 'usingBackupControlfile', label: 'Usar controlfile de backup (USING BACKUP CONTROLFILE)', type: 'checkbox', value: bool(ctx.p.usingBackupControlfile, !!backupCf), hint: backupCf ? 'Detectado: o controlfile atual é de backup.' : 'Marque se o controlfile foi restaurado de um backup.' },
                { name: 'backupAfter', label: 'Backup completo logo após o RESETLOGS', type: 'checkbox', value: bool(ctx.p.backupAfter, true) },
            ];
        },
        build(ctx, out) {
            requireAutomation(ctx, out);
            requireStates(ctx, out, ['DOWN', 'STARTED', 'MOUNTED'], 'O banco está aberto: recuperação incompleta exige o banco montado (e só faz sentido se ele não consegue abrir).');
            const fuzzy = (ctx.s.datafiles || []).filter((d) => d.fuzzy === 'YES');
            if (fuzzy.length && ctx.state === 'MOUNTED') {
                out.warnings.push(`${fuzzy.length} datafile(s) estão "fuzzy" (precisavam do redo perdido para ficarem consistentes): o OPEN RESETLOGS pode falhar com ORA-01194. Nesse caso o caminho é "Restaurar o banco do backup".`);
            }
            const using = bool(ctx.p.usingBackupControlfile, !!(ctx.s.database && ctx.s.database.controlfileType === 'BACKUP')) ? ' USING BACKUP CONTROLFILE' : '';
            const cf = (ctx.s.controlFileParam && ctx.s.controlFileParam[0]) || (ctx.s.controlfiles && ctx.s.controlfiles[0] && ctx.s.controlfiles[0].name);
            const stamp = ctx.stamp;
            const protect = [];
            if (cf && sp.pathStyle(cf) !== 'asm' && sp.pathStyle(cf) !== 'unknown') {
                const dir = sp.normalizeDir(sp.dirOf(cf));
                protect.push(`ALTER DATABASE BACKUP CONTROLFILE TO ${lit(`${dir}op_ctl_${stamp}.bkp`)} REUSE;`);
                protect.push(`ALTER DATABASE BACKUP CONTROLFILE TO TRACE AS ${lit(`${dir}op_ctl_${stamp}.sql`)} REUSE;`);
            } else {
                protect.push('ALTER DATABASE BACKUP CONTROLFILE TO TRACE;');
            }
            out.steps.push(sqlplusStep('protect', 'Montar o banco e guardar uma cópia do controlfile atual', protect, {
                variants: MOUNT_VARIANTS(false), restartsInstance: true,
                note: 'Permite voltar ao estado atual se algo der errado.',
            }));
            out.steps.push(sqlplusStep('recover', 'Aplicar o redo arquivado disponível e cancelar', [
                'WHENEVER SQLERROR CONTINUE',
                `RECOVER DATABASE UNTIL CANCEL${using};`,
                'AUTO',
                `RECOVER DATABASE UNTIL CANCEL${using};`,
                'CANCEL',
            ], {
                benign: ['ORA-00279', 'ORA-00289', 'ORA-00280', 'ORA-00278', 'ORA-00308', 'ORA-27037', 'ORA-27041', 'ORA-00283', 'ORA-01112', 'ORA-01547', 'ORA-01194', 'ORA-01110', 'ORA-01152', 'SP2-0042'],
                note: '"AUTO" aplica todos os archives encontrados; o segundo RECOVER recebe "CANCEL" no ponto do log perdido.',
            }));
            out.steps.push(sqlplusStep('open', 'Abrir com RESETLOGS', ['ALTER DATABASE OPEN RESETLOGS;'], { restartsInstance: true }));
            if (bool(ctx.p.backupAfter, true)) out.steps.push(backupStep('backup'));
        },
    },

    'open-resetlogs': {
        title: 'Abrir com RESETLOGS',
        summary: 'Abre o banco iniciando uma nova encarnação, depois de recuperação incompleta ou com controlfile de backup.',
        when: 'ORA-01589 (must use RESETLOGS or NORESETLOGS), RMAN-06054 ao fim de uma recuperação com controlfile de backup.',
        category: 'recovery', risk: 'high', downtime: false, dataLoss: false, confirm: 'dbname',
        states: ['MOUNTED'],
        schema: (ctx) => [{ name: 'backupAfter', label: 'Backup completo logo após o RESETLOGS', type: 'checkbox', value: bool(ctx.p.backupAfter, true) }],
        build(ctx, out) {
            requireAutomation(ctx, out);
            requireStates(ctx, out, ['MOUNTED']);
            out.steps.push(sqlplusStep('open', 'Abrir com RESETLOGS', ['ALTER DATABASE OPEN RESETLOGS;'], { restartsInstance: true }));
            if (bool(ctx.p.backupAfter, true)) out.steps.push(backupStep('backup'));
        },
    },

    'restore-database': {
        title: 'Restaurar o banco do backup',
        summary: 'Confere os backups, restaura todos os datafiles, recupera (até agora ou até um horário) e abre. Para perda de vários arquivos/disco inteiro ou para voltar no tempo.',
        when: 'Perda de disco com vários datafiles, ORA-00704, ORA-01194 após recuperação incompleta, erro lógico grave (voltar a um horário).',
        category: 'media', risk: 'high', downtime: true, dataLoss: false, confirm: 'dbname',
        states: ['OPEN', 'MOUNTED', 'STARTED', 'DOWN'],
        schema: (ctx) => [
            { name: 'untilTime', label: 'Recuperar até (opcional, AAAA-MM-DD HH:MM:SS)', type: 'text', value: ctx.p.untilTime || '', hint: 'Vazio = recuperação completa até agora (sem perda). Com horário = volta o banco no tempo (perde o que veio depois) e abre com RESETLOGS.' },
            { name: 'backupAfter', label: 'Backup completo ao final', type: 'checkbox', value: bool(ctx.p.backupAfter, true) },
        ],
        build(ctx, out) {
            requireAutomation(ctx, out);
            requireArchivelog(ctx, out, 'Banco em NOARCHIVELOG: só é possível restaurar o último backup (sem aplicar redo) — procedimento manual, com perda de tudo após o backup.');
            backupPrecondition(ctx, out, null);
            if (ctx.s.backups && ctx.s.backups.newestAny && !ctx.s.backups.allCovered) out.warnings.push('Nem todos os datafiles atuais aparecem nos backups registrados: a conferência (1º passo) vai apontar o que falta.');
            let until = '';
            const ut = String(ctx.p.untilTime || '').trim();
            if (ut) {
                const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(ut);
                if (!m) throw new PlanError('Horário inválido: use AAAA-MM-DD HH:MM:SS.');
                const norm = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`;
                until = `SET UNTIL TIME "TO_DATE('${norm}','YYYY-MM-DD HH24:MI:SS')";`;
                out.overrides = { dataLoss: true };
                out.warnings.push(`Tudo o que foi gravado depois de ${norm} será PERDIDO (o banco volta a esse ponto e abre com RESETLOGS).`);
            }
            const pre = until ? [until] : [];
            out.steps.push(rmanStep('preview', 'Conferir se os backups necessários existem (não altera nada)', [...pre, 'RESTORE DATABASE PREVIEW SUMMARY;'], {
                variants: { DOWN: ['STARTUP MOUNT;'], STARTED: ['ALTER DATABASE MOUNT;'], MOUNTED: [], OPEN: [] },
            }));
            out.steps.push(rmanStep('restore', 'Restaurar todos os datafiles e recuperar', [...pre, 'RESTORE DATABASE;', 'RECOVER DATABASE;'], {
                variants: MOUNT_VARIANTS(true), restartsInstance: true,
                note: 'O banco fica indisponível até o fim. Duração ~ tempo de um backup completo.',
            }));
            out.steps.push(sqlplusStep('open', until ? 'Abrir com RESETLOGS' : 'Abrir o banco', [until ? 'ALTER DATABASE OPEN RESETLOGS;' : 'ALTER DATABASE OPEN;'], { restartsInstance: true }));
            if (bool(ctx.p.backupAfter, true)) out.steps.push(backupStep('backup'));
        },
    },

    'controlfile-restore': {
        title: 'Recuperar o controlfile',
        summary: 'Restaura o controlfile a partir de uma cópia multiplexada boa (sem perda) ou do autobackup do RMAN (abre com RESETLOGS).',
        when: 'ORA-00205, ORA-00202, ORA-00210, ORA-00214, ORA-00227, ORA-00600 [kccpb_sanity_check_2].',
        category: 'controlfile', risk: 'medium', downtime: true, dataLoss: false, confirm: 'ack',
        states: ['DOWN', 'STARTED', 'MOUNTED'],
        schema(ctx) {
            const cfs = ctx.s.controlFileParam && ctx.s.controlFileParam.length ? ctx.s.controlFileParam : ((ctx.snapshot && ctx.snapshot.controlFiles) || []);
            const bad = badControlfiles(ctx.s);
            const good = cfs.filter((c) => !bad.includes(c));
            const modes = [];
            if (cfs.length >= 2) modes.push({ value: 'copy', label: 'Copiar uma cópia boa sobre as outras (sem perda)' });
            modes.push({ value: 'autobackup', label: 'Restaurar do autobackup do RMAN (abre com RESETLOGS)' });
            const dbid = ctx.p.dbid || (ctx.s.database && ctx.s.database.dbid) || (ctx.snapshot && ctx.snapshot.dbid) || '';
            return [
                { name: 'mode', label: 'Origem', type: 'select', options: modes, value: ctx.p.mode || modes[0].value },
                { name: 'source', label: 'Cópia boa', type: 'select', options: cfs.map((c) => ({ value: c, label: `${c}${bad.includes(c) ? ' · com erro' : ''}` })), value: ctx.p.source || good[0] || cfs[0] || '', showIf: { mode: 'copy' } },
                { name: 'dbid', label: 'DBID', type: 'text', value: String(dbid), showIf: { mode: 'autobackup' }, hint: dbid ? 'Guardado pelo painel enquanto o banco estava saudável.' : 'Informe o DBID (aparece no nome do autobackup e nos logs do RMAN).' },
                { name: 'backupAfter', label: 'Backup completo ao final', type: 'checkbox', value: bool(ctx.p.backupAfter, true), showIf: { mode: 'autobackup' } },
            ];
        },
        build(ctx, out) {
            requireAutomation(ctx, out);
            requireStates(ctx, out, ['DOWN', 'STARTED', 'MOUNTED'], 'O banco está aberto: o controlfile em uso está funcionando. Para refazer a multiplexação, faça em janela de manutenção.');
            const mode = ctx.p.mode || 'copy';
            const cfs = ctx.s.controlFileParam && ctx.s.controlFileParam.length ? ctx.s.controlFileParam : ((ctx.snapshot && ctx.snapshot.controlFiles) || []);
            if (ctx.serverOs === 'windows' && config.oracleServer.tnsAlias) {
                out.warnings.push('No Windows, conectando pelo alias TNS, o RMAN só alcança a instância em NOMOUNT se o SID estiver registrado ESTATICAMENTE no listener (SID_LIST_LISTENER).');
            }
            if (mode === 'copy') {
                if (cfs.length < 2) throw new PlanError('Há uma só cópia do controlfile: use o autobackup.');
                const src = String(ctx.p.source || '');
                if (!cfs.includes(src)) throw new PlanError('Escolha uma das cópias listadas em CONTROL_FILES.');
                out.preconditions.push({ ok: true, label: 'Cópia de origem', detail: src });
                out.steps.push(rmanStep('restore', 'Restaurar o controlfile a partir da cópia boa e montar', [`RESTORE CONTROLFILE FROM ${lit(src)};`, 'ALTER DATABASE MOUNT;'], {
                    variants: NOMOUNT_VARIANTS(), restartsInstance: true,
                    note: 'O RMAN grava a cópia em TODOS os caminhos de CONTROL_FILES.',
                }));
                out.steps.push(sqlplusStep('open', 'Abrir o banco', ['ALTER DATABASE OPEN;'], { restartsInstance: true, note: 'Se pedir RESETLOGS (ORA-01589), use "Abrir com RESETLOGS".' }));
                out.overrides = { risk: 'medium', dataLoss: false, confirm: 'ack' };
            } else {
                const dbid = String(ctx.p.dbid || (ctx.s.database && ctx.s.database.dbid) || (ctx.snapshot && ctx.snapshot.dbid) || '').trim();
                if (dbid && !/^\d{1,12}$/.test(dbid)) throw new PlanError('DBID inválido (só dígitos).');
                const auto = (ctx.s.rmanConfig || {})['CONTROLFILE AUTOBACKUP'];
                out.preconditions.push({ ok: auto ? /ON/i.test(auto) : null, label: 'Autobackup do controlfile', detail: auto ? `CONTROLFILE AUTOBACKUP ${auto}` : 'Configuração não lida (padrão ON a partir do 12.2).' });
                out.preconditions.push({ ok: dbid ? true : null, label: 'DBID conhecido', detail: dbid || 'Sem DBID o RMAN só acha o autobackup se ele estiver na FRA.' });
                out.steps.push(sqlplusStep('nomount', 'Iniciar a instância em NOMOUNT', ["SELECT 'Estado: '||status AS estado FROM v$instance;"], { variants: NOMOUNT_VARIANTS(), restartsInstance: true }));
                out.steps.push(rmanStep('restore', 'Restaurar o controlfile do autobackup e montar', ['RESTORE CONTROLFILE FROM AUTOBACKUP;', 'ALTER DATABASE MOUNT;'], {
                    pre: dbid ? [`SET DBID ${dbid};`] : [],
                }));
                out.steps.push(rmanStep('recover', 'Recuperar o banco com o controlfile restaurado', ['RECOVER DATABASE;'], {
                    tolerate06054: true,
                    note: 'Termina normalmente com RMAN-06054 (pediu um log que não existe): é o fim do redo disponível.',
                }));
                out.steps.push(sqlplusStep('open', 'Abrir com RESETLOGS', ['ALTER DATABASE OPEN RESETLOGS;'], { restartsInstance: true }));
                if (bool(ctx.p.backupAfter, true)) out.steps.push(backupStep('backup'));
                out.overrides = { risk: 'high', dataLoss: true, confirm: 'dbname' };
                out.warnings.push('Abrir com RESETLOGS após restaurar o controlfile: se algum redo log online também estiver perdido, as transações dele são perdidas.');
            }
        },
    },

    'controlfile-multiplex': {
        title: 'Multiplexar o controlfile em outro disco',
        summary: 'Acrescenta uma cópia do controlfile em outro diretório/disco: registra o caminho em CONTROL_FILES (spfile), reinicia em NOMOUNT, o RMAN grava a cópia e o banco volta a abrir.',
        when: 'Prontidão: "Controlfile multiplexado" em alerta (uma só cópia, ou todas no mesmo diretório). Exige parada curta (~1–2 min).',
        category: 'controlfile', risk: 'medium', downtime: true, dataLoss: false, confirm: 'dbname',
        states: ['OPEN', 'MOUNTED'],
        schema(ctx) {
            const cfs = ctx.s.controlFileParam || [];
            const sug = cfs.length && sp.pathStyle(cfs[0]) !== 'asm' ? suggestMirrorDir(ctx.s, cfs, { sub: 'CONTROL_B' }) : { dir: '', otherVolume: false };
            return [{
                name: 'dir', label: 'Diretório da nova cópia', type: 'text', value: ctx.p.dir || sug.dir,
                hint: sug.otherVolume ? 'Sugerido: outro disco, onde o banco já tem arquivos.'
                    : 'Não encontrei outro disco com arquivos do banco: a sugestão fica no mesmo disco, em outro diretório. Se o servidor tiver outro disco, informe uma pasta nele.',
            }];
        },
        build(ctx, out) {
            requireAutomation(ctx, out);
            requireStates(ctx, out, ['OPEN', 'MOUNTED']);
            const cfs = ctx.s.controlFileParam || [];
            if (!cfs.length) throw new PlanError('CONTROL_FILES não foi lido no diagnóstico.');
            if (sp.pathStyle(cfs[0]) === 'asm') {
                out.blockers.push('Controlfile em ASM: o nome OMF da cópia só existe depois de criada — faça a multiplexação manualmente.');
                return;
            }
            const spfile = (ctx.s.params || {}).spfile;
            out.preconditions.push({ ok: !!spfile, label: 'Instância com SPFILE', detail: spfile || 'Usa PFILE (init.ora).' });
            if (!spfile) out.blockers.push('A instância usa PFILE: acrescente o novo caminho em CONTROL_FILES no init.ora e reinicie manualmente.');
            const dir = mirrorDirParam(ctx.p.dir, cfs[0]);
            const bad = badControlfiles(ctx.s);
            const src = cfs.find((c) => !bad.includes(c));
            out.preconditions.push({ ok: !!src, label: 'Cópia de origem (boa)', detail: src || 'Nenhuma.' });
            if (!src) out.blockers.push('Nenhuma cópia do controlfile está boa: use "Recuperar o controlfile".');
            // Nome: segue a numeração atual (CONTROL02.CTL → CONTROL03.CTL).
            const ref = sp.baseName(cfs[cfs.length - 1]);
            const m = /^(.*?)(\d+)(\.[^.]*)?$/.exec(ref);
            const upper = ref === ref.toUpperCase();
            const nums = cfs.map((c) => Number((/(\d+)(?:\.[^.]*)?$/.exec(sp.baseName(c)) || [])[1])).filter(Number.isFinite);
            let n = (nums.length ? Math.max(...nums) : 0) + 1;
            const cands = [];
            for (let i = 0; i < 8; i++, n++) {
                cands.push(m ? `${m[1]}${String(n).padStart(m[2].length, '0')}${m[3] || ''}` : `${upper ? 'CONTROL' : 'control'}${String(n).padStart(2, '0')}${upper ? '.CTL' : '.ctl'}`);
            }
            const target = dir + nextFreeName(dir, cands, new Set(cfs.map(sp.fileKey)));
            if (cfs.some((c) => sp.dirKey(sp.dirOf(c)) === sp.dirKey(dir))) {
                out.blockers.push('O diretório escolhido já tem uma cópia: escolha OUTRO diretório (de preferência em outro disco).');
            }
            const sameVolume = cfs.some((c) => volumeRoot(c) === volumeRoot(dir));
            out.preconditions.push({
                ok: sameVolume ? null : true, label: 'Nova cópia em outro disco',
                detail: sameVolume ? `${volumeRoot(dir)} é o mesmo disco das cópias atuais: protege contra perda/corrupção de um arquivo, não contra falha do disco.` : target,
            });
            out.steps.push(mkdirStep('mkdir', dir, ctx.serverOs));
            out.steps.push(sqlplusStep('param', 'Registrar a nova cópia em CONTROL_FILES (spfile)', [`ALTER SYSTEM SET control_files = ${[...cfs, target].map(lit).join(', ')} SCOPE=SPFILE;`], { note: target }));
            out.steps.push(sqlplusStep('restart', 'Parar o banco (SHUTDOWN IMMEDIATE) e iniciar em NOMOUNT', ["SELECT 'Estado: '||status AS estado FROM v$instance;"], {
                variants: { OPEN: ['SHUTDOWN IMMEDIATE;', 'STARTUP NOMOUNT;'], MOUNTED: ['SHUTDOWN IMMEDIATE;', 'STARTUP NOMOUNT;'], STARTED: [], DOWN: ['STARTUP NOMOUNT;'] },
                restartsInstance: true,
                note: 'SHUTDOWN IMMEDIATE desfaz as transações em andamento e desconecta as sessões: o controlfile fica consistente para a cópia.',
            }));
            out.steps.push(rmanStep('copy', 'Gravar o controlfile em todos os caminhos e montar', [`RESTORE CONTROLFILE FROM ${lit(src || cfs[0])};`, 'ALTER DATABASE MOUNT;'], {
                note: 'O RMAN copia o controlfile atual para TODOS os caminhos de CONTROL_FILES (inclusive o novo).',
            }));
            out.steps.push(sqlplusStep('open', 'Abrir o banco', ['ALTER DATABASE OPEN;'], { restartsInstance: true }));
            out.warnings.push('O banco fica fora do ar durante a troca (~1–2 min): avise os usuários ou faça em janela de manutenção.');
            out.warnings.push('Se algum passo falhar depois de alterar CONTROL_FILES, use "Recuperar o controlfile" (cópia boa): ele grava a cópia em todos os caminhos e abre o banco.');
            if (ctx.serverOs === 'windows' && config.oracleServer.tnsAlias) {
                out.warnings.push('No Windows, conectando pelo alias TNS, o RMAN só alcança a instância em NOMOUNT se o SID estiver registrado ESTATICAMENTE no listener (SID_LIST_LISTENER).');
            }
        },
    },

    // ---------------------------------------------------------------- proteção
    'flashback-on': {
        title: 'Ativar o Flashback Database',
        summary: 'Liga o Flashback Database: um erro lógico (DELETE/UPDATE indevido, deploy ruim) se desfaz voltando o banco no tempo em minutos, sem restore. Com o banco no ar (11gR2+).',
        when: 'Prontidão: "Flashback Database" desligado. Exige Enterprise Edition, ARCHIVELOG e FRA configurada.',
        category: 'protection', risk: 'low', downtime: false, dataLoss: false, confirm: 'ack',
        states: ['OPEN', 'MOUNTED'],
        schema: (ctx) => [{
            name: 'retentionMin', label: 'Janela de retenção (minutos)', type: 'number', min: 60, max: 43200,
            value: ctx.p.retentionMin != null ? Number(ctx.p.retentionMin) : 1440,
            hint: '1440 = 24 h (padrão do Oracle): até quanto tempo atrás dá para voltar. Quanto maior, mais espaço na FRA.',
        }],
        build(ctx, out) {
            requireStates(ctx, out, ['OPEN', 'MOUNTED']);
            const s = ctx.s;
            if (s.database && s.database.flashbackOn === 'YES') out.blockers.push('O Flashback Database já está ativo.');
            const ee = s.edition === 'EE';
            out.preconditions.push({ ok: s.edition ? ee : null, label: 'Enterprise Edition', detail: s.banner || (s.edition ? `Edição: ${s.edition}` : 'Edição não identificada.') });
            if (s.edition && !ee) out.blockers.push('Flashback Database é exclusivo da Enterprise Edition. Na Standard Edition, para erros pontuais use Flashback Query/Table; para o banco inteiro, backups.');
            requireArchivelog(ctx, out, 'Flashback Database exige o banco em ARCHIVELOG.');
            const fraDest = (s.params || {}).db_recovery_file_dest || (s.fra && s.fra.dest);
            out.preconditions.push({ ok: !!fraDest, label: 'FRA configurada', detail: fraDest || 'DB_RECOVERY_FILE_DEST vazio.' });
            if (!fraDest) out.blockers.push('Configure a FRA primeiro (Backup → Configuração de Backup): os logs de flashback ficam nela.');
            if (s.fra) out.preconditions.push({ ok: s.fra.usedPct < 75 ? true : null, label: 'Espaço na FRA', detail: `${s.fra.usedPct}% usada de ${Math.round(s.fra.limitMb / 1024)} GB.` });
            const ver = s.instance && s.instance.version;
            if (ctx.state === 'OPEN' && ver && !versionAtLeast(ver, 11, 2)) out.blockers.push('Antes do 11gR2 o Flashback só liga com o banco montado (não aberto): faça em janela de manutenção.');
            const min = intParam(ctx.p.retentionMin != null ? ctx.p.retentionMin : 1440, 'Janela de retenção', 60, 43200);
            const scope = (s.params || {}).spfile ? 'BOTH' : 'MEMORY';
            if (scope === 'MEMORY') out.warnings.push('A instância usa PFILE: ajuste DB_FLASHBACK_RETENTION_TARGET também no init.ora, senão volta ao padrão no próximo reinício.');
            out.steps.push(flexStep(ctx, 'on', 'Definir a retenção e ligar o Flashback Database', [
                `ALTER SYSTEM SET db_flashback_retention_target = ${min} SCOPE=${scope}`,
                'ALTER DATABASE FLASHBACK ON',
            ]));
            out.warnings.push('Os logs de flashback ocupam a FRA (em geral algo perto do redo gerado na janela) e somam um pouco de I/O. O guardião da FRA acompanha o espaço; sem restore point garantido, o Oracle apaga os logs de flashback mais antigos quando falta espaço.');
        },
    },

    // ---------------------------------------------------------------- undo / temp / dicionário
    'undo-recreate': {
        title: 'Recriar a tablespace de UNDO',
        summary: 'Cria um UNDO novo, passa o banco a usá-lo e (opcional) remove o antigo depois que as transações terminarem.',
        when: 'ORA-00600 [4194]/[4193]/[4137], ORA-01552, datafile de undo corrompido/offline com o banco aberto.',
        category: 'undo', risk: 'medium', downtime: false, dataLoss: false, confirm: 'ack',
        states: ['OPEN'],
        schema: (ctx) => [
            { name: 'sizeMb', label: 'Tamanho inicial (MB)', type: 'number', min: 100, max: 32767, value: ctx.p.sizeMb != null ? Number(ctx.p.sizeMb) : 2048 },
            { name: 'dropOld', label: 'Remover o UNDO antigo ao final (só se não houver transações pendentes nele)', type: 'checkbox', value: bool(ctx.p.dropOld, false) },
        ],
        build(ctx, out) {
            requireStates(ctx, out, ['OPEN']);
            const s = ctx.s;
            const oldTs = String((s.params || {}).undo_tablespace || '').toUpperCase();
            if (!oldTs) throw new PlanError('UNDO_TABLESPACE não está definido (undo manual?): procedimento manual.');
            const names = new Set((s.datafiles || []).map((d) => String(d.ts || '').toUpperCase()));
            let i = 2;
            let newTs = 'UNDOTBS2';
            while (names.has(newTs) && i < 99) newTs = `UNDOTBS${++i}`;
            const ref = newestFile((s.datafiles || []).filter((d) => String(d.ts || '').toUpperCase() === oldTs)) || newestFile(s.datafiles || []);
            const target = siblingPath(ref && ref.name, newTs, s);
            const size = intParam(ctx.p.sizeMb != null ? ctx.p.sizeMb : 2048, 'Tamanho (MB)', 100, 32767);
            const file = lit(target.path);
            const scope = (s.params || {}).spfile ? 'BOTH' : 'MEMORY';
            if (scope === 'MEMORY') out.warnings.push('A instância usa PFILE: atualize UNDO_TABLESPACE no init.ora, senão o banco volta ao undo antigo no próximo reinício.');
            out.steps.push(flexStep(ctx, 'create', `Criar a tablespace ${newTs}`, [`CREATE UNDO TABLESPACE ${ident(newTs)} DATAFILE ${file} SIZE ${size}M AUTOEXTEND ON NEXT 100M MAXSIZE UNLIMITED`], { note: target.path }));
            out.steps.push(flexStep(ctx, 'switch', `Passar a usar ${newTs}`, [`ALTER SYSTEM SET undo_tablespace = '${newTs}' SCOPE=${scope}`]));
            if (bool(ctx.p.dropOld, false)) {
                out.steps.push(flexStep(ctx, 'drop', `Remover ${oldTs} (se não houver transações pendentes)`, [
                    `DECLARE n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM dba_rollback_segs WHERE tablespace_name = '${oldTs}' AND status NOT IN ('OFFLINE'); IF n > 0 THEN RAISE_APPLICATION_ERROR(-20001, 'Ainda ha ' || n || ' segmento(s) de undo ativos em ${oldTs}: aguarde as transacoes terminarem e rode de novo.'); END IF; END;`,
                    `DROP TABLESPACE ${ident(oldTs)} INCLUDING CONTENTS AND DATAFILES`,
                ]));
                const pend = (s.undoSegs || []).filter((u) => String(u.ts).toUpperCase() === oldTs && /NEEDS RECOVERY|PARTLY AVAILABLE/i.test(u.status || ''));
                if (pend.length) out.blockers.push(`Há segmentos de undo em ${oldTs} com status ${pend.map((p) => p.status).join(', ')}: a remoção exige procedimento assistido pela Oracle. Desmarque "Remover o UNDO antigo".`);
            }
        },
    },

    'temp-recreate': {
        title: 'Recriar tempfile',
        summary: 'Adiciona um tempfile novo e remove os inválidos. Tempfiles não guardam dados: sem risco.',
        when: 'ORA-01157/ORA-01187 em tempfile, ORA-25153 (TEMP vazia), após restore/clone.',
        category: 'space', risk: 'low', downtime: false, dataLoss: false, confirm: 'simple',
        states: ['OPEN'],
        schema(ctx) {
            const tss = [...new Set((ctx.s.tempfiles || []).map((t) => t.ts).filter(Boolean))];
            if (!tss.length) tss.push(ctx.s.defaultTemp || 'TEMP');
            const bad = badTempfiles(ctx.s);
            return [
                { name: 'ts', label: 'Tablespace temporária', type: 'select', options: tss.map((t) => ({ value: t, label: t })), value: ctx.p.ts || tss[0] },
                { name: 'sizeMb', label: 'Tamanho do novo tempfile (MB)', type: 'number', min: 100, max: 32767, value: ctx.p.sizeMb != null ? Number(ctx.p.sizeMb) : 1024 },
                { name: 'dropBad', label: bad.length ? `Remover os tempfiles com erro (${bad.length})` : 'Remover tempfiles com erro (nenhum identificado)', type: 'checkbox', value: bool(ctx.p.dropBad, bad.length > 0) },
            ];
        },
        build(ctx, out) {
            requireStates(ctx, out, ['OPEN']);
            const ts = String(ctx.p.ts || ((ctx.s.tempfiles || [])[0] || {}).ts || ctx.s.defaultTemp || 'TEMP');
            const tsId = ident(ts, 'Tablespace');
            const own = (ctx.s.tempfiles || []).filter((t) => String(t.ts).toUpperCase() === ts.toUpperCase());
            const ref = newestFile(own) || newestFile((ctx.s.datafiles || []).filter((d) => d.ts === 'SYSTEM'));
            const target = siblingPath(ref && ref.name, ts.toLowerCase(), ctx.s);
            const size = intParam(ctx.p.sizeMb != null ? ctx.p.sizeMb : 1024, 'Tamanho (MB)', 100, 32767);
            const sqls = [`ALTER TABLESPACE ${tsId} ADD TEMPFILE ${lit(target.path)} SIZE ${size}M${target.omf ? '' : ' REUSE'} AUTOEXTEND ON NEXT 100M MAXSIZE UNLIMITED`];
            if (bool(ctx.p.dropBad, true)) {
                for (const t of badTempfiles(ctx.s)) sqls.push(`ALTER DATABASE TEMPFILE ${lit(t)} DROP INCLUDING DATAFILES`);
            }
            out.steps.push(flexStep(ctx, 'temp', `Recriar tempfile da ${ts}`, sqls, { note: target.path }));
        },
    },

    'recompile-invalid': {
        title: 'Recompilar objetos inválidos',
        summary: 'Executa o utlrp.sql (recompila tudo o que ficou inválido após recuperação, patch ou alteração de dicionário).',
        when: 'Objetos inválidos em SYS/SYSTEM ou nas aplicações após uma recuperação.',
        category: 'recovery', risk: 'low', downtime: false, dataLoss: false, confirm: 'simple',
        states: ['OPEN'],
        schema: () => [],
        build(ctx, out) {
            requireStates(ctx, out, ['OPEN']);
            if (ctx.automation) {
                out.steps.push(sqlplusStep('utlrp', 'Recompilar (utlrp.sql)', ['@?/rdbms/admin/utlrp.sql', "SELECT 'Invalidos restantes: '||COUNT(*) AS restantes FROM dba_objects WHERE status = 'INVALID';"], { note: 'Usa CPU por alguns minutos.' }));
            } else {
                const owners = ((ctx.s.invalid || {}).byOwner || []).map((o) => o.owner).filter((o) => o && !['SYS', 'SYSTEM'].includes(o)).slice(0, 8);
                if (!owners.length) out.blockers.push('Sem acesso ao servidor só dá para recompilar esquemas de aplicação, e não há objetos inválidos fora de SYS/SYSTEM.');
                out.steps.push(sqlStep('compile', 'Recompilar os esquemas com inválidos', owners.map((o) => ({ sql: `BEGIN DBMS_UTILITY.COMPILE_SCHEMA(schema => '${String(ident(o)).slice(1, -1)}', compile_all => FALSE); END;`, plsql: true }))));
            }
        },
    },
};

// ==========================================================================
// Helpers que leem o diagnóstico
// ==========================================================================

function affectedFiles(s) {
    const set = new Set();
    for (const c of s.corruption || []) set.add(c.fileNo);
    for (const c of s.corruptSegments || []) set.add(c.fileNo);
    return [...set].filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
}

function indexCandidates(s) {
    const out = [];
    for (const c of s.corruptSegments || []) {
        if (c.segment && /INDEX/.test(c.segment.type || '')) {
            const v = `${c.segment.owner}.${c.segment.name}`;
            if (!out.includes(v)) out.push(v);
        }
    }
    return out;
}

function badMemberFromAlert(s, p) {
    for (const g of (s.alert && s.alert.groups) || []) {
        if (['ORA-00313', 'ORA-00321', 'ORA-00354', 'ORA-00353', 'ORA-00316', 'ORA-00327'].includes(g.code) && g.logs.some((l) => l.path === p)) return true;
    }
    return false;
}

function badControlfiles(s) {
    const out = (s.controlfiles || []).filter((c) => c.status === 'INVALID').map((c) => c.name);
    for (const g of (s.alert && s.alert.groups) || []) for (const c of g.controlfiles) if (!out.includes(c)) out.push(c);
    return out;
}

function badTempfiles(s) {
    const temps = new Map((s.tempfiles || []).map((t) => [sp.fileKey(t.name), t.name]));
    const out = [];
    for (const g of (s.alert && s.alert.groups) || []) {
        if (!['ORA-01157', 'ORA-01187', 'ORA-01110', 'ORA-01116'].includes(g.code)) continue;
        for (const f of g.files) {
            const name = f.path && temps.get(sp.fileKey(f.path));
            if (name && !out.includes(name)) out.push(name);
        }
    }
    return out;
}

function fraSuggestedGb(fra) {
    if (!fra || !fra.limitMb) return 10;
    const used = Math.max(0, fra.usedMb - (fra.reclaimableMb || 0));
    const target = used / 0.7;
    const addMb = Math.max(target - fra.limitMb, fra.limitMb * 0.1, 5 * 1024);
    return Math.ceil(addMb / 1024);
}

// ==========================================================================
// Montagem do plano
// ==========================================================================

function hashPlan(id, params, steps, overrides) {
    const core = steps.map((s) => ({
        id: s.id, title: s.title, channel: s.channel, lines: s.lines || null, pre: s.pre || null,
        statements: s.statements || null, variants: s.variants || null, args: s.args || null,
    }));
    return crypto.createHash('sha256').update(JSON.stringify({ id, params, core, overrides: overrides || null })).digest('hex').slice(0, 32);
}

/** Texto de um passo para exibição/cópia, no estado informado. */
function renderStep(st, state) {
    const variant = st.variants ? st.variants[state] : [];
    if (st.variants && variant === undefined) return null;
    if (st.channel === 'sql') return st.statements.map((x) => (x.plsql ? `${x.sql}\n/` : `${x.sql};`));
    if (st.channel === 'sqlplus') return [...(variant || []), ...st.lines];
    if (st.channel === 'rman') {
        const body = [...(variant || []), ...st.lines];
        return [...(st.pre || []), 'RUN {', ...body.map((l) => `  ${l}`), '}'];
    }
    return st.lines.slice();
}

function connectHint(channel) {
    const alias = config.oracleServer.tnsAlias ? `@${config.oracleServer.tnsAlias}` : '';
    const u = config.oracleServer.sysUser || 'sys';
    if (channel === 'rman') return config.oracleServer.usesPasswordAuth ? `rman target ${u}/<senha>${alias}` : 'rman target /';
    if (channel === 'sqlplus') return config.oracleServer.usesPasswordAuth ? `sqlplus ${u}/<senha>${alias} as sysdba` : 'sqlplus / as sysdba';
    if (channel === 'sql') return `-- como ${config.db.user || 'usuário DBA'} (ou sqlplus / as sysdba)`;
    if (channel === 'os') return '# PowerShell como Administrador no servidor';
    return '# no servidor, como o dono do Oracle';
}

/** Catálogo resumido para a interface. */
function catalogList() {
    return Object.entries(CATALOG).map(([id, p]) => ({
        id, title: p.title, summary: p.summary, when: p.when, category: p.category,
        risk: p.risk, riskLabel: RISK_LABEL[p.risk], downtime: p.downtime, dataLoss: p.dataLoss, states: p.states,
    }));
}

/**
 * Monta o plano de um procedimento para o diagnóstico atual.
 * @param {string} id
 * @param {object} params
 * @param {object} signals  diagnóstico (collect/demo)
 * @param {object} env      { indexInfo(owner,name), diskFor(path), now }
 */
async function buildPlan(id, params, signals, env = {}) {
    const def = CATALOG[id];
    if (!def) throw new PlanError(`Procedimento desconhecido: ${id}`, 404);
    const s = signals || {};
    const ctx = {
        s,
        p: { ...(params || {}) },
        state: s.state || 'UNKNOWN',
        serverOs: (s.capabilities && s.capabilities.serverOs) || s.serverOs || null,
        automation: config.demoMode || !!(s.capabilities ? s.capabilities.automation : config.oracleServer.rmanAutomationReady),
        sid: config.oracleServer.sid || (s.instance && s.instance.name) || null,
        snapshot: s.snapshot || null,
        // Só a data: o plano revisado e o executado precisam ter o mesmo texto (hash).
        stamp: env.stamp || new Date().toISOString().slice(0, 10).replace(/-/g, ''),
        indexInfo: env.indexInfo || (async () => null),
        diskFor: env.diskFor || (async (p) => storage.getDiskForPath(p).catch((e) => ({ error: e.message }))),
    };
    // Parâmetros efetivos = só os campos do formulário (o schema já aplica o valor
    // enviado ou o padrão). Chaves desconhecidas são descartadas.
    const effective = {};
    for (const f of def.schema(ctx)) effective[f.name] = f.type === 'checkbox' ? bool(ctx.p[f.name], f.value) : f.value;
    ctx.p = effective;

    const out = { steps: [], preconditions: [], blockers: [], warnings: [], overrides: null, manualOnly: false };
    try {
        await def.build(ctx, out);
    } catch (err) {
        // Sem dados do dicionário (instância parada/NOMOUNT) a validação dos
        // parâmetros falha: o que vale mostrar é o motivo do bloqueio.
        if (!(err instanceof PlanError)) throw err;
        if (ctx.state !== 'UNKNOWN' && !def.states.includes(ctx.state)) {
            if (!out.blockers.length) out.blockers.push(`Este procedimento não se aplica com a instância ${STATE_LABEL[ctx.state]}.`);
            out.steps = [];
        } else if (out.blockers.length) {
            out.steps = [];
        } else {
            throw err;
        }
    }
    const needsServer = out.steps.some((st) => st.channel !== 'sql');
    if (needsServer && !ctx.automation && !out.preconditions.some((p) => p.label.startsWith('Execução no servidor'))) requireAutomation(ctx, out);

    const meta = { ...def, ...(out.overrides || {}) };
    const dbName = (s.database && s.database.name) || (s.snapshot && s.snapshot.dbName) || (s.instance && s.instance.name) || null;

    const viewState = ctx.state === 'UNKNOWN' ? 'DOWN' : ctx.state;
    const steps = out.steps.map((st, i) => {
        const lines = renderStep(st, viewState);
        const otherStates = st.variants ? Object.keys(st.variants).filter((k) => k !== viewState) : [];
        return {
            n: i + 1, id: st.id, title: st.title, channel: st.channel, channelLabel: CHANNEL_LABEL[st.channel] || st.channel,
            note: st.note || null,
            script: lines ? lines.join('\n') : null,
            adapts: st.variants ? `Adapta-se ao estado da instância no momento da execução (${['DOWN', 'STARTED', 'MOUNTED', 'OPEN'].filter((k) => st.variants[k] !== undefined).map((k) => STATE_LABEL[k]).join(', ')}).` : null,
            invalidNow: lines === null,
            otherStates,
        };
    });
    if (steps.some((x) => x.invalidNow)) out.blockers.push(`Algum passo não se aplica com a instância ${STATE_LABEL[ctx.state]}.`);

    const channelsReady = !needsServer || ctx.automation;
    const sqlReady = !out.steps.some((st) => st.channel === 'sql') || (ctx.state === 'OPEN' && s.connection && s.connection.ok) || config.demoMode;
    if (!sqlReady) out.blockers.push('Passos pela conexão do painel exigem o banco aberto e acessível.');

    const manual = out.steps.map((st, i) => {
        const lines = renderStep(st, viewState) || renderStep(st, Object.keys(st.variants || {})[0]) || [];
        return [`-- Passo ${i + 1}: ${st.title}`, connectHint(st.channel), ...lines].join('\n');
    }).join('\n\n');

    const hash = hashPlan(id, ctx.p, out.steps, out.overrides);
    return {
        playbook: { id, title: def.title, summary: def.summary, when: def.when, category: def.category, risk: meta.risk, riskLabel: RISK_LABEL[meta.risk], downtime: meta.downtime, dataLoss: meta.dataLoss },
        state: ctx.state, stateLabel: STATE_LABEL[ctx.state],
        params: ctx.p,
        paramsSchema: def.schema(ctx),
        steps,
        preconditions: out.preconditions,
        blockers: [...new Set(out.blockers)],
        warnings: out.warnings,
        executable: out.blockers.length === 0 && channelsReady && sqlReady && out.steps.length > 0,
        manualOnly: out.manualOnly,
        confirm: { level: meta.confirm, dbName },
        manual,
        hash,
        internal: { steps: out.steps, params: ctx.p },
    };
}

module.exports = {
    CATALOG, PlanError, STATE_LABEL, RISK_LABEL, CHANNEL_LABEL,
    catalogList, buildPlan, renderStep, hashPlan,
    // helpers (testes)
    lit, ident, fraSuggestedGb, badTempfiles, badControlfiles, affectedFiles, indexCandidates, volumeRoot, suggestMirrorDir,
};

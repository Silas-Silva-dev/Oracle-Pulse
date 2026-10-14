/**
 * TIMESYNC.JS - Relógio do servidor de banco x NTP.
 *
 *  - Mede a diferença entre a hora do SERVIDOR DE BANCO (SYSTIMESTAMP, que é a
 *    hora do SO onde o Oracle roda) e um servidor NTP. O painel consulta o NTP
 *    por SNTP (UDP 123) e usa o próprio relógio só como intermediário: os erros
 *    do relógio do painel se cancelam.
 *  - Sincroniza o relógio do servidor com o NTP, em Linux ou Windows:
 *      Linux  (via SSH ou local): usa o serviço de horário que existir
 *             (chrony, ntpd, systemd-timesyncd), deixando-o configurado com o
 *             servidor NTP; sem serviço, faz um ajuste único (chronyd -q,
 *             ntpdate, sntp).
 *      Windows (local ou via SSH): configura e ressincroniza o serviço Horário
 *             do Windows (w32time). Em membro de domínio, respeita a hierarquia
 *             do domínio (o DC é a fonte de hora do Kerberos).
 *    Depois mede de novo. Se a ferramenta do SO não corrigiu (sem acesso ao NTP
 *    a partir do servidor, limite de correção do w32time etc.), aplica o ajuste
 *    medido pelo painel (date -s / Set-Date) — exceto em membro de domínio.
 */
const dgram = require('dgram');
const { config } = require('./config');
const { getConnection, tag } = require('./db');
const { detectServerOs, execOnServer, psEncoded } = require('./osDisk');
const demoClock = require('./demoClock');
const audit = require('./audit');
const logger = require('./logger');

const DEFAULT_SERVERS = ['a.st1.ntp.br', 'b.st1.ntp.br', 'pool.ntp.org'];
const NTP_EPOCH_OFFSET_S = 2208988800; // segundos entre 01/01/1900 (NTP) e 01/01/1970 (Unix)
const SYNC_TOLERANCE_MS = 1500;        // abaixo disso consideramos sincronizado
const STATUS_TTL_MS = 60000;

class TimeSyncError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// ==========================================================================
// Servidores NTP (config + validação)
// ==========================================================================

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Valida um nome/IP de servidor NTP. Só letras, dígitos, ponto e hífen: o nome entra em scripts de SO. */
function validateNtpHost(value) {
    const h = String(value == null ? '' : value).trim();
    if (!HOST_RE.test(h)) throw new TimeSyncError(`Servidor NTP inválido: "${h.slice(0, 80)}". Use um nome (ex.: a.st1.ntp.br) ou um IPv4.`);
    return h.toLowerCase();
}

/** Lista de NTP_SERVERS do .env (separados por vírgula/espaço); inválidos são ignorados. */
function ntpServers(raw = process.env.NTP_SERVERS) {
    const list = String(raw || '').split(/[\s,;]+/).filter(Boolean);
    const valid = [];
    for (const h of list) {
        try {
            const v = validateNtpHost(h);
            if (!valid.includes(v)) valid.push(v);
        } catch { /* ignora entrada inválida do .env */ }
    }
    return valid.length ? valid : DEFAULT_SERVERS.slice();
}

// ==========================================================================
// Cliente SNTP (RFC 4330) — funções puras de pacote + consulta UDP
// ==========================================================================

function writeNtpTime(buf, offset, ms) {
    const secs = Math.floor(ms / 1000) + NTP_EPOCH_OFFSET_S;
    const frac = Math.min(0xffffffff, Math.round(((ms % 1000) / 1000) * 0x100000000));
    buf.writeUInt32BE(secs % 0x100000000, offset);
    buf.writeUInt32BE(frac >>> 0, offset + 4);
}

function readNtpTime(buf, offset) {
    let secs = buf.readUInt32BE(offset);
    const frac = buf.readUInt32BE(offset + 4);
    // Era 1 do NTP começa em 2036: valores com o bit alto zerado já são da era seguinte.
    if (secs < 0x80000000) secs += 0x100000000;
    return (secs - NTP_EPOCH_OFFSET_S) * 1000 + (frac / 0x100000000) * 1000;
}

/** Pacote de requisição SNTP v4 (modo cliente) com o transmit timestamp = t1. */
function buildSntpRequest(t1 = Date.now()) {
    const b = Buffer.alloc(48);
    b[0] = (0 << 6) | (4 << 3) | 3; // LI=0, VN=4, Mode=3 (cliente)
    writeNtpTime(b, 40, t1);
    return b;
}

/**
 * Interpreta a resposta SNTP. t1 = envio, t4 = recebimento (relógio local, ms).
 * offsetMs = hora do NTP − hora local; delayMs = atraso de ida e volta.
 */
function parseSntpResponse(msg, t1, t4) {
    if (!Buffer.isBuffer(msg) || msg.length < 48) throw new Error('resposta NTP curta demais');
    const li = msg[0] >> 6;
    const mode = msg[0] & 7;
    const stratum = msg[1];
    if (mode !== 4 && mode !== 5) throw new Error(`resposta NTP inválida (modo ${mode})`);
    if (stratum === 0) {
        const kod = msg.toString('ascii', 12, 16).replace(/[^\x20-\x7e]/g, '');
        throw new Error(`o servidor NTP recusou a consulta (Kiss-o'-Death ${kod || '?'})`);
    }
    if (li === 3) throw new Error('o servidor NTP não está sincronizado (LI=3)');
    const t2 = readNtpTime(msg, 32);
    const t3 = readNtpTime(msg, 40);
    const offsetMs = ((t2 - t1) + (t3 - t4)) / 2;
    const delayMs = Math.max(0, (t4 - t1) - (t3 - t2));
    const refId = stratum === 1
        ? msg.toString('ascii', 12, 16).replace(/[^\x20-\x7e]/g, '')
        : `${msg[12]}.${msg[13]}.${msg[14]}.${msg[15]}`;
    return { offsetMs, delayMs, stratum, refId, leap: li };
}

/** Consulta um servidor NTP por UDP. */
function sntpQuery(host, { timeoutMs = 2500 } = {}) {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        let done = false;
        let t1 = 0;
        const finish = (err, val) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { sock.close(); } catch { /* já fechado */ }
            if (err) reject(err); else resolve(val);
        };
        const timer = setTimeout(() => finish(new Error(`sem resposta em ${Math.round(timeoutMs / 1000)} s (UDP 123 bloqueado?)`)), timeoutMs);
        sock.on('error', (err) => finish(err));
        sock.on('message', (msg) => {
            const t4 = Date.now();
            try { finish(null, { server: host, ...parseSntpResponse(msg, t1, t4) }); } catch (err) { finish(err); }
        });
        t1 = Date.now();
        sock.send(buildSntpRequest(t1), 123, host, (err) => {
            if (err) finish(err.code === 'ENOTFOUND' ? new Error('nome não encontrado (DNS)') : err);
        });
    });
}

/** Tenta os servidores em ordem; usa a melhor de 2 amostras do primeiro que responder. */
async function queryNtp(servers) {
    const errors = [];
    for (const host of servers) {
        try {
            const a = await sntpQuery(host);
            let best = a;
            try {
                const b = await sntpQuery(host);
                if (b.delayMs < a.delayMs) best = b;
            } catch { /* a primeira amostra basta */ }
            return { ok: true, ...best, errors };
        } catch (err) {
            errors.push(`${host}: ${err.message}`);
        }
    }
    return { ok: false, server: servers[0], errors, error: errors.join(' · ') };
}

// ==========================================================================
// Hora do servidor de banco (SYSTIMESTAMP)
// ==========================================================================

const DB_CLOCK_SQL = `SELECT TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS ts,
       TO_CHAR(SYSDATE, 'DD/MM/YYYY HH24:MI:SS') AS local_time
  FROM dual`;

/**
 * Lê a hora do banco 3 vezes e usa a amostra de menor tempo de resposta
 * (o ponto médio da ida e volta é a melhor estimativa do instante lido).
 */
async function measureDbClock() {
    if (config.demoMode) {
        const t = Date.now();
        return { epochMs: demoClock.now(), panelMidMs: t, rttMs: 1, tz: '-03:00', localTime: demoClock.formatted() };
    }
    const conn = await getConnection();
    try {
        let best = null;
        for (let i = 0; i < 3; i++) {
            const t1 = Date.now();
            const r = await conn.execute(tag(DB_CLOCK_SQL));
            const t2 = Date.now();
            const row = r.rows[0] || {};
            const iso = row.TS || row.ts;
            const epochMs = Date.parse(iso);
            if (!Number.isFinite(epochMs)) throw new Error(`hora do banco ilegível: ${iso}`);
            const sample = { epochMs, panelMidMs: (t1 + t2) / 2, rttMs: t2 - t1, tz: String(iso).slice(-6), localTime: row.LOCAL_TIME || row.local_time };
            if (!best || sample.rttMs < best.rttMs) best = sample;
        }
        return best;
    } finally {
        try { await conn.close(); } catch { /* ignore */ }
    }
}

// ==========================================================================
// Status (cacheado) — usado pelo selo ao lado da hora do servidor
// ==========================================================================

let statusCache = null; // { at, server, value }
let syncing = false;

async function measure(server) {
    const servers = ntpServers();
    const order = server ? [server, ...servers.filter((s) => s !== server)] : servers;
    const [dbRes, ntp] = await Promise.all([
        measureDbClock().then((v) => ({ v }), (err) => ({ err })),
        queryNtp(order),
    ]);
    const db = dbRes.v || null;
    const dbVsPanel = db ? db.epochMs - db.panelMidMs : null;
    const offsetMs = db && ntp.ok ? dbVsPanel - ntp.offsetMs : null;
    let serverOs = null;
    try { serverOs = config.demoMode ? 'linux' : await detectServerOs(); } catch { /* desconhecido */ }
    return {
        measuredAt: new Date().toISOString(),
        server: db ? { localTime: db.localTime, tz: db.tz, epochMs: Math.round(db.epochMs), rttMs: db.rttMs } : null,
        serverError: dbRes.err ? dbRes.err.message : null,
        ntp: ntp.ok
            ? { ok: true, server: ntp.server, stratum: ntp.stratum, refId: ntp.refId, delayMs: Math.round(ntp.delayMs), errors: ntp.errors }
            : { ok: false, server: ntp.server, error: ntp.error, errors: ntp.errors },
        offsetMs: offsetMs == null ? null : Math.round(offsetMs),
        panelOffsetMs: ntp.ok ? Math.round(-ntp.offsetMs) : null,
        servers,
        defaultServer: servers[0],
        serverOs,
        syncing,
        tolerance: SYNC_TOLERANCE_MS,
    };
}

async function getStatus({ force = false, server = null } = {}) {
    const key = server || '';
    if (!force && statusCache && statusCache.key === key && Date.now() - statusCache.at < STATUS_TTL_MS) {
        return { ...statusCache.value, syncing };
    }
    const value = await measure(server);
    statusCache = { key, at: Date.now(), value };
    return value;
}

// ==========================================================================
// Scripts de sincronização (puros — testáveis)
// ==========================================================================

/** Cabeçalho comum dos scripts sh: PATH com sbin, locale C, sudo quando não é root. */
function shPrelude() {
    return [
        '#!/bin/sh',
        'LC_ALL=C; export LC_ALL',
        'PATH="$PATH:/usr/sbin:/sbin:/usr/bin:/bin"; export PATH',
        'say() { echo "@@OP:$1:$2"; }',
        'has() { command -v "$1" >/dev/null 2>&1; }',
        'indent() { sed "s/^/    /"; }',
        'runq() { OUT=$("$@" 2>&1); RC=$?; [ -n "$OUT" ] && echo "$OUT" | indent; return $RC; }',
        'SUDO=""',
        'if [ "$(id -u)" != "0" ]; then',
        '  if has sudo && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; else say ERR NOROOT; exit 3; fi',
        'fi',
    ];
}

/** Script sh (Linux) que sincroniza com o NTP usando o serviço de horário disponível. */
function buildLinuxSyncScript(server) {
    const ntp = validateNtpHost(server);
    return [
        ...shPrelude(),
        `NTP='${ntp}'`,
        'active() { has systemctl && systemctl is-active --quiet "$1" 2>/dev/null; }',
        'tmo() { if has timeout; then timeout 40 "$@"; else "$@"; fi; }',
        'hasline() { [ -f "$2" ] && grep -E "^[[:space:]]*(server|pool)[[:space:]]" "$2" | grep -qF "$1"; }',
        'addline() { if [ -f "$1" ] && ! hasline "$NTP" "$1"; then echo "server $NTP iburst" | $SUDO tee -a "$1" >/dev/null && say PERSIST "$1" && RESTART=1; fi; }',
        'METHOD=none; OK=1; RESTART=0',
        'if active chronyd || active chrony || pgrep -x chronyd >/dev/null 2>&1; then',
        '  METHOD=chrony',
        '  CONF=/etc/chrony.conf; [ -f /etc/chrony/chrony.conf ] && CONF=/etc/chrony/chrony.conf',
        '  addline "$CONF"',
        '  say STEP chrony-add',
        '  runq $SUDO chronyc -a "add server $NTP iburst"',
        '  say STEP chrony-burst',
        '  runq $SUDO chronyc -a "burst 4/4"',
        '  sleep 8',
        '  say STEP chrony-makestep',
        '  if runq $SUDO chronyc -a makestep; then OK=0; fi',
        '  runq chronyc tracking',
        'elif active ntpd || active ntp || pgrep -x ntpd >/dev/null 2>&1; then',
        '  METHOD=ntpd',
        '  UNIT=ntpd; active ntp && UNIT=ntp',
        '  addline /etc/ntp.conf',
        '  if has ntpdate; then say STEP ntpdate; runq tmo $SUDO ntpdate -u -b "$NTP" && OK=0',
        '  elif has sntp; then say STEP sntp; runq tmo $SUDO sntp -S "$NTP" && OK=0; fi',
        '  if [ $OK != 0 ] && has ntpd; then',
        '    say STEP ntpd-gq',
        '    runq $SUDO systemctl stop "$UNIT" || runq $SUDO service "$UNIT" stop',
        '    runq tmo $SUDO ntpd -gq && OK=0',
        '    RESTART=1',
        '  fi',
        '  if [ $RESTART = 1 ]; then say STEP ntpd-restart; runq $SUDO systemctl restart "$UNIT" || runq $SUDO service "$UNIT" restart; fi',
        'elif has timedatectl && { active systemd-timesyncd || [ -f /lib/systemd/system/systemd-timesyncd.service ] || [ -f /usr/lib/systemd/system/systemd-timesyncd.service ]; }; then',
        '  METHOD=timesyncd',
        '  $SUDO mkdir -p /etc/systemd/timesyncd.conf.d',
        '  { echo "[Time]"; echo "NTP=$NTP"; } | $SUDO tee /etc/systemd/timesyncd.conf.d/oracle-pulse.conf >/dev/null && say PERSIST /etc/systemd/timesyncd.conf.d/oracle-pulse.conf',
        '  say STEP timesyncd-restart',
        '  runq $SUDO timedatectl set-ntp true',
        '  runq $SUDO systemctl restart systemd-timesyncd',
        '  sleep 3; i=0',
        '  while [ $i -lt 20 ]; do',
        '    if timedatectl status 2>/dev/null | grep -Eiq "synchronized: *yes"; then OK=0; break; fi',
        '    sleep 1; i=$((i+1))',
        '  done',
        'else',
        '  if has chronyd; then METHOD=chronyd; say STEP chronyd-q; runq tmo $SUDO chronyd -q "server $NTP iburst" && OK=0',
        '  elif has ntpdate; then METHOD=ntpdate; say STEP ntpdate; runq tmo $SUDO ntpdate -u -b "$NTP" && OK=0',
        '  elif has sntp; then METHOD=sntp; say STEP sntp; runq tmo $SUDO sntp -S "$NTP" && OK=0; fi',
        'fi',
        'if [ $OK = 0 ] && has hwclock && $SUDO hwclock --systohc >/dev/null 2>&1; then say STEP hwclock; fi',
        'say METHOD "$METHOD"',
        'if [ $OK = 0 ]; then say RESULT ok; else say RESULT fail; fi',
        'exit 0',
    ].join('\n') + '\n';
}

/** Ajuste direto (Linux): soma `addMs` ao relógio atual do servidor. */
function buildLinuxStepScript(addMs) {
    const secs = checkedOffset(addMs) / 1000;
    return [
        ...shPrelude(),
        'NOW=$(date +%s.%N 2>/dev/null)',
        'case "$NOW" in *N*|"") NOW=$(date +%s);; esac',
        `NEW=$(awk -v n="$NOW" -v o="${secs.toFixed(3)}" 'BEGIN { printf "%.3f", n + o }')`,
        'if $SUDO date -u -s "@$NEW" >/dev/null 2>&1; then say RESULT ok; else say RESULT fail; fi',
        'if has hwclock && $SUDO hwclock --systohc >/dev/null 2>&1; then say STEP hwclock; fi',
        'exit 0',
    ].join('\n') + '\n';
}

/** Script PowerShell (Windows, só ASCII) que configura e ressincroniza o w32time. */
function buildWindowsSyncScript(server) {
    const ntp = validateNtpHost(server);
    return [
        "$ErrorActionPreference = 'Continue'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$ntp = '${ntp}'`,
        "function Say([string]$k, [string]$v) { Write-Output ('@@OP:' + $k + ':' + $v) }",
        "function Indent($lines) { foreach ($l in @($lines)) { $t = \"$l\".TrimEnd(); if ($t) { Write-Output ('    ' + $t) } } }",
        '$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
        "if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Say 'ERR' 'NOADMIN'; exit 3 }",
        '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
        '$domainMember = [bool]$cs.PartOfDomain -and ($cs.DomainRole -lt 4)',
        "if (-not (Get-Service -Name w32time -ErrorAction SilentlyContinue)) { Indent (w32tm /register 2>&1); Say 'STEP' 'w32time-register' }",
        'Set-Service -Name w32time -StartupType Automatic -ErrorAction SilentlyContinue',
        "if ((Get-Service -Name w32time).Status -ne 'Running') { Start-Service -Name w32time; Start-Sleep -Seconds 2; Say 'STEP' 'w32time-start' }",
        'if ($domainMember) {',
        "  Say 'METHOD' 'w32time-domain'",
        "  Say 'DOMAIN' $cs.Domain",
        '} else {',
        "  Say 'METHOD' 'w32time'",
        '  Indent (w32tm /config "/manualpeerlist:$ntp,0x8" /syncfromflags:manual /reliable:no /update 2>&1)',
        "  if ($LASTEXITCODE -eq 0) { Say 'PERSIST' 'w32time' }",
        '  Start-Sleep -Seconds 2',
        '}',
        '$ok = $false',
        'for ($i = 1; $i -le 3 -and -not $ok; $i++) {',
        "  Say 'STEP' 'w32time-resync'",
        '  Indent (w32tm /resync /rediscover 2>&1)',
        '  if ($LASTEXITCODE -eq 0) { $ok = $true } else { Start-Sleep -Seconds 3 }',
        '}',
        'Indent (w32tm /query /source 2>&1)',
        "if ($ok) { Say 'RESULT' 'ok' } else { Say 'RESULT' 'fail' }",
    ].join('\n');
}

/** Ajuste direto (Windows): Set-Date -Adjust. */
function buildWindowsStepScript(addMs) {
    const ms = Math.round(checkedOffset(addMs));
    return [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `try { Set-Date -Adjust ([TimeSpan]::FromMilliseconds(${ms})) | Out-Null; Write-Output '@@OP:RESULT:ok' }`,
        "catch { Write-Output '@@OP:RESULT:fail'; Write-Output ('    ' + $_.Exception.Message) }",
    ].join('\n');
}

function checkedOffset(addMs) {
    const n = Number(addMs);
    if (!Number.isFinite(n) || Math.abs(n) > 10 * 365 * 86400 * 1000) throw new TimeSyncError('Ajuste de relógio fora do limite.');
    return n;
}

// ==========================================================================
// Interpretação da saída dos scripts
// ==========================================================================

const STEP_LABELS = {
    'chrony-add': 'chrony: servidor NTP adicionado como fonte',
    'chrony-burst': 'chrony: coletando amostras do NTP',
    'chrony-makestep': 'chrony: correção imediata do relógio (makestep)',
    ntpdate: 'ntpdate: ajuste imediato pelo NTP',
    sntp: 'sntp: ajuste imediato pelo NTP',
    'ntpd-gq': 'ntpd: ajuste único (ntpd -gq)',
    'ntpd-restart': 'ntpd reiniciado com a nova configuração',
    'timesyncd-restart': 'systemd-timesyncd reiniciado com o servidor NTP',
    'chronyd-q': 'chronyd: ajuste único (chronyd -q)',
    hwclock: 'relógio de hardware (RTC) gravado',
    'w32time-register': 'serviço Horário do Windows registrado',
    'w32time-start': 'serviço Horário do Windows iniciado',
    'w32time-resync': 'Windows: ressincronização (w32tm /resync)',
};

const METHOD_LABELS = {
    chrony: 'chrony',
    ntpd: 'ntpd',
    timesyncd: 'systemd-timesyncd',
    chronyd: 'chronyd (ajuste único)',
    ntpdate: 'ntpdate (ajuste único)',
    sntp: 'sntp (ajuste único)',
    none: 'nenhum serviço de horário encontrado',
    w32time: 'Horário do Windows (w32time)',
    'w32time-domain': 'Horário do Windows (hierarquia do domínio)',
};

function parseScriptOutput(text) {
    const res = { method: null, result: null, error: null, domain: null, steps: [], persist: [], log: [] };
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        const m = line.match(/^@@OP:([A-Z]+):(.*)$/);
        if (!m) {
            if (line.trim()) res.log.push(line);
            continue;
        }
        const [, key, val] = m;
        if (key === 'METHOD') res.method = val.trim();
        else if (key === 'RESULT') res.result = val.trim();
        else if (key === 'ERR') res.error = val.trim();
        else if (key === 'DOMAIN') res.domain = val.trim();
        else if (key === 'PERSIST') res.persist.push(val.trim());
        else if (key === 'STEP') res.steps.push(STEP_LABELS[val.trim()] || val.trim());
    }
    return res;
}

function errorMessage(code, serverOs) {
    if (code === 'NOROOT') {
        return `O usuário do SSH (${config.ssh.user || 'atual'}) não é root nem tem "sudo" sem senha. ` +
            'Ajustar o relógio do Linux exige root: use SSH_USER=root ou libere sudo sem senha para chronyc/ntpdate/date/timedatectl.';
    }
    if (code === 'NOADMIN') {
        return 'O painel não está rodando como Administrador: o Windows só permite ajustar a hora com privilégio administrativo. ' +
            'Rode o painel como serviço (instalador, conta LocalSystem) ou num prompt "Executar como administrador".';
    }
    return `Falha ao sincronizar o relógio (${code}) no servidor ${serverOs || ''}.`.trim();
}

/** "+9 min 23 s" / "-1,2 s" — positivo = servidor ADIANTADO. */
function formatOffset(ms) {
    if (ms == null || !Number.isFinite(ms)) return '--';
    const sign = ms >= 0 ? '+' : '−';
    const a = Math.abs(ms);
    if (a < 1000) return `${sign}${Math.round(a)} ms`;
    if (a < 60000) return `${sign}${(a / 1000).toFixed(1).replace('.', ',')} s`;
    const totalS = Math.round(a / 1000);
    const d = Math.floor(totalS / 86400);
    const h = Math.floor((totalS % 86400) / 3600);
    const m = Math.floor((totalS % 3600) / 60);
    const s = totalS % 60;
    const parts = [];
    if (d) parts.push(`${d} d`);
    if (h) parts.push(`${h} h`);
    if (m) parts.push(`${m} min`);
    if (s && !d) parts.push(`${s} s`);
    return sign + parts.join(' ');
}

// ==========================================================================
// Sincronização
// ==========================================================================

async function safeStatus(server) {
    try {
        return await getStatus({ force: true, server });
    } catch (err) {
        return { offsetMs: null, serverError: err.message, ntp: { ok: false, error: err.message } };
    }
}

async function runScript(serverOs, script) {
    const r = serverOs === 'windows'
        ? await execOnServer(psEncoded(script), { timeoutMs: 180000 })
        : await execOnServer('sh -s', { stdin: script, timeoutMs: 180000 });
    return { code: r.code, parsed: parseScriptOutput(`${r.stdout}\n${r.stderr}`) };
}

/**
 * Sincroniza o relógio do servidor de banco com o NTP.
 * @returns {Promise<object>} { success, message, method, steps, persist, log, before, after, fallbackUsed, warnings }
 */
async function syncServerClock(server, ctx = {}) {
    const servers = ntpServers();
    const ntp = validateNtpHost(server || servers[0]);
    if (syncing) throw new TimeSyncError('Já existe uma sincronização em andamento.', 409);
    syncing = true;
    try {
        const before = await safeStatus(ntp);

        if (config.demoMode) {
            await new Promise((r) => setTimeout(r, 1200));
            // O "servidor" simulado passa a marcar a hora do NTP (não a do painel,
            // que também pode estar fora de hora).
            const ntpMinusPanel = before.panelOffsetMs != null ? -before.panelOffsetMs : 0;
            demoClock.state.offsetMs = ntpMinusPanel + Math.round(Math.random() * 30) - 15;
            const after = await safeStatus(ntp);
            audit.record({ action: 'time-sync', user: ctx.user, role: ctx.role, ip: ctx.ip, detail: `[DEMO] ntp=${ntp} antes=${formatOffset(before.offsetMs)} depois=${formatOffset(after.offsetMs)}` });
            return {
                success: true,
                message: `Relógio sincronizado com ${ntp} (simulação).`,
                method: METHOD_LABELS.chrony,
                steps: [STEP_LABELS['chrony-add'], STEP_LABELS['chrony-burst'], STEP_LABELS['chrony-makestep'], STEP_LABELS.hwclock],
                persist: ['/etc/chrony.conf'],
                log: ['    200 OK', '    Reference ID    : C8A0074B (a.st1.ntp.br)', '    System time     : 0.000012 seconds fast of NTP time'],
                before, after, fallbackUsed: false, warnings: [],
            };
        }

        const serverOs = await detectServerOs();
        const first = await runScript(serverOs, serverOs === 'windows' ? buildWindowsSyncScript(ntp) : buildLinuxSyncScript(ntp));
        const p = first.parsed;
        if (p.error) {
            audit.record({ action: 'time-sync', user: ctx.user, role: ctx.role, ip: ctx.ip, success: false, detail: `ntp=${ntp} erro=${p.error}` });
            return { success: false, message: errorMessage(p.error, serverOs), method: null, steps: p.steps, persist: p.persist, log: p.log, before, after: before, fallbackUsed: false, warnings: [] };
        }

        let after = await safeStatus(ntp);
        const warnings = [];
        let fallbackUsed = false;
        const log = [...p.log];
        const steps = [...p.steps];

        const stillOff = after.offsetMs != null && Math.abs(after.offsetMs) > SYNC_TOLERANCE_MS;
        if (stillOff && p.method === 'w32time-domain') {
            warnings.push(`Este servidor é membro do domínio ${p.domain || ''} e segue a hora do controlador de domínio, que também está ${formatOffset(after.offsetMs)} do NTP. ` +
                'Corrija a hora no controlador de domínio (PDC) — mudar só este servidor quebraria a autenticação Kerberos.');
        } else if (stillOff) {
            // A ferramenta do SO não corrigiu (NTP inacessível a partir do servidor,
            // limite de correção do w32time etc.): aplica o ajuste medido pelo painel.
            const step = await runScript(serverOs, serverOs === 'windows'
                ? buildWindowsStepScript(-after.offsetMs)
                : buildLinuxStepScript(-after.offsetMs));
            fallbackUsed = true;
            steps.push(`ajuste direto de ${formatOffset(-after.offsetMs)} pela medição do painel (${serverOs === 'windows' ? 'Set-Date' : 'date -s'})`);
            log.push(...step.parsed.log);
            if (step.parsed.error) warnings.push(errorMessage(step.parsed.error, serverOs));
            after = await safeStatus(ntp);
        }

        const measured = after.offsetMs != null;
        const success = measured ? Math.abs(after.offsetMs) <= SYNC_TOLERANCE_MS : p.result === 'ok';
        if (!measured) warnings.push('Não foi possível medir a hora do banco depois do ajuste (banco ou NTP inacessível a partir do painel): o resultado vem só da ferramenta do servidor.');
        if (p.method === 'none' && !fallbackUsed) warnings.push('Nenhum serviço de horário (chrony, ntpd, timesyncd) foi encontrado no servidor. Instale o chrony para manter a hora sincronizada.');

        const message = success
            ? `Relógio do servidor sincronizado com ${after.ntp && after.ntp.ok ? after.ntp.server : ntp}${measured ? ` (diferença agora: ${formatOffset(after.offsetMs)})` : ''}.`
            : `O relógio ainda está ${measured ? formatOffset(after.offsetMs) : 'sem confirmação'} em relação ao NTP. Veja os detalhes abaixo.`;

        audit.record({
            action: 'time-sync', user: ctx.user, role: ctx.role, ip: ctx.ip, success,
            detail: `ntp=${ntp} método=${p.method || '?'}${fallbackUsed ? '+ajuste-direto' : ''} antes=${formatOffset(before.offsetMs)} depois=${formatOffset(after.offsetMs)}`,
        });
        logger.info(`Sincronização de relógio: ${message}`);
        return {
            success, message,
            method: METHOD_LABELS[p.method] || p.method,
            steps, persist: p.persist, log, before, after, fallbackUsed, warnings,
        };
    } finally {
        syncing = false;
        statusCache = null;
    }
}

module.exports = {
    TimeSyncError,
    getStatus,
    syncServerClock,
    ntpServers,
    // puros (testes)
    validateNtpHost,
    buildSntpRequest,
    parseSntpResponse,
    readNtpTime,
    writeNtpTime,
    sntpQuery,
    buildLinuxSyncScript,
    buildLinuxStepScript,
    buildWindowsSyncScript,
    buildWindowsStepScript,
    parseScriptOutput,
    formatOffset,
};

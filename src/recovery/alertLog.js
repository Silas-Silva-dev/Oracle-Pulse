/**
 * ALERTLOG.JS - Leitura do alert log do Oracle (texto) em registros
 * estruturados: data, códigos ORA (com o argumento do ORA-00600/07445),
 * eventos de ciclo de vida (startup, open, queda, recuperação) e os objetos
 * citados (datafile, bloco, grupo de redo, controlfile, incidente).
 *
 * Formatos de data suportados:
 *   12.2+ : "2026-10-13T17:36:14.123456-03:00"   (linha própria)
 *   ≤12.1 : "Tue Oct 13 17:36:14 2026"           (linha própria)
 */
const kb = require('./knowledge');

const TS_ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?\s*$/;
const TS_OLD = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s*$/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

const EVENTS = [
    { re: /^Starting ORACLE instance/i, event: 'startup', label: 'Instância iniciada' },
    { re: /terminating the instance due to (?:error|ORA error) (\d+)|Instance terminated by /i, event: 'crash', label: 'Instância derrubada' },
    { re: /^(?:Shutting down instance|Shutting down ORACLE instance|Instance shutdown complete)/i, event: 'shutdown', label: 'Instância desligada' },
    { re: /^Completed: ALTER DATABASE OPEN/i, event: 'open', label: 'Banco aberto' },
    { re: /^(?:ALTER DATABASE OPEN RESETLOGS|RESETLOGS after (?:in)?complete recovery)/i, event: 'resetlogs', label: 'OPEN RESETLOGS' },
    { re: /^(?:Beginning crash recovery|Crash recovery completed|Completed crash recovery)/i, event: 'crash-recovery', label: 'Recuperação de instância' },
    { re: /^(?:Media Recovery Complete|Completed: ALTER DATABASE RECOVER|Media Recovery Start|Recovery of Online Redo Log)/i, event: 'media-recovery', label: 'Recuperação de mídia' },
    { re: /^Completed: ALTER DATABASE MOUNT/i, event: 'mount', label: 'Banco montado' },
    { re: /Archiver process freed from errors/i, event: 'archiver-ok', label: 'Archiver liberado' },
    { re: /^ARC\d+: Error|^ARCH: Archival stopped|Archival Error|^ARCH: Error/i, event: 'archiver-error', label: 'Erro do archiver' },
    { re: /^Completed: alter database add logfile member/i, event: 'redo-member-added', label: 'Membro de redo adicionado' },
];

/** Converte a linha de data (se for uma) em { text, epoch }. */
function parseTimestamp(line) {
    const s = line.trim();
    let m = TS_ISO.exec(s);
    if (m) {
        const [, y, mo, d, h, mi, se, tz] = m;
        let epoch;
        if (tz) {
            const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}${tz === 'Z' ? 'Z' : tz.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`;
            epoch = Date.parse(iso);
        } else {
            epoch = new Date(+y, +mo - 1, +d, +h, +mi, +se).getTime();
        }
        return { text: `${y}-${mo}-${d} ${h}:${mi}:${se}`, epoch };
    }
    m = TS_OLD.exec(s);
    if (m) {
        const [, mon, d, h, mi, se, y] = m;
        const date = new Date(+y, MONTHS[mon], +d, +h, +mi, +se);
        const p = (n) => String(n).padStart(2, '0');
        return { text: `${y}-${p(MONTHS[mon] + 1)}-${p(+d)} ${h}:${mi}:${se}`, epoch: date.getTime() };
    }
    return null;
}

/** Extrai códigos, eventos e objetos citados num bloco de linhas de um mesmo instante. */
function classify(lines) {
    const text = lines.join('\n');
    // "ORA-600 signalled during: ALTER DATABASE OPEN..." só repete um erro já registrado.
    const codeText = lines.filter((l) => !/signalled during/i.test(l)).join('\n');
    const codes = [];
    const seen = new Set();
    const re = /\bORA-(\d{1,5})\b/g;
    let m;
    while ((m = re.exec(codeText)) !== null) {
        const code = kb.normalizeCode('ORA', m[1]);
        let arg = null;
        if (code === 'ORA-00600' || code === 'ORA-07445') arg = kb.firstArg(codeText.slice(m.index, m.index + 400), code);
        const key = `${code}|${arg || ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            codes.push({ code, arg });
        }
    }
    let event = null;
    for (const line of lines) {
        const ev = EVENTS.find((e) => e.re.test(line.trim()));
        if (ev) { event = ev.event; break; }
    }
    // Independente do idioma do banco (NLS_LANGUAGE): o Oracle traduz o texto das
    // mensagens, mas mantém a ordem dos números e o caminho entre aspas. Ex.:
    //   ORA-00312: online log 2 thread 1: '...'      (inglês)
    //   ORA-00312: log on-line 2 do thread 1: '...'  (português)
    const files = [];
    for (const f of text.matchAll(/ORA-0*1110:[^'\n]*?(\d+)\s*:\s*'([^']+)'/gi)) files.push({ fileNo: +f[1], path: f[2] });
    for (const f of text.matchAll(/ORA-0*1157:\D*?(\d+)/gi)) {
        if (!files.some((x) => x.fileNo === +f[1])) files.push({ fileNo: +f[1], path: null });
    }
    const logs = [];
    for (const l of text.matchAll(/ORA-0*312:[^'\n]*?(\d+)[^'\n\d]+(\d+)[^'\n]*'([^']+)'/gi)) logs.push({ group: +l[1], thread: +l[2], path: l[3] });
    // ORA-00313 traz o grupo (sem caminho): "open failed for members of log group 2 of thread 1"
    const redoGroups = [];
    for (const g of text.matchAll(/ORA-0*313:\D*?(\d+)\D+?(\d+)/gi)) redoGroups.push({ group: +g[1], thread: +g[2] });
    const controlfiles = [];
    for (const c of text.matchAll(/ORA-0*202:[^'\n]*'([^']+)'/gi)) controlfiles.push(c[1]);
    const blocks = [];
    for (const b of text.matchAll(/ORA-0*1578:[^(\n]*\([^\d)]*(\d+)[^\d)]+(\d+)\)/gi)) blocks.push({ fileNo: +b[1], block: +b[2] });
    // Membro de redo adicionado (o comando aparece no alert log em inglês, como foi digitado).
    const addedMembers = [];
    for (const a of text.matchAll(/^Completed: alter database add logfile member\s+'([^']+)'[^\n]*?\bto\s+group\s+(\d+)/gim)) addedMembers.push({ path: a[1], group: +a[2] });
    for (const b of text.matchAll(/Corrupt block relative dba: 0x[0-9a-f]+ \(file (\d+), block (\d+)\)/gi)) {
        if (!blocks.some((x) => x.fileNo === +b[1] && x.block === +b[2])) blocks.push({ fileNo: +b[1], block: +b[2] });
    }
    const inc = /\(incident=(\d+)/i.exec(text);
    const trc = /Errors in file ([^\s(]+)/i.exec(text);
    // Queda: "... terminating the instance due to ORA error 494" → ORA-00494
    const crash = /terminating the instance due to (?:ORA )?error (\d+)/i.exec(text);
    return {
        codes, event, files, logs, redoGroups, addedMembers, controlfiles, blocks,
        incident: inc ? +inc[1] : null,
        traceFile: trc ? trc[1] : null,
        crashCode: crash ? kb.normalizeCode('ORA', crash[1]) : null,
    };
}

function makeRecord(ts, lines) {
    const kept = lines.filter((l) => l.trim() !== '');
    const info = classify(kept);
    if (!info.codes.length && !info.event && !info.blocks.length) return null;
    let text = kept.slice(0, 14).join('\n');
    if (text.length > 1200) text = text.slice(0, 1200) + '…';
    return { time: ts ? ts.text : null, epoch: ts ? ts.epoch : null, text, ...info };
}

/**
 * Converte o texto do alert log em registros relevantes (com erro ou evento).
 * @param {string} text
 * @param {object} [opts] { sinceEpoch, limit }
 */
function parseAlertText(text, opts = {}) {
    const limit = opts.limit || 500;
    const records = [];
    let ts = null;
    let buf = [];
    const flush = () => {
        if (buf.length) {
            const r = makeRecord(ts, buf);
            if (r) records.push(r);
        }
        buf = [];
    };
    for (const raw of String(text || '').split(/\r?\n/)) {
        const t = parseTimestamp(raw);
        if (t) {
            flush();
            ts = t;
            continue;
        }
        buf.push(raw.replace(/\s+$/, ''));
    }
    flush();
    const filtered = opts.sinceEpoch ? records.filter((r) => r.epoch == null || r.epoch >= opts.sinceEpoch) : records;
    return filtered.slice(-limit);
}

/** Registros vindos de V$DIAG_ALERT_EXT: [{ ts: ISO com fuso, text }]. */
function parseAlertRows(rows, opts = {}) {
    const records = [];
    for (const row of rows || []) {
        const ts = parseTimestamp(String(row.ts || '').replace(' ', 'T'));
        const r = makeRecord(ts, String(row.text || '').split(/\r?\n/));
        if (r) records.push(r);
    }
    const filtered = opts.sinceEpoch ? records.filter((r) => r.epoch == null || r.epoch >= opts.sinceEpoch) : records;
    return filtered.slice(-(opts.limit || 500));
}

/** Marcos do ciclo de vida: último open/startup/queda (epoch). */
function lifecycle(records) {
    const last = (ev) => {
        for (let i = records.length - 1; i >= 0; i--) if (records[i].event === ev) return records[i];
        return null;
    };
    // A queda costuma gerar 2 registros ("terminating the instance due to error N"
    // e "Instance terminated by ..."): herda o código do registro irmão.
    let lastCrash = last('crash');
    if (lastCrash && !lastCrash.crashCode) {
        const sib = records.filter((r) => r.event === 'crash' && r.crashCode && lastCrash.epoch != null && r.epoch != null && lastCrash.epoch - r.epoch <= 10 * 60000 && r.epoch <= lastCrash.epoch).pop();
        if (sib) lastCrash = { ...lastCrash, crashCode: sib.crashCode };
    }
    return {
        lastOpen: last('open'),
        lastStartup: last('startup'),
        lastCrash,
        lastResetlogs: last('resetlogs'),
        lastArchiverOk: last('archiver-ok'),
    };
}

/**
 * Agrupa os erros por código (+argumento do 600/7445).
 * @returns {Array<{code,arg,count,first,last,lastEpoch,samples,incidents,files,logs,controlfiles,blocks}>}
 */
function groupErrors(records) {
    const groups = new Map();
    for (const r of records) {
        for (const c of r.codes) {
            const key = `${c.code}|${c.arg || ''}`;
            let g = groups.get(key);
            if (!g) {
                g = { code: c.code, arg: c.arg, count: 0, jobCount: 0, first: r.time, firstEpoch: r.epoch, last: r.time, lastEpoch: r.epoch, samples: [], incidents: [], files: [], logs: [], controlfiles: [], blocks: [], with: [] };
                groups.set(key, g);
            }
            g.count += 1;
            // Erro dentro de job agendado (ORA-12012 no mesmo registro): impacto restrito ao job.
            if (r.codes.some((x) => x.code === 'ORA-12012')) g.jobCount += 1;
            for (const o of r.codes) if (o.code !== c.code && !g.with.includes(o.code) && g.with.length < 12) g.with.push(o.code);
            g.last = r.time;
            g.lastEpoch = r.epoch;
            if (g.samples.length < 3) g.samples.push({ time: r.time, text: r.text });
            if (r.incident && !g.incidents.includes(r.incident) && g.incidents.length < 10) g.incidents.push(r.incident);
            for (const f of r.files) if (!g.files.some((x) => x.fileNo === f.fileNo)) g.files.push(f);
            for (const l of r.logs) if (!g.logs.some((x) => x.path === l.path)) g.logs.push(l);
            for (const cf of r.controlfiles) if (!g.controlfiles.includes(cf)) g.controlfiles.push(cf);
            for (const b of r.blocks) if (!g.blocks.some((x) => x.fileNo === b.fileNo && x.block === b.block) && g.blocks.length < 50) g.blocks.push(b);
        }
    }
    return [...groups.values()].sort((a, b) => (b.lastEpoch || 0) - (a.lastEpoch || 0));
}

module.exports = { parseTimestamp, parseAlertText, parseAlertRows, groupErrors, lifecycle, classify, EVENTS };

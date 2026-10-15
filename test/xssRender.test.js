/**
 * XSS nas telas: carrega public/main.js num sandbox (vm) com um DOM mínimo e
 * confere o HTML gerado para dados HOSTIS vindos do banco. O PROGRAM de
 * V$SESSION é informado pelo próprio cliente que conecta — qualquer usuário do
 * banco controla — e já foi renderizado sem escape (roubo do token do DBA).
 *
 * OP_MAIN_JS=<arquivo> roda o mesmo teste contra outra versão do main.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MAIN_JS = process.env.OP_MAIN_JS || path.join(__dirname, '..', 'public', 'main.js');

function fakeElement() {
    const el = {
        innerHTML: '', textContent: '', value: '', disabled: false, style: {}, dataset: {},
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, appendChild() {}, append() {}, remove() {},
        setAttribute() {}, getAttribute: () => null, querySelector: () => fakeElement(), querySelectorAll: () => [],
        closest: () => null, focus() {}, click() {},
    };
    return el;
}

/** Carrega o main.js num contexto isolado; `responses` = { url: corpo JSON }. */
function loadMain(responses) {
    const elements = new Map();
    const byId = (id) => {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
    };
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const ctx = {
        console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, performance, Date, Math, JSON, URL,
        Chart: { defaults: { color: '', font: {} } },
        sessionStorage: storage, localStorage: storage,
        location: { reload() {}, hash: '' },
        navigator: { clipboard: { writeText: async () => {} } },
        alert() {}, confirm: () => false,
        fetch: async (url) => ({ status: 200, ok: true, json: async () => responses[url] || { success: false } }),
        document: {
            getElementById: byId, addEventListener() {}, querySelector: () => fakeElement(), querySelectorAll: () => [],
            createElement: () => fakeElement(), body: fakeElement(), documentElement: fakeElement(),
        },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(MAIN_JS, 'utf8'), ctx, { filename: 'main.js' });
    return { ctx, byId };
}

const EVIL_PROGRAM = '<img src=x onerror=alert(document.domain)>';
const EVIL_USER = '"><svg onload=alert(1)>';
const EVIL_SQL_ID = "x');alert(3);//";

function assertNoActiveMarkup(html, where) {
    assert.doesNotMatch(html, /<img|<svg/i, `${where}: marcação ativa do banco chegou crua ao HTML`);
}

test('Sessões bloqueadas: PROGRAM/USERNAME hostis são escapados', async () => {
    const { ctx, byId } = loadMain({
        '/api/sessions': { success: true, data: [{ SID: 10, SERIAL: 20, VICTIM: EVIL_USER, PROGRAM: EVIL_PROGRAM, BLOCKER_SID: 11, BLOCKER_USER: EVIL_PROGRAM, ROLE: 'VÍTIMA' }] },
        '/api/sessions/long-running': { success: true, data: [] },
    });
    await ctx.loadSessionsData();
    const html = byId('sessions-body').innerHTML;
    assertNoActiveMarkup(html, 'sessions-body');
    assert.match(html, /&lt;img src=x onerror=alert\(document\.domain\)&gt;/);
});

test('Sessões longas: PROGRAM/USERNAME escapados e SQL_ID hostil fora do onclick', async () => {
    const { ctx, byId } = loadMain({
        '/api/sessions/long-running': { success: true, data: [{ SID: 1, SERIAL: 2, USERNAME: EVIL_USER, PROGRAM: EVIL_PROGRAM, SECONDS_RUNNING: 99, EVENT: 'db file sequential read', SQL_ID: EVIL_SQL_ID }] },
    });
    await ctx.loadLongRunningSessions();
    const html = byId('long-running-body').innerHTML;
    assertNoActiveMarkup(html, 'long-running-body');
    assert.doesNotMatch(html, /onclick="[^"]*alert\(3\)/, 'SQL_ID hostil não pode virar código no onclick');
});

test('Top SQL: SQL_ID válido continua clicável; inválido não entra no onclick', () => {
    const { ctx, byId } = loadMain({});
    ctx.updateSqlTable([
        { SQL_ID: '7h35uxf5uhmm1', SQL_SNIPPET: 'select 1 from dual', CPU_SECONDS: 1, EXECUTIONS: 1 },
        { SQL_ID: EVIL_SQL_ID, SQL_SNIPPET: EVIL_PROGRAM, CPU_SECONDS: 1, EXECUTIONS: 1 },
    ], 'top-sql-body');
    const html = byId('top-sql-body').innerHTML;
    assert.match(html, /showSqlDetails\('7h35uxf5uhmm1'\)/);
    // O SQL_ID hostil pode aparecer como TEXTO escapado (inerte), nunca dentro de um onclick.
    assert.doesNotMatch(html, /onclick="[^"]*alert\(3\)/);
    assertNoActiveMarkup(html, 'top-sql-body');
});

test('Alertas: id com aspas/barra vai em data-* e não monta código no onclick', () => {
    const { ctx, byId } = loadMain({});
    ctx.renderAlerts([{ id: "tablespace:X\\'+alert(4)+'\"><img src=x>", severity: 'critical', message: EVIL_PROGRAM, since: new Date().toISOString() }]);
    const html = byId('notif-list').innerHTML;
    assert.match(html, /notif-dismiss/, 'o alerta deve ter sido renderizado');
    assertNoActiveMarkup(html, 'alertas');
    assert.doesNotMatch(html, /dismissAlert\('/, 'o id não pode ser interpolado dentro do código do onclick');
});

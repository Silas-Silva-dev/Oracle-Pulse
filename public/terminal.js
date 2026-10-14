/**
 * TERMINAL.JS - Terminal do servidor (DBA): SO / sqlplus (SYSDBA) / RMAN.
 * Usa os globais do main.js: secureFetch, escapeHtml, userRole.
 */
(function () {
    'use strict';
    let mode = 'os';
    let info = null;
    let busy = false;

    const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s));
    const $ = (id) => document.getElementById(id);

    const PLACEHOLDER = {
        os: { linux: 'Ex.: df -h /u01\nps -ef | grep pmon\nid oracle', windows: 'Ex.: dir D:\\ORACLE\nsc query OracleServiceORCL\nwhoami' },
        sqlplus: 'Ex.:\nSET LINESIZE 200\nSELECT status FROM v$instance;\n\n-- Reinício (cuidado):\n-- SHUTDOWN IMMEDIATE;\n-- STARTUP MOUNT;\n-- ALTER DATABASE OPEN;',
        rman: 'Ex.:\nLIST BACKUP SUMMARY;\nCROSSCHECK ARCHIVELOG ALL;\n\n-- BACKUP DATABASE PLUS ARCHIVELOG;',
    };
    const HINT = {
        os: 'Comandos de <strong>sistema operacional</strong> no servidor do banco. Rodam de verdade e ficam na <strong>auditoria</strong>.',
        sqlplus: 'Conectado <strong>AS SYSDBA</strong>: <code>SET</code>, <code>ALTER</code>, <code>SELECT</code>, <code>STARTUP</code>/<code>SHUTDOWN</code>. Termine os comandos com <code>;</code>. A senha do SYS é mascarada na saída.',
        rman: 'Conectado ao <strong>target</strong>. Os comandos rodam fora de <code>RUN{ }</code> — envolva em <code>RUN { ... }</code> se precisar de <code>SET</code>/<code>ALLOCATE CHANNEL</code>.',
    };

    function setMode(m) {
        mode = m;
        document.querySelectorAll('.term-mode').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === m));
        const input = $('term-input');
        if (input) input.placeholder = m === 'os' ? (PLACEHOLDER.os[(info && info.serverOs) === 'windows' ? 'windows' : 'linux']) : PLACEHOLDER[m];
        const hintEl = $('term-hint');
        if (hintEl) hintEl.innerHTML = HINT[m];
        updateWhere();
        updateAvailability();
    }

    function updateWhere() {
        const el = $('term-where');
        if (!el || !info) { if (el) el.textContent = ''; return; }
        const shell = info.shells ? info.shells[mode] : '';
        const tgt = info.demo ? 'DEMO (nada é executado)' : (info.remote ? `${esc(info.sshHost)} · ${esc(info.serverOs || '?')}` : `máquina do painel · ${esc(info.serverOs || '?')}`);
        el.innerHTML = `<i class="fas fa-location-crosshairs"></i> Executa em: <b>${esc(shell)}</b> — ${tgt}`;
    }

    function updateAvailability() {
        if (!info) return;
        document.querySelectorAll('.term-mode').forEach((b) => {
            const m = b.dataset.mode;
            const ok = m === 'os' ? info.osReachable : info.automation;
            b.disabled = !ok;
            b.title = ok ? '' : (m === 'os'
                ? 'Configure o acesso SSH (SSH_* no .env) para o terminal do servidor remoto.'
                : 'Defina DB_ORACLE_HOME/DB_ORACLE_SID (e DB_SYS_PASSWORD) no .env.');
        });
        const btn = $('term-run-btn');
        const avail = mode === 'os' ? info.osReachable : info.automation;
        if (btn) btn.disabled = busy || !avail;
    }

    async function loadInfo() {
        try {
            const res = await secureFetch('/api/server/terminal/info');
            const json = await res.json();
            info = json.success ? json.data : null;
        } catch { info = null; }
        setMode(mode);
    }

    function render(result, errorText) {
        const out = $('term-output');
        if (!out) return;
        out.hidden = false;
        if (errorText) {
            out.classList.add('is-error');
            out.innerHTML = `<span class="term-meta"><i class="fas fa-circle-xmark"></i> Falha</span>${esc(errorText)}`;
            return;
        }
        out.classList.toggle('is-error', !result.ok);
        const cmdEcho = ($('term-input').value || '').trim();
        const head = `<span class="term-meta">${esc(result.shell || mode)} · código ${result.code}${result.demo ? ' · DEMO' : ''}</span>`;
        out.innerHTML = `${head}<span class="term-cmd">${esc(cmdEcho)}</span>\n\n${esc(result.output || '(sem saída)')}`;
        out.scrollTop = 0;
    }

    window.runTerminal = async function () {
        if (busy) return;
        const input = $('term-input');
        const command = (input && input.value || '').trim();
        if (!command) { render(null, 'Digite um comando para executar.'); return; }
        const btn = $('term-run-btn');
        const original = btn ? btn.innerHTML : '';
        busy = true;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Executando...'; }
        const out = $('term-output');
        if (out) { out.hidden = false; out.classList.remove('is-error'); out.innerHTML = '<span class="term-meta"><i class="fas fa-spinner fa-spin"></i> Executando no servidor...</span>'; }
        try {
            const res = await secureFetch('/api/server/terminal/exec', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode, command, timeoutMs: Number($('term-timeout') && $('term-timeout').value) || 120000 }),
            });
            const json = await res.json();
            if (!json.success) render(null, json.error || 'Falha ao executar.');
            else {
                render(json.data);
                // sqlplus/RMAN podem mudar o estado do banco: atualiza as outras telas.
                if (mode !== 'os' && typeof refreshAllSections === 'function') refreshAllSections();
            }
        } catch (err) {
            render(null, 'Erro de rede: ' + err.message);
        } finally {
            busy = false;
            if (btn) { btn.innerHTML = original; }
            updateAvailability();
        }
    };

    window.clearTerminal = function () {
        const input = $('term-input');
        if (input) { input.value = ''; input.focus(); }
        const out = $('term-output');
        if (out) { out.hidden = true; out.innerHTML = ''; }
    };

    // Chamado pelo main.js ao abrir a aba.
    window.loadTerminal = function () {
        if (userRole !== 'dba') return;
        loadInfo();
        const input = $('term-input');
        if (input) setTimeout(() => input.focus(), 50);
    };

    document.addEventListener('DOMContentLoaded', () => {
        const modes = $('term-modes');
        if (!modes) return;
        modes.addEventListener('click', (e) => {
            const b = e.target.closest('.term-mode');
            if (b && !b.disabled) setMode(b.dataset.mode);
        });
        const input = $('term-input');
        if (input) {
            input.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); window.runTerminal(); }
            });
        }
        setMode('os');
    });
})();

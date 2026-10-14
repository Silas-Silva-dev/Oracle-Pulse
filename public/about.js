/**
 * ABOUT.JS - Tela "Sobre": informações do sistema e atualização pelo GitHub.
 * Usa os globais do main.js: secureFetch, escapeHtml, userRole.
 */
(function () {
    'use strict';
    const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s));
    const $ = (id) => document.getElementById(id);
    let info = null;
    let lastCheck = null;
    let loadedOnce = false;

    function fmtBytes(n) {
        if (!n) return '';
        const mb = n / 1048576;
        return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
    }
    function fmtDate(iso) {
        if (!iso) return '';
        try { return new Date(iso).toLocaleDateString('pt-BR'); } catch { return ''; }
    }

    async function loadAbout() {
        try {
            const json = await (await secureFetch('/api/about')).json();
            if (!json.success) return;
            info = json.data;
            $('about-version').textContent = 'v' + info.version;
            const rows = [
                ['Versão', 'v' + info.version],
                ['Node.js', info.node],
                ['Plataforma', info.platform],
                ['Instalação', info.installedService ? 'serviço do Windows' : (info.demo ? 'modo DEMO' : 'manual / desenvolvimento')],
                ['Pasta', info.installDir],
            ];
            $('about-grid').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
        } catch (e) { /* silencioso */ }
    }

    function renderUpdate(d) {
        lastCheck = d;
        const statusEl = $('about-update-status');
        const actionEl = $('about-update-action');
        const badge = $('nav-update-badge');
        actionEl.innerHTML = '';

        const refresh = `<button class="btn-primary btn-sm btn-ghost" onclick="checkUpdate(true)"><i class="fas fa-rotate"></i> Verificar de novo</button>`;

        if (d.reason) {
            statusEl.innerHTML = `<div class="about-badge is-warn"><i class="fas fa-circle-info"></i> ${esc(d.reason)}</div>` +
                `<div class="about-notes-box">Versão atual: <strong>v${esc(d.current)}</strong></div>${refresh}`;
            if (badge) badge.hidden = true;
            return;
        }
        if (!d.newer) {
            statusEl.innerHTML = `<div class="about-badge is-ok"><i class="fas fa-circle-check"></i> Você está na versão mais recente (v${esc(d.current)}).</div>${refresh}`;
            if (badge) badge.hidden = true;
            return;
        }

        // Há versão nova
        if (badge) { badge.hidden = false; badge.textContent = '!'; }
        statusEl.innerHTML =
            `<div class="about-badge is-new"><i class="fas fa-circle-arrow-up"></i> Nova versão disponível: <strong>v${esc(d.latest)}</strong></div>` +
            `<div class="about-notes-box">Atual: v${esc(d.current)}${d.publishedAt ? ` · publicada em ${esc(fmtDate(d.publishedAt))}` : ''}` +
            (d.asset ? ` · ${esc(d.asset.name)} (${fmtBytes(d.asset.size)})` : '') + `</div>` +
            (d.notes ? `<div class="about-relnotes">${esc(d.notes)}</div>` : '') +
            `<div style="margin-top:0.6rem">${refresh}</div>`;

        const canUpdate = userRole === 'dba' && info && (info.installedService || info.demo);
        if (userRole !== 'dba') {
            actionEl.innerHTML = `<p class="form-hint"><i class="fas fa-lock"></i> Atualização automática: apenas o perfil DBA.</p>`;
        } else if (!d.asset) {
            actionEl.innerHTML = `<p class="form-hint">Esta versão não tem o instalador (.exe) anexado no GitHub Releases; baixe/instale manualmente.</p>`;
        } else if (!canUpdate) {
            actionEl.innerHTML = `<p class="form-hint">A atualização automática funciona na instalação Windows (serviço). Aqui, baixe o instalador no GitHub e rode manualmente.</p>`;
        } else {
            actionEl.innerHTML =
                `<div class="about-pwd-row">
                    <label class="form-label" for="about-pwd">Senha de instalação do dia (app "Oracle Pulse")</label>
                    <input type="password" id="about-pwd" class="form-control" autocomplete="off" placeholder="8 caracteres">
                    <div id="about-update-result"></div>
                    <button class="btn-primary btn-success" id="about-update-btn" onclick="startUpdate()"><i class="fas fa-cloud-arrow-down"></i> Baixar e atualizar agora</button>
                    <p class="form-hint">O painel baixa o instalador oficial, confere a integridade e o executa. O serviço reinicia e o painel fica alguns instantes fora do ar.</p>
                </div>`;
        }
    }

    window.checkUpdate = async function (force) {
        const statusEl = $('about-update-status');
        statusEl.innerHTML = `<div class="about-badge is-new"><i class="fas fa-spinner fa-spin"></i> Verificando no GitHub...</div>`;
        try {
            const json = await (await secureFetch(`/api/about/check-update${force ? '?refresh=1' : ''}`)).json();
            if (!json.success) {
                statusEl.innerHTML = `<div class="about-badge is-warn"><i class="fas fa-triangle-exclamation"></i> ${esc(json.error || 'Falha ao verificar.')}</div>` +
                    `<button class="btn-primary btn-sm btn-ghost" onclick="checkUpdate(true)"><i class="fas fa-rotate"></i> Tentar de novo</button>`;
                return;
            }
            renderUpdate(json.data);
        } catch (err) {
            statusEl.innerHTML = `<div class="about-badge is-warn"><i class="fas fa-triangle-exclamation"></i> Erro de rede: ${esc(err.message)}</div>`;
        }
    };

    window.startUpdate = async function () {
        const pwd = ($('about-pwd') && $('about-pwd').value || '').trim();
        const out = $('about-update-result');
        const btn = $('about-update-btn');
        if (!pwd) { out.innerHTML = `<div class="result-box is-error"><strong>Informe a senha de instalação do dia.</strong></div>`; return; }
        if (!confirm('Atualizar o Oracle Pulse agora?\n\nO serviço será reiniciado e o painel ficará alguns instantes fora do ar. A configuração (.env) é mantida.')) return;
        btn.disabled = true;
        out.innerHTML = `<div class="result-box"><strong><i class="fas fa-spinner fa-spin"></i> Baixando e iniciando a atualização...</strong></div>`;
        try {
            const json = await (await secureFetch('/api/about/update', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ installPassword: pwd }),
            })).json();
            if (!json.success) {
                out.innerHTML = `<div class="result-box is-error"><strong><i class="fas fa-circle-xmark"></i> ${esc(json.error || 'Falha.')}</strong></div>`;
                btn.disabled = false;
                return;
            }
            if (json.data && json.data.started) {
                out.innerHTML = `<div class="result-box is-ok"><strong><i class="fas fa-circle-check"></i> Atualização iniciada para a v${esc(json.data.version)}.</strong><br>O painel vai reiniciar em instantes — aguarde e recarregue a página.</div>`;
            } else {
                out.innerHTML = `<div class="result-box is-ok"><strong>${esc((json.data && json.data.message) || 'OK')}</strong></div>`;
                btn.disabled = false;
            }
        } catch (err) {
            out.innerHTML = `<div class="result-box is-error"><strong>Erro de rede: ${esc(err.message)}</strong></div>`;
            btn.disabled = false;
        }
    };

    // Chamado pelo main.js ao abrir a aba "Sobre".
    window.loadAbout = async function () {
        await loadAbout();   // garante que `info` existe antes de montar a ação de update
        if (!loadedOnce) { loadedOnce = true; checkUpdate(false); }
        else if (lastCheck) renderUpdate(lastCheck);
    };

    // Verificação discreta em segundo plano (uma vez após o login) para o selo do menu.
    window.startUpdateWatch = function () {
        setTimeout(async () => {
            try {
                const json = await (await secureFetch('/api/about/check-update')).json();
                if (json.success) { lastCheck = json.data; const b = $('nav-update-badge'); if (b && json.data.newer) { b.hidden = false; b.textContent = '!'; } }
            } catch (e) { /* ignore */ }
        }, 6000);
    };
})();

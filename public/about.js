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

    // ---- Sobreposição de progresso da atualização -------------------------
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const STEPS = ['download', 'install', 'restart', 'done'];
    let ovTimer = null, ovValue = 0, ovCap = 0;

    function ovRender() {
        $('update-ov-fill').style.width = ovValue + '%';
        $('update-ov-pct').textContent = Math.round(ovValue) + '%';
    }
    function ovCreep(cap) {
        ovCap = Math.max(ovCap, cap);
        if (ovTimer) return;
        ovTimer = setInterval(() => {
            if (ovValue < ovCap) {
                ovValue += Math.max(0.15, (ovCap - ovValue) * 0.035);
                if (ovValue > ovCap) ovValue = ovCap;
                ovRender();
            }
        }, 160);
    }
    function ovStop() { if (ovTimer) { clearInterval(ovTimer); ovTimer = null; } }
    function ovSub(t) { $('update-ov-sub').textContent = t; }
    function ovStep(active) {
        const ai = STEPS.indexOf(active);
        STEPS.forEach((step, i) => {
            const li = document.querySelector(`#update-ov-steps li[data-step="${step}"]`);
            if (!li) return;
            const ic = li.querySelector('i');
            li.classList.remove('is-active', 'is-done');
            if (ai >= 0 && i < ai) { li.classList.add('is-done'); ic.className = 'fas fa-circle-check'; }
            else if (i === ai) { li.classList.add('is-active'); ic.className = 'fas fa-spinner fa-spin'; }
            else { ic.className = 'fas fa-circle-notch'; }
        });
    }
    function ovAllDone() {
        document.querySelectorAll('#update-ov-steps li').forEach((li) => {
            li.classList.remove('is-active'); li.classList.add('is-done');
            li.querySelector('i').className = 'fas fa-circle-check';
        });
    }
    function ovOpen() {
        const o = $('update-overlay');
        o.className = 'update-overlay';
        o.hidden = false;
        $('update-ov-icon').innerHTML = '<i class="fas fa-cloud-arrow-down fa-spin"></i>';
        $('update-ov-title').textContent = 'Atualizando o Oracle Pulse';
        $('update-ov-actions').hidden = true;
        $('update-ov-actions').innerHTML = '';
        ovValue = 0; ovCap = 0; ovRender();
        ovStep('download');
        ovSub('Baixando e verificando o instalador…');
        ovCreep(30);
    }
    function ovFinish(title, sub) {
        ovStop(); ovAllDone();
        $('update-overlay').classList.add('is-done');
        ovValue = 100; ovRender();
        $('update-ov-icon').innerHTML = '<i class="fas fa-circle-check"></i>';
        $('update-ov-title').textContent = title;
        ovSub(sub);
    }
    function ovError(msg) {
        ovStop();
        $('update-overlay').classList.add('is-error');
        $('update-ov-icon').innerHTML = '<i class="fas fa-circle-xmark"></i>';
        $('update-ov-title').textContent = 'Não foi possível atualizar';
        ovSub(msg || 'Falha na atualização.');
        const a = $('update-ov-actions');
        a.hidden = false;
        a.innerHTML = `<button class="btn-primary" onclick="closeUpdateOverlay()"><i class="fas fa-xmark"></i> Fechar</button>`;
    }
    window.closeUpdateOverlay = function () {
        ovStop();
        $('update-overlay').hidden = true;
        const b = $('about-update-btn'); if (b) b.disabled = false;
    };

    // Lê a versão atual do painel por uma via sem autenticação forte (fetch cru):
    // assim um 401 transitório não dispara reload (secureFetch recarregaria a página).
    async function fetchVersion() {
        let tok = null; try { tok = sessionStorage.getItem('oracle_pulse_token'); } catch (e) { /* ignore */ }
        const r = await fetch('/api/about', { cache: 'no-store', headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
        if (!r.ok) throw new Error('status ' + r.status);
        const j = await r.json();
        return j && j.data ? String(j.data.version || '') : '';
    }
    async function pollUntilVersion(target) {
        const start = Date.now();
        const maxMs = 6 * 60 * 1000;
        let sawDown = false;
        while (Date.now() - start < maxMs) {
            await sleep(2500);
            try {
                const v = await fetchVersion();
                if (v && v === String(target)) return true;
                if (!sawDown) { ovStep('install'); ovSub('Instalando a nova versão…'); ovCreep(72); }
            } catch (e) {
                sawDown = true;
                ovStep('restart');
                ovSub('Reiniciando o serviço… o painel volta em instantes.');
                ovCreep(93);
            }
        }
        return false;
    }

    window.startUpdate = async function () {
        const pwd = ($('about-pwd') && $('about-pwd').value || '').trim();
        const out = $('about-update-result');
        const btn = $('about-update-btn');
        if (!pwd) { out.innerHTML = `<div class="result-box is-error"><strong>Informe a senha de instalação do dia.</strong></div>`; return; }
        if (!confirm('Atualizar o Oracle Pulse agora?\n\nO serviço será reiniciado e o painel ficará alguns instantes fora do ar. A configuração (.env) é mantida.')) return;
        if (btn) btn.disabled = true;
        out.innerHTML = '';
        ovOpen();
        try {
            const json = await (await secureFetch('/api/about/update', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ installPassword: pwd }),
            })).json();

            // As mensagens da sobreposição vão para textContent (já seguro) — sem esc().
            if (!json.success) { ovError(json.error || 'Falha ao iniciar a atualização.'); return; }

            // Modo DEMO: mostra o fluxo até o fim, sem recarregar nada.
            if (json.data && json.data.demo) {
                ovStep('install'); ovSub('Instalando a nova versão… (simulação)'); ovCreep(80);
                await sleep(1300);
                ovStep('restart'); ovSub('Reiniciando o serviço… (simulação)'); ovValue = 93; ovRender();
                await sleep(1100);
                ovFinish('Simulação concluída', 'Em uma instalação real (serviço Windows), o painel reiniciaria agora.');
                const a = $('update-ov-actions'); a.hidden = false;
                a.innerHTML = `<button class="btn-primary" onclick="closeUpdateOverlay()"><i class="fas fa-xmark"></i> Fechar</button>`;
                return;
            }

            if (json.data && json.data.started) {
                const target = String(json.data.version || '');
                ovStep('install');
                ovSub('Instalando a nova versão… o serviço vai reiniciar.');
                ovCreep(70);
                const ok = await pollUntilVersion(target);
                if (ok) {
                    ovFinish('Atualização concluída!', `Agora na versão v${target}. Recarregando o painel…`);
                    setTimeout(() => location.reload(), 1600);
                } else {
                    ovStop();
                    $('update-ov-title').textContent = 'A atualização está demorando…';
                    ovSub('Se o painel não voltar sozinho, recarregue a página.');
                    const a = $('update-ov-actions'); a.hidden = false;
                    a.innerHTML = `<button class="btn-primary" onclick="location.reload()"><i class="fas fa-rotate"></i> Recarregar agora</button>`;
                }
                return;
            }

            ovError((json.data && json.data.message) || 'Resposta inesperada do servidor.');
        } catch (err) {
            ovError('Erro de rede: ' + err.message);
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

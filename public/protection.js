/**
 * PROTECTION.JS - Tela Backup: backups agendados no servidor + guardião da FRA.
 * Usa utilitários globais do main.js (secureFetch, escapeHtml, userRole,
 * openTextModal, lastBackupConfig).
 */
(function () {
    'use strict';

    const esc = (s) => escapeHtml(s == null ? '' : s);
    const DAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    const LEVEL = {
        ok: { label: 'Normal', cls: 'ok', icon: 'fa-circle-check' },
        act: { label: 'Atenção', cls: 'act', icon: 'fa-circle-info' },
        grow: { label: 'Alerta', cls: 'grow', icon: 'fa-triangle-exclamation' },
        emergency: { label: 'Emergência', cls: 'emergency', icon: 'fa-circle-exclamation' },
    };
    const JOB_STATE = {
        ok: ['badge-green', 'concluído'], failed: ['badge-red', 'falhou'], running: ['badge-blue', 'em execução'],
        stuck: ['badge-red', 'travado?'], noroom: ['badge-red', 'sem espaço: não iniciou'], never: ['', 'ainda não rodou'],
    };

    let data = null;
    let timer = null;
    let busy = false;

    const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '--');
    const num = (n, d = 1) => (n == null ? '--' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: d }));

    async function api(method, url, body) {
        const res = await secureFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'falha');
        return json;
    }

    window.loadProtection = async function (refresh) {
        if (userRole !== 'dba' || busy) return;
        try {
            const json = await api('GET', `/api/backup/protection${refresh ? '?refresh=1' : ''}`);
            data = json.data;
            render();
        } catch (err) {
            document.getElementById('prot-schedule').innerHTML = `<div class="result-box is-error"><strong>${esc(err.message)}</strong></div>`;
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (document.getElementById('backup')?.classList.contains('active')) refreshGuard();
        }, 30000);
    };

    async function refreshGuard() {
        try {
            const json = await api('GET', '/api/backup/protection');
            data = json.data;
            renderGuardStatus();
            renderSummary();
        } catch (e) { /* silencioso */ }
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (document.getElementById('backup')?.classList.contains('active')) refreshGuard();
        }, 30000);
    }

    function render() {
        renderLayers();
        renderSchedule();
        renderGuard();
        renderSummary();
    }

    // ------------------------------------------------------------------ resumo
    function renderSummary() {
        const el = document.getElementById('prot-summary');
        const inst = data.schedule.installed;
        const g = data.guard;
        const parts = [inst ? 'backups agendados ativos' : 'sem backup agendado', g.enabled ? 'guardião ativo' : 'guardião desligado'];
        el.textContent = parts.join(' · ');
        el.className = `card-subtitle ${inst && g.enabled ? 'txt-ok' : 'txt-warn'}`;
    }

    function renderLayers() {
        const cfg = typeof lastBackupConfig !== 'undefined' ? lastBackupConfig : null;
        const delpol = cfg && cfg.deletionPolicy ? cfg.deletionPolicy.enabled : null;
        const archOn = cfg && cfg.archivelog ? cfg.archivelog.LOG_MODE === 'ARCHIVELOG' : null;
        const inst = !!data.schedule.installed;
        const g = data.guard;
        const step = (ok, n, title, text) => `
            <div class="prot-layer ${ok === true ? 'is-ok' : ok === false ? 'is-off' : ''}">
                <span class="prot-layer-n">${ok === true ? '<i class="fas fa-check"></i>' : n}</span>
                <div><strong>${title}</strong><small>${text}</small></div>
            </div>`;
        document.getElementById('prot-layers').innerHTML = `
            ${step(inst, 1, 'Backups agendados', 'Rodam no próprio servidor, mesmo com o painel desligado, e tornam os archives recicláveis.')}
            ${step(delpol, 2, 'Política de deleção + retenção', delpol === false
                ? 'Desligada: sem ela a FRA não recicla os archives já copiados.<br><button class="btn-primary btn-xs" onclick="handleToggleDeletionPolicy().then(() => setTimeout(() => loadProtection(false), 1500))"><i class="fas fa-recycle"></i> Ativar agora</button>'
                : 'A FRA recicla sozinha os archives já copiados e os backups obsoletos.')}
            ${step(g.enabled, 3, 'Guardião da FRA', 'A cada minuto: backup extra, aumenta o limite, despeja em outro disco antes de encher.')}
            ${step(g.enabled && g.settings.lastResort, 4, 'Último recurso', 'Se nada mais der certo, apaga archives antigos para o banco não parar (e avisa).')}
            ${archOn === false ? '<div class="storage-warnings prot-wide"><i class="fas fa-circle-info"></i> O banco está em NOARCHIVELOG: a FRA não recebe archives (o risco de parada por FRA cheia não existe, mas também não há recuperação até o último commit).</div>' : ''}`;
    }

    // ------------------------------------------------------------------ agendamento
    function scheduleForm(s, ready) {
        const opt = (v, l, sel) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(l)}</option>`;
        const hours = [[1, '1 h'], [2, '2 h'], [3, '3 h'], [4, '4 h'], [6, '6 h'], [8, '8 h'], [12, '12 h'], [0, 'desligado']];
        const dirPh = ready.serverOs === 'windows' ? 'Ex.: E:\\BACKUP\\ORCL (outro disco)' : 'Ex.: /u04/backup/ORCL (outro disco)';
        return `
            <div class="prot-form">
                <div class="form-group">
                    <label class="form-label" for="ps-strategy">Estratégia</label>
                    <select id="ps-strategy" class="form-control">
                        ${opt('full', 'Backup completo todo dia', s.strategy)}
                        ${opt('incremental', 'Incremental: nível 0 semanal + nível 1 diário', s.strategy)}
                        ${opt('archivelog', 'Somente archivelogs', s.strategy)}
                    </select>
                </div>
                <div class="form-group" id="ps-level0-wrap" ${s.strategy === 'incremental' ? '' : 'hidden'}>
                    <label class="form-label" for="ps-level0">Dia do nível 0 (completo)</label>
                    <select id="ps-level0" class="form-control">${DAYS.map((d, i) => opt(i, d, s.level0Day)).join('')}</select>
                </div>
                <div class="form-group" id="ps-time-wrap" ${s.strategy === 'archivelog' ? 'hidden' : ''}>
                    <label class="form-label" for="ps-time">Horário</label>
                    <input id="ps-time" type="time" class="form-control" value="${esc(s.time)}">
                </div>
                <div class="form-group">
                    <label class="form-label" for="ps-arch">Backup dos archivelogs a cada</label>
                    <select id="ps-arch" class="form-control">${hours.map(([v, l]) => opt(v, l, s.archivelogHours)).join('')}</select>
                </div>
                <div class="form-group" id="ps-keep-wrap" ${s.strategy === 'archivelog' ? '' : 'hidden'}>
                    <label class="form-label" for="ps-keep">Guardar backups de archivelog (dias)</label>
                    <input id="ps-keep" type="number" min="1" max="90" class="form-control" value="${esc(s.archKeepDays || 7)}">
                </div>
                <div class="form-group">
                    <label class="form-label" for="ps-dest">Destino dos backups</label>
                    <select id="ps-dest" class="form-control">
                        ${opt('fra', 'FRA (padrão do RMAN)', s.destination)}
                        ${opt('dir', 'Diretório (recomendado: outro disco)', s.destination)}
                    </select>
                </div>
                <div class="form-group" id="ps-dir-wrap" ${s.destination === 'dir' ? '' : 'hidden'}>
                    <label class="form-label" for="ps-dir">Diretório dos backups</label>
                    <input id="ps-dir" class="form-control mono" value="${esc(s.directory)}" placeholder="${esc(dirPh)}" spellcheck="false">
                </div>
                <label class="check-row prot-check"><input type="checkbox" id="ps-compress" ${s.compress ? 'checked' : ''}> <span>Compactar os backups (compressão BASIC, sem licença extra)</span></label>
            </div>
            <div class="storage-warnings" id="ps-archonly-hint" ${s.strategy === 'archivelog' ? '' : 'hidden'}><i class="fas fa-triangle-exclamation"></i> <span><strong>Sem backup do banco pelo painel.</strong> Archivelogs sozinhos não restauram nada: eles só servem para recuperar a partir de um backup do banco feito por outra ferramenta (outro script RMAN, cópia a frio, snapshot). Guarde-os por pelo menos o intervalo entre esses backups.</span></div>
            <div class="form-hint" id="ps-fra-hint" ${s.destination === 'fra' && s.strategy !== 'archivelog' ? '' : 'hidden'}><i class="fas fa-shield-halved"></i> Com destino na FRA, antes de cada backup do banco o agendador confere se ele cabe: aumenta o limite da FRA se o disco permitir; se não couber, o backup do banco <strong>não começa</strong> (só os archivelogs são copiados) e você é avisado — a FRA nunca lota por causa do backup.</div>
            <div class="form-hint"><i class="fas fa-lightbulb"></i> Com os backups em <strong>outro disco</strong>, a FRA guarda só os archives do dia: ela fica pequena e um disco que falhe não leva o banco e o backup juntos.</div>`;
    }

    function jobsTable(state) {
        if (!state || !state.jobs || !state.jobs.length) return '';
        const rows = state.jobs.map((j) => {
            const [cls, label] = JOB_STATE[j.state] || JOB_STATE.never;
            return `<tr>
                <td><strong>${esc(j.label)}</strong><div class="form-hint">${esc(j.when)}</div></td>
                <td class="nowrap">${fmtDate(j.end || j.start)}</td>
                <td><span class="badge ${cls}">${esc(label)}</span></td>
                <td class="nowrap">${fmtDate(j.next)}</td>
                <td class="col-action">
                    <button class="btn-primary btn-xs btn-ghost" onclick="protJobLog('${esc(j.job)}')" ${j.log ? '' : 'disabled'}><i class="fas fa-file-lines"></i> Log</button>
                    <button class="btn-primary btn-xs" onclick="protRunJob('${esc(j.job)}')"><i class="fas fa-play"></i> Agora</button>
                </td>
            </tr>`;
        }).join('');
        return `<div class="table-container prot-jobs"><table>
            <thead><tr><th>Tarefa</th><th>Última execução</th><th>Resultado</th><th>Próxima</th><th class="col-action">Ações</th></tr></thead>
            <tbody>${rows}</tbody></table></div>
            ${state.error ? `<div class="form-hint is-warn">Não foi possível ler o status no servidor: ${esc(state.error)}</div>` : ''}`;
    }

    function renderSchedule() {
        const s = data.schedule;
        const ready = data.ready;
        const inst = s.installed;
        const pill = inst
            ? `<span class="prot-pill is-ok"><i class="fas fa-circle-check"></i> Instalado</span>`
            : '<span class="prot-pill is-off"><i class="fas fa-circle-minus"></i> Não instalado</span>';
        const where = inst ? `<div class="form-hint">${esc(inst.where || '')} · executa como <strong>${esc(inst.runAs)}</strong> · instalado em ${fmtDate(Date.parse(inst.at))} por ${esc(inst.by || '-')}</div>` : '';
        document.getElementById('prot-schedule').innerHTML = `
            <div class="prot-head"><h4><i class="fas fa-calendar-check"></i> 1. Backups agendados no servidor</h4>${pill}</div>
            ${where}
            ${ready.ok ? '' : `<div class="storage-warnings"><i class="fas fa-triangle-exclamation"></i> ${esc(ready.reason)}</div>`}
            ${jobsTable(data.scheduleState)}
            ${scheduleForm(s, ready)}
            <div id="ps-result"></div>
            <details class="op-details" id="ps-preview-box"><summary>Ver o que será instalado no servidor</summary><div id="ps-preview" class="form-hint">Carregando...</div></details>
            <div class="prot-actions">
                ${inst ? '<button class="btn-primary btn-muted" onclick="protRemoveSchedule()"><i class="fas fa-trash-can"></i> Remover agendamento</button>' : ''}
                <button class="btn-primary btn-success" onclick="protInstallSchedule()" ${ready.ok ? '' : 'disabled'}><i class="fas fa-calendar-plus"></i> ${inst ? 'Salvar e reinstalar' : 'Salvar e instalar no servidor'}</button>
            </div>`;
        const toggle = () => {
            const strategy = document.getElementById('ps-strategy').value;
            const dest = document.getElementById('ps-dest').value;
            document.getElementById('ps-level0-wrap').hidden = strategy !== 'incremental';
            document.getElementById('ps-time-wrap').hidden = strategy === 'archivelog';
            document.getElementById('ps-keep-wrap').hidden = strategy !== 'archivelog';
            document.getElementById('ps-archonly-hint').hidden = strategy !== 'archivelog';
            document.getElementById('ps-fra-hint').hidden = dest !== 'fra' || strategy === 'archivelog';
            document.getElementById('ps-dir-wrap').hidden = dest !== 'dir';
            const arch = document.getElementById('ps-arch');
            if (strategy === 'archivelog' && arch.value === '0') arch.value = '4';
        };
        ['ps-strategy', 'ps-dest'].forEach((id) => document.getElementById(id).addEventListener('change', toggle));
        document.getElementById('ps-preview-box').addEventListener('toggle', (e) => { if (e.target.open) loadPreview(); });
    }

    function scheduleInput() {
        return {
            strategy: document.getElementById('ps-strategy').value,
            level0Day: Number(document.getElementById('ps-level0').value),
            time: document.getElementById('ps-time').value,
            archivelogHours: Number(document.getElementById('ps-arch').value),
            archKeepDays: Number(document.getElementById('ps-keep').value),
            destination: document.getElementById('ps-dest').value,
            directory: document.getElementById('ps-dir').value.trim(),
            compress: document.getElementById('ps-compress').checked,
        };
    }

    async function loadPreview() {
        const el = document.getElementById('ps-preview');
        try {
            const p = (await api('POST', '/api/backup/protection/schedule/preview', { schedule: scheduleInput() })).data;
            el.innerHTML = `<p>${esc(p.where)}</p>${p.cron ? `<pre>${esc(p.cron.join('\n'))}</pre>` : ''}` +
                p.jobs.map((j) => `<p><strong>${esc(j.label)}</strong> — ${esc(j.when)}</p><pre>${esc(j.rman.join('\n'))}</pre>`).join('');
        } catch (err) {
            el.innerHTML = `<span class="txt-error">${esc(err.message)}</span>`;
        }
    }

    function resultBox(id, ok, text) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `<div class="result-box ${ok ? 'is-ok' : 'is-error'}"><strong><i class="fas ${ok ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> ${esc(text)}</strong></div>`;
    }

    window.protInstallSchedule = async function () {
        const btn = document.querySelector('#prot-schedule .btn-success');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Instalando no servidor...'; }
        busy = true;
        try {
            const json = await api('POST', '/api/backup/protection/schedule', { schedule: scheduleInput() });
            busy = false;
            await loadProtection(false);
            resultBox('ps-result', true, json.message);
        } catch (err) {
            busy = false;
            resultBox('ps-result', false, err.message);
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-calendar-plus"></i> Salvar e instalar no servidor'; }
        }
    };

    window.protRemoveSchedule = async function () {
        if (!confirm('Remover o agendamento de backups do servidor? Os logs anteriores são mantidos.')) return;
        try {
            const json = await api('DELETE', '/api/backup/protection/schedule');
            await loadProtection(false);
            resultBox('ps-result', true, json.message);
        } catch (err) {
            resultBox('ps-result', false, err.message);
        }
    };

    window.protRunJob = async function (job) {
        try {
            const json = await api('POST', '/api/backup/protection/schedule/run', { job });
            resultBox('ps-result', true, json.message);
            setTimeout(() => loadProtection(true), 15000);
        } catch (err) {
            resultBox('ps-result', false, err.message);
        }
    };

    window.protJobLog = async function (job) {
        try {
            const json = await api('GET', `/api/backup/protection/schedule/log/${encodeURIComponent(job)}`);
            openTextModal(`Log — ${job}`, json.data.text || '(vazio)');
        } catch (err) {
            openTextModal('Log', `Não foi possível ler o log: ${err.message}`);
        }
    };

    // ------------------------------------------------------------------ guardião
    function guardForm(g) {
        const n = (id, label, v, min, max, hint) => `
            <div class="form-group">
                <label class="form-label" for="${id}">${label}</label>
                <input id="${id}" type="number" class="form-control" min="${min}" max="${max}" value="${esc(v)}">
                ${hint ? `<div class="form-hint">${hint}</div>` : ''}
            </div>`;
        return `
            <div class="prot-form">
                ${n('pg-target', 'Atenção a partir de (%)', g.targetPct, 30, 90, 'Faz backup dos archives e limpa.')}
                ${n('pg-grow', 'Aumentar a FRA a partir de (%)', g.growPct, 40, 97, 'Ou se for encher em menos de 30 min.')}
                ${n('pg-emerg', 'Emergência a partir de (%)', g.emergencyPct, 50, 99, 'Ou com o archiver travado.')}
                ${n('pg-step', 'Aumento por vez (% do limite)', g.growStepPct, 5, 100, 'Mínimo de 5 GB por aumento.')}
                ${n('pg-reserve', 'Reserva livre no disco (%)', g.diskReservePct, 2, 50, 'Nunca cresce além disso (mín. 2 GB).')}
                ${n('pg-max', 'Teto da FRA (GB, 0 = sem teto)', g.maxSizeGb, 0, 102400, '')}
                <div class="form-group prot-wide">
                    <label class="form-label" for="pg-emdir">Diretório de emergência (em OUTRO disco)</label>
                    <input id="pg-emdir" class="form-control mono" value="${esc(g.emergencyDir)}" spellcheck="false"
                        placeholder="${data.ready.serverOs === 'windows' ? 'Ex.: F:\\ORACLE\\EMERGENCIA' : 'Ex.: /u05/oracle/emergencia'}">
                    <div class="form-hint">Se a FRA não puder crescer, os archives são copiados para cá (backup compactado) e removidos da FRA — a recuperação continua possível.</div>
                </div>
                <label class="check-row prot-check prot-wide prot-danger"><input type="checkbox" id="pg-last" ${g.lastResort ? 'checked' : ''}>
                    <span><strong>Último recurso:</strong> se nada mais funcionar, apagar archives antigos ainda sem backup para o banco não parar. O painel avisa e a recuperação fica comprometida até o próximo backup completo.</span></label>
            </div>`;
    }

    function renderGuard() {
        const g = data.guard;
        document.getElementById('prot-guard').innerHTML = `
            <div class="prot-head">
                <h4><i class="fas fa-shield-halved"></i> 2. Guardião da FRA</h4>
                <label class="prot-switch" title="Ligar/desligar o guardião">
                    <input type="checkbox" id="pg-enabled" ${g.enabled ? 'checked' : ''}><span></span>
                    <em id="pg-enabled-label">${g.enabled ? 'Ativo' : 'Desligado'}</em>
                </label>
            </div>
            <div id="pg-status"></div>
            ${guardForm(g.settings)}
            <div id="pg-result"></div>
            <div class="prot-actions">
                ${data.demo ? '<button class="btn-primary btn-ghost" onclick="protDemoSpike()" title="Modo DEMO"><i class="fas fa-flask"></i> Simular pico de archives</button>' : ''}
                <button class="btn-primary btn-muted" onclick="protCheckNow()"><i class="fas fa-stethoscope"></i> Verificar agora</button>
                <button class="btn-primary" onclick="protSaveGuard()"><i class="fas fa-save"></i> Salvar proteção</button>
            </div>
            <div id="pg-history"></div>`;
        document.getElementById('pg-enabled').addEventListener('change', (e) => {
            document.getElementById('pg-enabled-label').textContent = e.target.checked ? 'Ativo' : 'Desligado (salve para aplicar)';
        });
        renderGuardStatus();
    }

    function renderGuardStatus() {
        const g = data.guard;
        const m = g.measure;
        const d = g.decision;
        const st = document.getElementById('pg-status');
        const hist = document.getElementById('pg-history');
        if (!st) return;
        let html = '';
        if (g.compromisedSince) {
            html += `<div class="result-box is-error"><strong><i class="fas fa-triangle-exclamation"></i> Recuperação comprometida desde ${esc(new Date(g.compromisedSince).toLocaleString('pt-BR'))}</strong><div class="form-hint">O guardião apagou archives sem backup para o banco não parar. Faça um backup completo (botão "Backup sob demanda" acima).</div></div>`;
        }
        if (g.error) html += `<div class="storage-warnings"><i class="fas fa-triangle-exclamation"></i> Última verificação falhou: ${esc(g.error)}</div>`;
        if (m && d && m.limitGb) {
            const lv = LEVEL[d.level] || LEVEL.ok;
            const s = g.settings;
            const pct = Math.min(100, d.pct || 0);
            let pace = 'ritmo: medindo (alguns minutos)';
            if (m.rateGbH != null) {
                const eta = d.etaMin == null ? 'sem crescimento' : d.etaMin > 48 * 60 ? 'mais de 2 dias para encher' : `enche em ~${d.etaMin >= 120 ? `${Math.round(d.etaMin / 60)} h` : `${d.etaMin} min`}`;
                pace = `ritmo +${num(m.rateGbH)} GB/h · ${eta}`;
            }
            html += `
                <div class="prot-gauge-head">
                    <span class="prot-pill is-${lv.cls}"><i class="fas ${lv.icon}"></i> ${lv.label}</span>
                    <strong>${num(d.pct)}%</strong> <span>de ${num(m.limitGb)} GB · ${pace}</span>
                </div>
                <div class="prot-gauge" title="Uso efetivo da FRA (usado − reciclável)">
                    <span class="prot-gauge-fill is-${lv.cls}" style="width:${pct}%"></span>
                    <i style="left:${s.targetPct}%" title="Atenção ${s.targetPct}%"></i>
                    <i style="left:${s.growPct}%" title="Aumentar ${s.growPct}%"></i>
                    <i style="left:${s.emergencyPct}%" class="is-red" title="Emergência ${s.emergencyPct}%"></i>
                </div>
                <div class="prot-facts">
                    <span><i class="fas fa-box-archive"></i> Archives sem backup: <strong>${num(m.unbackedGb)} GB</strong></span>
                    <span><i class="fas fa-recycle"></i> Reciclável: <strong>${num(m.reclaimGb)} GB</strong></span>
                    <span><i class="fas fa-hard-drive"></i> Disco da FRA: <strong>${m.disk ? `${num(m.disk.freeGB)} GB livres` : 'desconhecido'}</strong></span>
                    ${s.emergencyDir ? `<span><i class="fas fa-life-ring"></i> Emergência: <strong>${m.emergencyDisk ? `${num(m.emergencyDisk.freeGB)} GB livres` : 'sem leitura'}</strong></span>` : ''}
                    <span><i class="fas fa-gears"></i> Archiver: <strong>${esc(m.archiver || '--')}</strong></span>
                </div>`;
            if (g.busy) {
                html += `<div class="result-box"><strong><i class="fas fa-spinner fa-spin"></i> Executando: ${esc(g.busy.label)}</strong></div>`;
            } else if (d.level !== 'ok') {
                const nextTxt = d.action ? `<strong>Ação ${g.enabled ? 'em andamento/próxima' : 'que seria feita'}:</strong> ${esc(d.action.label)}${d.action.newGb ? ` (para ${d.action.newGb} GB)` : ''}` : '<strong class="txt-error">Nenhuma ação possível agora.</strong>';
                const skip = d.skipped && d.skipped.length ? `<ul class="step-list">${d.skipped.map((x) => `<li>${esc(x.label || x.kind)}: ${esc(x.why)}</li>`).join('')}</ul>` : '';
                html += `<div class="form-hint">${nextTxt}${skip}</div>`;
            }
            html += `<div class="form-hint">Verificado em ${esc(new Date(g.lastCheck).toLocaleString('pt-BR'))}${m.via === 'sysdba' ? ' (via SYSDBA)' : ''}${g.automation ? '' : ' · <span class="txt-warn">sem RMAN configurado: só consegue aumentar o limite</span>'}</div>`;
        } else if (m && !m.limitGb) {
            html += '<div class="storage-warnings"><i class="fas fa-circle-info"></i> A FRA não está configurada (DB_RECOVERY_FILE_DEST vazio). Defina o tamanho da FRA acima.</div>';
        } else if (!g.error) {
            html += '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i> Primeira verificação em andamento...</div>';
        }
        st.innerHTML = html;

        const rows = (g.history || []).slice(0, 12).map((h) => `
            <tr>
                <td class="nowrap">${esc(new Date(h.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</td>
                <td>${h.level && LEVEL[h.level] ? `<span class="prot-pill is-${LEVEL[h.level].cls}">${LEVEL[h.level].label}</span>` : ''}</td>
                <td><strong>${esc(h.label)}</strong>${h.detail ? `<div class="form-hint">${esc(h.detail)}</div>` : ''}${h.reason ? `<div class="form-hint">${esc(h.reason)}</div>` : ''}</td>
                <td class="nowrap">${h.pctBefore != null ? `${num(h.pctBefore)}% → ${h.pctAfter != null ? `${num(h.pctAfter)}%` : '?'}` : ''}</td>
                <td><span class="badge ${h.ok ? 'badge-green' : 'badge-red'}">${h.ok ? 'ok' : 'falhou'}</span></td>
            </tr>`).join('');
        hist.innerHTML = `<h5 class="prot-sub"><i class="fas fa-clock-rotate-left"></i> Ações do guardião</h5>` + (rows
            ? `<div class="table-container"><table><thead><tr><th>Quando</th><th>Nível</th><th>Ação</th><th>FRA</th><th>Resultado</th></tr></thead><tbody>${rows}</tbody></table></div>`
            : '<div class="form-hint">Nenhuma ação até agora — a FRA está dentro dos limites.</div>');
    }

    function guardInput() {
        return {
            enabled: document.getElementById('pg-enabled').checked,
            targetPct: Number(document.getElementById('pg-target').value),
            growPct: Number(document.getElementById('pg-grow').value),
            emergencyPct: Number(document.getElementById('pg-emerg').value),
            growStepPct: Number(document.getElementById('pg-step').value),
            diskReservePct: Number(document.getElementById('pg-reserve').value),
            maxSizeGb: Number(document.getElementById('pg-max').value || 0),
            emergencyDir: document.getElementById('pg-emdir').value.trim(),
            lastResort: document.getElementById('pg-last').checked,
        };
    }

    window.protSaveGuard = async function () {
        try {
            const json = await api('POST', '/api/backup/protection/guard', { guard: guardInput() });
            data.guard = json.data;
            renderGuard();
            renderLayers();
            renderSummary();
            resultBox('pg-result', true, json.message);
        } catch (err) {
            resultBox('pg-result', false, err.message);
        }
    };

    window.protCheckNow = async function () {
        const st = document.getElementById('pg-status');
        if (st) st.insertAdjacentHTML('afterbegin', '<div class="result-box" id="pg-checking"><strong><i class="fas fa-spinner fa-spin"></i> Verificando a FRA...</strong></div>');
        try {
            const json = await api('POST', '/api/backup/protection/guard/check');
            data.guard = json.data;
            renderGuardStatus();
            if (typeof refreshAllSections === 'function') setTimeout(() => { try { loadBackupData(true); } catch (e) { /* ignore */ } }, 300);
        } catch (err) {
            resultBox('pg-result', false, err.message);
            document.getElementById('pg-checking')?.remove();
        }
    };

    window.protDemoSpike = async function () {
        try {
            await api('POST', '/api/backup/protection/guard/demo-spike');
            await protCheckNow();
        } catch (err) {
            resultBox('pg-result', false, err.message);
        }
    };
})();

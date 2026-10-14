/**
 * RECOVERY.JS - Tela "Recuperação": diagnóstico, consulta de erros, catálogo de
 * procedimentos, plano revisável e execução acompanhada passo a passo.
 * Usa os utilitários globais do main.js (secureFetch, escapeHtml, userRole,
 * openOpModal/closeOpModal, copyText, fmtOffset).
 */
(function () {
    'use strict';

    const SEV = {
        critical: { label: 'Crítico', icon: 'fa-circle-exclamation' },
        high: { label: 'Alto', icon: 'fa-triangle-exclamation' },
        medium: { label: 'Médio', icon: 'fa-circle-info' },
        low: { label: 'Baixo', icon: 'fa-circle-info' },
        info: { label: 'Info', icon: 'fa-circle-info' },
    };
    const OVERALL = {
        ok: { label: 'Saudável', icon: 'fa-heart-pulse', text: 'Nenhum problema ativo encontrado.' },
        attention: { label: 'Atenção', icon: 'fa-circle-info', text: 'Há pontos a corrigir, sem risco imediato.' },
        warning: { label: 'Alerta', icon: 'fa-triangle-exclamation', text: 'Há problemas que podem parar o banco ou perder dados.' },
        critical: { label: 'Crítico', icon: 'fa-circle-exclamation', text: 'O banco está fora do ar ou com dados inacessíveis.' },
    };
    const RISK = { low: 'Baixo risco', medium: 'Risco moderado', high: 'Alto risco' };
    // Mensagens que só identificam o objeto/erro do SO de um erro principal (mesma lista do servidor).
    const COMPANION = ['ORA-01110', 'ORA-00312', 'ORA-00202', 'ORA-27037', 'ORA-27041', 'ORA-27072', 'ORA-27301', 'ORA-27302', 'ORA-06512', 'ORA-00283'];
    const CHIPS = [
        'ORA-00600: internal error code, arguments: [kcratr_scan_lastbwr], [], []',
        'ORA-03113: end-of-file on communication channel',
        'ORA-01578: ORACLE data block corrupted (file # 7, block # 1234)',
        'ORA-00257: archiver error. Connect internal only, until freed.',
        'ORA-00313: open failed for members of log group 2 of thread 1',
        'recover database until cancel',
    ];

    let diag = null;          // { signals, report }
    let catalog = [];         // procedimentos
    let catalogById = {};
    let currentPlan = null;   // plano aberto no modal
    let planTimer = null;
    let jobTimer = null;
    let loading = false;
    const actions = {};       // chave → { id, params } (botões de procedimento)
    let actionSeq = 0;

    const esc = (s) => escapeHtml(s == null ? '' : s);
    const isDba = () => userRole === 'dba';

    function actionKey(id, params) {
        const k = `a${++actionSeq}`;
        actions[k] = { id, params: params || {} };
        return k;
    }

    function fmtDate(iso) {
        if (!iso) return '--';
        const d = new Date(iso);
        return Number.isFinite(d.getTime()) ? d.toLocaleString('pt-BR') : esc(iso);
    }

    function ageText(text) {
        if (!text) return 'nunca';
        const t = Date.parse(String(text).replace(' ', 'T'));
        if (!Number.isFinite(t)) return esc(text);
        const h = (Date.now() - t) / 3600000;
        if (h < 1) return 'há minutos';
        if (h < 48) return `há ${Math.round(h)} h`;
        return `há ${Math.round(h / 24)} dias`;
    }

    // ===================================================================== carga
    async function ensureCatalog() {
        if (catalog.length) return;
        const res = await secureFetch('/api/recovery/playbooks');
        const json = await res.json();
        if (json.success) {
            catalog = json.data;
            catalogById = Object.fromEntries(catalog.map((p) => [p.id, p]));
        }
    }

    window.loadRecovery = async function (force) {
        if (loading) return;
        loading = true;
        const btn = document.querySelector('#recovery .header-actions .btn-muted i');
        if (btn) btn.classList.add('fa-spin');
        if (force || !diag) {
            document.getElementById('rec-status').innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i> Analisando o banco (instância, arquivos, redo, controlfile, FRA, corrupção e alert log)...</div>';
        }
        try {
            await ensureCatalog();
            const res = await secureFetch(`/api/recovery/diagnosis${force ? '?refresh=1' : ''}`);
            const json = await res.json();
            if (!json.success) throw new Error(json.error || 'falha no diagnóstico');
            diag = json.data;
            renderAll();
            if (isDba()) loadRecoveryJobs();
        } catch (err) {
            document.getElementById('rec-status').innerHTML = `<div class="result-box is-error"><strong><i class="fas fa-circle-xmark"></i> Não foi possível analisar: ${esc(err.message)}</strong></div>`;
        } finally {
            loading = false;
            if (btn) btn.classList.remove('fa-spin');
        }
    };

    function renderAll() {
        renderStatus();
        renderFindings();
        renderReadiness();
        renderPlaybookLibrary();
        renderAlertLog();
        renderChips();
        renderDemoScenarios();
        updateNavBadge(diag.report);
        const assist = document.getElementById('rec-assist-btn');
        if (assist) {
            const rec = diag.report.recommended;
            assist.disabled = !rec;
            assist.title = rec ? `Abre o procedimento recomendado: ${(catalogById[rec.id] || {}).title || rec.id}` : 'Nenhum procedimento recomendado agora';
        }
    }

    function updateNavBadge(report) {
        const el = document.getElementById('nav-rec-badge');
        if (!el || !report) return;
        const n = report.counts.critical + report.counts.high;
        el.hidden = n === 0;
        el.textContent = n;
        el.className = `nav-badge ${report.counts.critical ? 'is-critical' : 'is-high'}`;
        el.title = `${report.counts.critical} crítico(s), ${report.counts.high} alto(s)`;
    }

    // Selo no menu: verificação leve em segundo plano (o servidor cacheia).
    async function backgroundCheck() {
        try {
            const res = await secureFetch('/api/recovery/diagnosis');
            const json = await res.json();
            if (json.success) {
                updateNavBadge(json.data.report);
                if (document.getElementById('recovery')?.classList.contains('active') && !document.getElementById('opModal')?.style.display.includes('block')) {
                    diag = json.data;
                    await ensureCatalog();
                    renderAll();
                }
            }
        } catch (e) { /* silencioso */ }
    }
    let watchStarted = false;
    /** Chamado pelo initApp (main.js) depois do login. */
    window.startRecoveryWatch = function () {
        if (watchStarted) return;
        watchStarted = true;
        setTimeout(backgroundCheck, 4000);
        setInterval(backgroundCheck, 10 * 60 * 1000);
    };

    // ===================================================================== status
    function renderStatus() {
        const s = diag.signals;
        const r = diag.report;
        const o = OVERALL[r.overall] || OVERALL.ok;
        const st = s.state;
        const stClass = st === 'OPEN' ? 'ok' : st === 'MOUNTED' || st === 'STARTED' ? 'warn' : 'bad';
        const inst = s.instance ? `${esc(s.instance.name)} · ${esc(s.instance.version || '')}${s.instance.host ? ` · ${esc(s.instance.host)}` : ''}` : (s.connection && s.connection.error ? esc(s.connection.error.message) : 'sem dados da instância');
        const db = s.database;
        const fra = s.fra;
        const fraCls = !fra ? '' : fra.usedPct >= 90 ? 'bad' : fra.usedPct >= 75 ? 'warn' : 'ok';
        const counts = [];
        if (r.counts.critical) counts.push(`${r.counts.critical} crítico(s)`);
        if (r.counts.high) counts.push(`${r.counts.high} alto(s)`);
        if (r.counts.medium) counts.push(`${r.counts.medium} médio(s)`);
        const cap = s.capabilities || {};
        document.getElementById('rec-status').innerHTML = `
            <div class="rec-overall is-${r.overall}">
                <i class="fas ${o.icon}"></i>
                <div>
                    <strong>${o.label}</strong>
                    <span>${counts.length ? counts.join(' · ') : o.text}</span>
                </div>
            </div>
            <div class="rec-tile is-${stClass}">
                <span class="rec-tile-label">Instância</span>
                <strong>${esc(s.stateLabel || st)}</strong>
                <small title="${inst}">${inst}</small>
            </div>
            <div class="rec-tile ${db ? (db.logMode === 'ARCHIVELOG' ? 'is-ok' : 'is-bad') : ''}">
                <span class="rec-tile-label">Modo de log</span>
                <strong>${db ? esc(db.logMode) : '--'}</strong>
                <small>${db ? `Flashback: ${esc(db.flashbackOn)} · ${esc(s.edition || '')}` : '--'}</small>
            </div>
            <div class="rec-tile">
                <span class="rec-tile-label">Último backup</span>
                <strong>${db && s.backups ? ageText(s.backups.lastDb || s.backups.newestAny) : '--'}</strong>
                <small>${!db ? 'sem acesso ao controlfile' : s.backups && s.backups.lastArch ? `Archivelogs: ${ageText(s.backups.lastArch)}` : 'Archivelogs: --'}</small>
            </div>
            <div class="rec-tile ${fraCls ? `is-${fraCls}` : ''}">
                <span class="rec-tile-label">FRA</span>
                <strong>${fra ? `${String(fra.usedPct).replace('.', ',')}%` : '--'}</strong>
                <small>${fra ? `${Math.round(fra.limitMb / 1024)} GB de limite` : db ? 'não configurada' : 'sem acesso ao controlfile'}</small>
            </div>
            <div class="rec-source">
                <i class="fas fa-circle-info"></i> Análise de ${fmtDate(s.at)} via ${esc(s.source)}${cap.automation ? '' : ' · execução automática não configurada (DB_ORACLE_HOME / DB_ORACLE_SID / DB_SYS_PASSWORD)'}${s.demo ? ' · <strong>modo DEMO</strong>' : ''}
            </div>`;
    }

    // ===================================================================== problemas
    function playbookButtons(f) {
        return (f.playbooks || []).map((p) => {
            const meta = catalogById[p.id];
            if (!meta) return '';
            const k = actionKey(p.id, p.params);
            return `<button class="btn-primary btn-xs ${p.recommended ? 'btn-success' : 'btn-ghost'}" onclick="openPlanByKey('${k}')" title="${esc(p.reason || meta.summary)}">
                <i class="fas ${p.recommended ? 'fa-wand-magic-sparkles' : 'fa-list-check'}"></i> ${esc(p.label || meta.title)}${p.recommended ? ' <span class="rec-recommended">recomendado</span>' : ''}</button>`;
        }).join('');
    }

    function findingCard(f) {
        const sev = SEV[f.severity] || SEV.info;
        const evidence = f.evidence && f.evidence.length ? `<ul class="rec-evidence">${f.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '';
        const samples = f.samples && f.samples.length
            ? `<details class="op-details"><summary>Trecho do alert log (${f.samples.length})</summary><pre>${esc(f.samples.map((x) => `${x.time || ''}\n${x.text}`).join('\n\n'))}</pre></details>` : '';
        const actionsList = f.actions && f.actions.length
            ? `<details class="op-details"><summary>O que fazer</summary><ul class="rec-evidence">${f.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></details>` : '';
        const link = f.link ? `<button class="btn-primary btn-xs btn-ghost" onclick="goToSection('${esc(f.link.section)}')"><i class="fas fa-arrow-right"></i> ${esc(f.link.label)}</button>` : '';
        return `
            <article class="rec-finding sev-${f.severity} ${f.status === 'historical' ? 'is-historical' : ''}">
                <div class="rec-finding-head">
                    <span class="rec-sev sev-${f.severity}"><i class="fas ${sev.icon}"></i> ${sev.label}</span>
                    ${f.code ? `<span class="chip">${esc(f.code)}${f.arg ? ` [${esc(f.arg)}]` : ''}</span>` : ''}
                    <span class="chip">${esc(f.categoryLabel)}</span>
                    ${f.status === 'historical' ? '<span class="chip chip-muted"><i class="fas fa-clock-rotate-left"></i> histórico</span>' : ''}
                    ${f.lastSeen ? `<span class="rec-when">último: ${esc(f.lastSeen)}${f.count > 1 ? ` · ${f.count}x` : ''}</span>` : ''}
                </div>
                <h4>${esc(f.title)}</h4>
                <p>${esc(f.detail)}</p>
                ${evidence}${actionsList}${samples}
                ${(f.playbooks && f.playbooks.length) || link ? `<div class="rec-finding-actions">${playbookButtons(f)}${link}</div>` : ''}
            </article>`;
    }

    function renderFindings() {
        const r = diag.report;
        const el = document.getElementById('rec-findings');
        const active = r.findings.filter((f) => f.status === 'active');
        const hist = r.findings.filter((f) => f.status !== 'active');
        document.getElementById('rec-findings-count').textContent = `${active.length} ativo(s)${hist.length ? ` · ${hist.length} histórico(s)` : ''}`;
        if (!r.findings.length) {
            el.innerHTML = '<div class="rec-empty"><i class="fas fa-circle-check"></i><strong>Nenhum problema encontrado</strong><span>Instância, arquivos, redo, controlfile, FRA, corrupção e alert log dos últimos dias estão em ordem.</span></div>';
            return;
        }
        el.innerHTML = active.map(findingCard).join('') +
            (hist.length ? `<details class="rec-history"><summary><i class="fas fa-clock-rotate-left"></i> Ocorrências anteriores à última abertura do banco (${hist.length})</summary>${hist.map(findingCard).join('')}</details>` : '') +
            (!active.length ? '<div class="rec-empty"><i class="fas fa-circle-check"></i><strong>Nenhum problema ativo</strong><span>Só há registros antigos, já superados.</span></div>' : '');
    }

    // ===================================================================== prontidão
    function renderReadiness() {
        const rd = diag.report.readiness;
        const score = document.getElementById('rec-score');
        const cls = rd.score == null ? '' : rd.score >= 85 ? 'is-ok' : rd.score >= 60 ? 'is-warn' : 'is-bad';
        score.className = `rec-score ${cls}`;
        score.textContent = rd.score == null ? (rd.grade || '--') : `${rd.score}% · ${rd.grade}`;
        const icon = { ok: 'fa-circle-check', warn: 'fa-triangle-exclamation', bad: 'fa-circle-xmark', info: 'fa-circle-info' };
        const note = rd.note ? `<div class="form-hint is-warn"><i class="fas fa-circle-info"></i> ${esc(rd.note)}</div>` : '';
        // Itens com procedimento que os resolve ganham um botão (abre o plano para revisão).
        const actionBtn = (i) => {
            if (!i.action || !catalogById[i.action.id] || !isDba()) return '';
            const k = actionKey(i.action.id, {});
            return `<button class="btn-primary btn-xs rec-ready-act" onclick="openPlanByKey('${k}')" title="${esc(catalogById[i.action.id].summary)}"><i class="fas fa-wand-magic-sparkles"></i> ${esc(i.action.label)}</button>`;
        };
        document.getElementById('rec-readiness').innerHTML = note + rd.items.map((i) => `
            <div class="rec-ready is-${i.status}">
                <i class="fas ${icon[i.status] || 'fa-circle'}"></i>
                <div><strong>${esc(i.label)}</strong><span>${esc(i.detail)}</span>${actionBtn(i)}</div>
            </div>`).join('');
    }

    // ===================================================================== catálogo
    window.renderPlaybookLibrary = function () {
        const el = document.getElementById('rec-playbooks');
        if (!el) return;
        const q = (document.getElementById('rec-pb-filter')?.value || '').trim().toLowerCase();
        const state = diag ? diag.signals.state : 'UNKNOWN';
        const list = catalog.filter((p) => !q || `${p.title} ${p.summary} ${p.when}`.toLowerCase().includes(q));
        if (!list.length) {
            el.innerHTML = '<div class="empty-state">Nenhum procedimento corresponde ao filtro.</div>';
            return;
        }
        el.innerHTML = list.map((p) => {
            const applies = state === 'UNKNOWN' || p.states.includes(state);
            const k = actionKey(p.id, {});
            return `
                <div class="rec-pb ${applies ? '' : 'is-na'}">
                    <div class="rec-pb-head">
                        <strong>${esc(p.title)}</strong>
                        <span class="risk-badge risk-${p.risk}">${RISK[p.risk]}</span>
                    </div>
                    <p>${esc(p.summary)}</p>
                    <small><strong>Quando usar:</strong> ${esc(p.when)}</small>
                    <div class="rec-pb-foot">
                        <span class="rec-pb-flags">${p.downtime ? '<span class="chip chip-temp"><i class="fas fa-power-off"></i> exige parada</span>' : '<span class="chip"><i class="fas fa-bolt"></i> com o banco no ar</span>'}${p.dataLoss ? '<span class="chip chip-danger"><i class="fas fa-triangle-exclamation"></i> pode perder dados</span>' : ''}</span>
                        <button class="btn-primary btn-xs ${applies ? '' : 'btn-ghost'}" onclick="openPlanByKey('${k}')" title="${applies ? 'Ver o plano' : `Não se aplica com a instância ${esc(diag ? diag.signals.stateLabel : '')} — veja mesmo assim`}">
                            <i class="fas fa-list-check"></i> Ver plano</button>
                    </div>
                </div>`;
        }).join('');
    };

    // ===================================================================== alert log
    window.renderAlertLog = function () {
        const body = document.getElementById('rec-alert-body');
        const srcEl = document.getElementById('rec-alert-source');
        if (!body || !diag) return;
        const a = diag.signals.alert;
        if (!a) {
            body.innerHTML = '<tr><td colspan="3" class="empty-cell">Alert log indisponível.</td></tr>';
            return;
        }
        srcEl.innerHTML = a.source
            ? `<i class="fas fa-file-lines"></i> Fonte: ${esc(a.source)} · últimos ${a.days} dia(s)`
            : `<span class="txt-warn"><i class="fas fa-triangle-exclamation"></i> ${esc(a.error || 'Não foi possível ler o alert log.')}</span>`;
        const filter = document.getElementById('rec-alert-filter')?.value || 'all';
        const evLabel = { startup: 'Início', crash: 'Queda', shutdown: 'Desligamento', open: 'Abertura', resetlogs: 'RESETLOGS', 'crash-recovery': 'Recuperação', 'media-recovery': 'Recuperação', mount: 'Montagem', 'archiver-ok': 'Archiver', 'archiver-error': 'Archiver' };
        const rows = (a.records || []).filter((r) => (filter === 'errors' ? r.codes.length : filter === 'events' ? r.event : true));
        if (!rows.length) {
            body.innerHTML = `<tr><td colspan="3" class="empty-cell">${a.source ? 'Nenhum registro relevante no período.' : '—'}</td></tr>`;
            return;
        }
        body.innerHTML = rows.slice(0, 150).map((r) => {
            const kind = r.codes.length
                ? r.codes.slice(0, 4).map((c) => `<span class="chip ${COMPANION.includes(c.code) ? '' : 'chip-danger'}" ${COMPANION.includes(c.code) ? 'title="Mensagem complementar (identifica o objeto ou o erro do SO)"' : ''}>${esc(c.code)}${c.arg ? ` [${esc(c.arg)}]` : ''}</span>`).join(' ')
                : `<span class="chip ${r.event === 'crash' || r.event === 'archiver-error' ? 'chip-danger' : r.event === 'open' ? 'chip-ok' : ''}">${esc(evLabel[r.event] || r.event || '-')}</span>`;
            return `<tr><td class="nowrap mono">${esc(r.time || '--')}</td><td>${kind}</td><td><pre class="rec-log-text">${esc(r.text)}</pre></td></tr>`;
        }).join('');
    };

    // ===================================================================== consulta de erro
    function renderChips() {
        const el = document.getElementById('rec-lookup-chips');
        if (!el || el.childElementCount) return;
        el.innerHTML = CHIPS.map((c, i) => `<button type="button" class="chip chip-btn" data-i="${i}">${esc(c.length > 34 ? c.slice(0, 32) + '…' : c)}</button>`).join('');
        el.querySelectorAll('.chip-btn').forEach((b) => b.addEventListener('click', () => {
            document.getElementById('rec-lookup-input').value = CHIPS[Number(b.dataset.i)];
            runErrorLookup();
        }));
        document.getElementById('rec-lookup-input').addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runErrorLookup(); }
        });
    }

    window.runErrorLookup = async function () {
        const text = document.getElementById('rec-lookup-input').value;
        const out = document.getElementById('rec-lookup-result');
        if (!text.trim()) { out.innerHTML = '<div class="form-hint is-warn">Cole uma mensagem de erro ou um código.</div>'; return; }
        out.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i> Analisando...</div>';
        try {
            await ensureCatalog();
            const res = await secureFetch('/api/recovery/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
            const json = await res.json();
            if (!json.success) throw new Error(json.error);
            const items = json.data.items;
            if (!items.length) {
                out.innerHTML = '<div class="result-box is-warn"><strong>Nenhum código ORA-/RMAN-/TNS- encontrado no texto.</strong><div class="form-hint">Cole a linha do erro como aparece (ex.: "ORA-01578: ORACLE data block corrupted ...").</div></div>';
                return;
            }
            out.innerHTML = items.map((it) => {
                if (!it.known) {
                    return `<div class="rec-kb is-unknown"><div class="rec-kb-head"><span class="chip">${esc(it.code)}</span><strong>Código fora da base do painel</strong></div><p>Consulte a documentação Oracle (docs.oracle.com → Error Messages) ou o My Oracle Support para ${esc(it.code)}.</p></div>`;
                }
                const e = it.entry;
                const sev = SEV[e.severity] || SEV.info;
                const pbs = (e.playbooks || []).map((p) => {
                    const meta = catalogById[p.id];
                    if (!meta) return '';
                    const k = actionKey(p.id, {});
                    return `<button class="btn-primary btn-xs ${p.applicable ? '' : 'btn-ghost'}" onclick="openPlanByKey('${k}')"><i class="fas fa-list-check"></i> ${esc(meta.title)}</button>`;
                }).join('');
                const related = it.related && it.related.length
                    ? `<div class="rec-related"><strong><i class="fas fa-link"></i> No seu banco agora:</strong><ul>${it.related.map((r) => `<li><span class="rec-sev sev-${r.severity}">${(SEV[r.severity] || SEV.info).label}</span> ${esc(r.title)}</li>`).join('')}</ul></div>`
                    : (e.correlate ? '<div class="rec-related"><strong><i class="fas fa-link"></i> No seu banco agora:</strong> nenhum problema ativo relacionado foi encontrado — a causa provável é de rede/sessão ou já passou. Veja o alert log no horário do erro.</div>' : '');
                return `
                    <div class="rec-kb sev-${e.severity}">
                        <div class="rec-kb-head">
                            <span class="rec-sev sev-${e.severity}"><i class="fas ${sev.icon}"></i> ${sev.label}</span>
                            <span class="chip">${esc(it.code)}${it.arg ? ` [${esc(it.arg)}]` : ''}</span>
                            <span class="chip">${esc(e.categoryLabel || '')}</span>
                            <strong>${esc(e.title)}</strong>
                        </div>
                        <p>${esc(e.meaning)}</p>
                        <div class="rec-kb-cols">
                            ${e.causes && e.causes.length ? `<div><strong>Causas comuns</strong><ul>${e.causes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
                            ${e.actions && e.actions.length ? `<div><strong>O que fazer</strong><ul>${e.actions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
                        </div>
                        ${related}
                        ${pbs || e.link ? `<div class="rec-finding-actions">${pbs}${e.link ? `<button class="btn-primary btn-xs btn-ghost" onclick="goToSection('${esc(e.link.section)}')"><i class="fas fa-arrow-right"></i> ${esc(e.link.label)}</button>` : ''}</div>` : ''}
                    </div>`;
            }).join('');
        } catch (err) {
            out.innerHTML = `<div class="result-box is-error"><strong>${esc(err.message)}</strong></div>`;
        }
    };

    window.goToSection = function (id) {
        const link = document.querySelector(`.nav-item[data-section="${id}"]`);
        if (link) link.click();
    };

    // ===================================================================== cenários DEMO
    function renderDemoScenarios() {
        const sel = document.getElementById('rec-demo-scenario');
        if (!sel) return;
        const d = diag.signals.demo;
        if (!d || !isDba()) { sel.hidden = true; return; }
        sel.hidden = false;
        sel.innerHTML = Object.entries(d.scenarios).map(([k, v]) => `<option value="${esc(k)}" ${k === d.scenario ? 'selected' : ''}>DEMO: ${esc(v)}</option>`).join('');
    }

    window.setDemoScenario = async function (name) {
        await secureFetch('/api/recovery/demo-scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: name }) });
        loadRecovery(true);
    };

    // ===================================================================== plano
    window.openPlanByKey = function (k) {
        const a = actions[k];
        if (a) openPlan(a.id, a.params);
    };

    window.openRecommendedPlan = function () {
        const rec = diag && diag.report.recommended;
        if (rec) openPlan(rec.id, rec.params);
    };

    async function fetchPlan(id, params) {
        const res = await secureFetch('/api/recovery/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playbook: id, params }) });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Falha ao montar o plano');
        return json.data;
    }

    async function openPlan(id, params) {
        stopJobPolling();
        const meta = catalogById[id] || { title: id };
        openOpModal({ title: meta.title, subtitle: 'Montando o plano...', body: '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i> Conferindo o estado do banco...</div>', wide: true, onClose: stopJobPolling });
        try {
            currentPlan = await fetchPlan(id, params);
            renderPlan();
        } catch (err) {
            document.getElementById('opModalBody').innerHTML = `<div class="result-box is-error"><strong>${esc(err.message)}</strong></div>`;
        }
    }

    function fieldHtml(f) {
        const id = `pf-${f.name}`;
        const hidden = f.showIf && Object.entries(f.showIf).some(([k, v]) => String(currentPlan.params[k]) !== String(v));
        if (hidden) return '';
        const hint = f.hint ? `<div class="form-hint">${esc(f.hint)}</div>` : '';
        if (f.type === 'checkbox') {
            return `<label class="check-row"><input type="checkbox" id="${id}" data-param="${esc(f.name)}" ${f.value ? 'checked' : ''}> <span>${esc(f.label)}</span></label>${hint}`;
        }
        let input;
        if (f.type === 'select') {
            input = `<select id="${id}" class="form-control" data-param="${esc(f.name)}">${(f.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
        } else {
            const list = f.suggestions && f.suggestions.length ? `list="${id}-list"` : '';
            input = `<input id="${id}" class="form-control" data-param="${esc(f.name)}" type="${f.type === 'number' ? 'number' : 'text'}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} value="${esc(f.value ?? '')}" ${list} spellcheck="false" autocomplete="off">` +
                (list ? `<datalist id="${id}-list">${f.suggestions.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>` : '');
        }
        return `<div class="form-group"><label class="form-label" for="${id}">${esc(f.label)}</label>${input}${hint}</div>`;
    }

    function collectParams() {
        const p = { ...currentPlan.params };
        document.querySelectorAll('#opModalBody [data-param]').forEach((el) => {
            const k = el.dataset.param;
            if (el.type === 'checkbox') p[k] = el.checked;
            else if (el.type === 'number') p[k] = el.value === '' ? '' : Number(el.value);
            else p[k] = el.value;
        });
        return p;
    }

    function schedulePlanRefresh() {
        clearTimeout(planTimer);
        planTimer = setTimeout(async () => {
            const params = collectParams();
            const box = document.getElementById('plan-steps');
            if (box) box.classList.add('is-stale');
            try {
                currentPlan = await fetchPlan(currentPlan.playbook.id, params);
                renderPlan();
            } catch (err) {
                const el = document.getElementById('plan-param-error');
                if (el) el.innerHTML = `<div class="result-box is-error"><strong>${esc(err.message)}</strong></div>`;
                if (box) box.classList.remove('is-stale');
            }
        }, 450);
    }

    function renderPlan() {
        const p = currentPlan;
        const pb = p.playbook;
        const badges = [
            `<span class="risk-badge risk-${pb.risk}">${esc(pb.riskLabel || RISK[pb.risk])}</span>`,
            pb.downtime ? '<span class="chip chip-temp"><i class="fas fa-power-off"></i> exige parada</span>' : '<span class="chip"><i class="fas fa-bolt"></i> com o banco no ar</span>',
            pb.dataLoss ? '<span class="chip chip-danger"><i class="fas fa-triangle-exclamation"></i> pode perder dados</span>' : '<span class="chip chip-ok"><i class="fas fa-shield"></i> sem perda de dados</span>',
        ].join('');
        const pre = p.preconditions.length ? `<div class="plan-block"><h5><i class="fas fa-clipboard-check"></i> Pré-condições</h5>${p.preconditions.map((c) => `
            <div class="rec-ready is-${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'warn'}"><i class="fas ${c.ok === true ? 'fa-circle-check' : c.ok === false ? 'fa-circle-xmark' : 'fa-circle-question'}"></i><div><strong>${esc(c.label)}</strong><span>${esc(c.detail || '')}</span></div></div>`).join('')}</div>` : '';
        const blockers = p.blockers.length ? `<div class="result-box is-error"><strong><i class="fas fa-ban"></i> Não é possível executar agora</strong><ul class="step-list">${p.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>` : '';
        const warnings = p.warnings.length ? `<div class="storage-warnings">${p.warnings.map((w) => `<div><i class="fas fa-triangle-exclamation"></i> ${esc(w)}</div>`).join('')}</div>` : '';
        const fields = p.paramsSchema.map(fieldHtml).join('');
        const steps = p.steps.map((s) => `
            <li class="plan-step">
                <div class="plan-step-head"><span class="plan-step-n">${s.n}</span><strong>${esc(s.title)}</strong><span class="chip">${esc(s.channelLabel)}</span></div>
                ${s.note ? `<div class="form-hint">${esc(s.note)}</div>` : ''}
                ${s.adapts ? `<div class="form-hint"><i class="fas fa-code-branch"></i> ${esc(s.adapts)}</div>` : ''}
                ${s.script ? `<pre>${esc(s.script)}</pre>` : '<div class="form-hint is-error">Este passo não se aplica no estado atual da instância.</div>'}
            </li>`).join('');
        let confirm = '';
        if (isDba() && p.executable) {
            if (p.confirm.level === 'ack' || p.confirm.level === 'dbname') {
                confirm += `<label class="check-row confirm-row"><input type="checkbox" id="plan-ack"> <span>Revisei os passos e entendo o risco${pb.downtime ? ' (o banco ficará indisponível durante o procedimento)' : ''}${pb.dataLoss ? ' e que <strong>transações podem ser perdidas</strong>' : ''}.</span></label>`;
            }
            if (p.confirm.level === 'dbname') {
                confirm += `<div class="form-group"><label class="form-label" for="plan-dbname">Para confirmar, digite o nome do banco: <strong>${esc(p.confirm.dbName || '?')}</strong></label><input id="plan-dbname" class="form-control" autocomplete="off" spellcheck="false" placeholder="${esc(p.confirm.dbName || '')}"></div>`;
            }
        }
        document.getElementById('opModalTitle').textContent = pb.title;
        const sub = document.getElementById('opModalSubtitle');
        sub.hidden = false;
        sub.textContent = `Instância ${p.stateLabel} · ${p.steps.length} passo(s)`;
        document.getElementById('opModalBody').innerHTML = `
            <div class="plan-head">${badges}</div>
            <p class="plan-summary">${esc(pb.summary)}</p>
            <div class="form-hint"><strong>Quando usar:</strong> ${esc(pb.when)}</div>
            ${fields ? `<div class="plan-block plan-params"><h5><i class="fas fa-sliders"></i> Parâmetros</h5>${fields}<div id="plan-param-error"></div></div>` : ''}
            ${blockers}${pre}${warnings}
            <div class="plan-block"><h5><i class="fas fa-list-ol"></i> Passos</h5><ol class="plan-steps" id="plan-steps">${steps}</ol></div>
            ${confirm ? `<div class="plan-block plan-confirm">${confirm}</div>` : ''}
            ${!isDba() ? '<div class="form-hint">Somente o perfil DBA pode executar procedimentos.</div>' : ''}`;
        document.querySelectorAll('#opModalBody [data-param]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', schedulePlanRefresh));
        const execBtn = isDba() && p.executable
            ? `<button class="btn-primary ${pb.risk === 'high' ? 'btn-danger' : 'btn-success'}" id="plan-exec" onclick="executePlan()"><i class="fas fa-play"></i> Executar procedimento</button>` : '';
        document.getElementById('opModalFooter').innerHTML = `
            <button class="btn-primary btn-muted" onclick="copyPlanCommands()"><i class="fas fa-copy"></i> Copiar comandos</button>
            ${execBtn}`;
        const updateExec = () => {
            const btn = document.getElementById('plan-exec');
            if (!btn) return;
            const ack = document.getElementById('plan-ack');
            const name = document.getElementById('plan-dbname');
            const okAck = !ack || ack.checked;
            const okName = !name || name.value.trim().toUpperCase() === String(p.confirm.dbName || '').toUpperCase();
            btn.disabled = !(okAck && okName);
        };
        document.getElementById('plan-ack')?.addEventListener('change', updateExec);
        document.getElementById('plan-dbname')?.addEventListener('input', updateExec);
        updateExec();
    }

    window.copyPlanCommands = function () {
        if (!currentPlan) return;
        copyText(currentPlan.manual).then(() => {
            const b = document.querySelector('#opModalFooter .btn-muted');
            if (b) { b.innerHTML = '<i class="fas fa-check"></i> Copiado'; setTimeout(() => { b.innerHTML = '<i class="fas fa-copy"></i> Copiar comandos'; }, 1800); }
        }).catch(() => alert('Não foi possível copiar: selecione os comandos e use Ctrl+C.'));
    };

    window.executePlan = async function () {
        const p = currentPlan;
        const btn = document.getElementById('plan-exec');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Iniciando...'; }
        try {
            const res = await secureFetch('/api/recovery/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    playbook: p.playbook.id, params: p.params, hash: p.hash,
                    acknowledge: !!document.getElementById('plan-ack')?.checked,
                    confirmText: document.getElementById('plan-dbname')?.value || '',
                }),
            });
            const json = await res.json();
            if (!json.success) {
                if (json.plan) { currentPlan = json.plan; renderPlan(); }
                const err = document.createElement('div');
                err.className = 'result-box is-error';
                err.innerHTML = `<strong><i class="fas fa-circle-xmark"></i> ${esc(json.error)}</strong>`;
                document.getElementById('opModalBody').prepend(err);
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-play"></i> Executar procedimento'; }
                return;
            }
            showJob(json.data.jobId);
        } catch (err) {
            alert('Erro ao iniciar: ' + err.message);
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-play"></i> Executar procedimento'; }
        }
    };

    // ===================================================================== execução
    function stopJobPolling() {
        if (jobTimer) clearTimeout(jobTimer);
        jobTimer = null;
    }

    function renderJob(job) {
        const icon = { pending: 'fa-circle', running: 'fa-spinner fa-spin', done: 'fa-circle-check', failed: 'fa-circle-xmark', skipped: 'fa-circle-minus' };
        const label = { pending: 'aguardando', running: 'executando', done: 'concluído', failed: 'falhou', skipped: 'não executado' };
        const openIdx = job.steps.findIndex((s) => s.state === 'running' || s.state === 'failed');
        const steps = job.steps.map((s, i) => {
            const dur = s.startedAt ? Math.round(((s.finishedAt || Date.now()) - s.startedAt) / 1000) : null;
            const out = s.output ? `<details class="op-details" ${i === openIdx || (job.state !== 'running' && s.state === 'failed') ? 'open' : ''}><summary>Saída</summary><pre class="job-out" data-step="${i}">${esc(s.output)}</pre></details>` : '';
            const warns = (s.warnings || []).map((w) => `<div class="form-hint is-warn"><i class="fas fa-triangle-exclamation"></i> ${esc(w)}</div>`).join('');
            return `<li class="job-step is-${s.state}"><div class="plan-step-head"><i class="fas ${icon[s.state]}"></i><strong>${esc(s.title)}</strong><span class="chip">${label[s.state]}${dur != null ? ` · ${dur}s` : ''}</span></div>${warns}${out}</li>`;
        }).join('');
        const done = job.state !== 'running';
        const ok = job.state === 'done';
        const sugg = (job.suggestions || []).map((sg) => {
            const btns = (sg.playbooks || []).map((id) => {
                const meta = catalogById[id];
                if (!meta) return '';
                const k = actionKey(id, {});
                return `<button class="btn-primary btn-xs" onclick="openPlanByKey('${k}')"><i class="fas fa-list-check"></i> ${esc(meta.title)}</button>`;
            }).join('');
            return `<div class="rec-kb sev-high"><div class="rec-kb-head"><span class="chip">${esc(sg.code)}</span><strong>${esc(sg.title)}</strong></div><p>${esc(sg.meaning)}</p>${btns ? `<div class="rec-finding-actions">${btns}</div>` : ''}</div>`;
        }).join('');
        const after = job.after ? `<div class="form-hint">Nova análise: instância ${esc(job.after.state)} · situação ${esc((OVERALL[job.after.overall] || {}).label || job.after.overall)} · ${job.after.counts.critical} crítico(s), ${job.after.counts.high} alto(s).</div>` : '';
        const result = done
            ? `<div class="result-box ${ok ? 'is-ok' : 'is-error'}"><strong><i class="fas ${ok ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> ${esc(job.message)}</strong>${after}</div>${sugg ? `<div class="plan-block"><h5><i class="fas fa-lightbulb"></i> Próximo passo sugerido pelo erro</h5>${sugg}</div>` : ''}`
            : `<div class="result-box"><strong><i class="fas fa-spinner fa-spin"></i> ${esc(job.message)}</strong><div class="form-hint">Pode fechar esta janela: o procedimento continua no servidor e aparece em "Execuções de recuperação".</div></div>`;
        // Preserva a rolagem das saídas ao vivo
        const scroll = {};
        document.querySelectorAll('#opModalBody pre.job-out').forEach((el) => { scroll[el.dataset.step] = el.scrollTop + el.clientHeight >= el.scrollHeight - 8 ? 'bottom' : el.scrollTop; });
        document.getElementById('opModalTitle').textContent = job.title;
        const sub = document.getElementById('opModalSubtitle');
        sub.hidden = false;
        sub.textContent = `Iniciado em ${new Date(job.startedAt).toLocaleString('pt-BR')} por ${job.user}`;
        document.getElementById('opModalBody').innerHTML = `${result}<ol class="plan-steps job-steps">${steps}</ol>`;
        document.querySelectorAll('#opModalBody pre.job-out').forEach((el) => {
            const sc = scroll[el.dataset.step];
            el.scrollTop = sc === undefined || sc === 'bottom' ? el.scrollHeight : sc;
        });
        document.getElementById('opModalFooter').innerHTML = done
            ? '<button class="btn-primary btn-muted" onclick="closeOpModal()"><i class="fas fa-xmark"></i> Fechar</button><button class="btn-primary" onclick="closeOpModal(); loadRecovery(true)"><i class="fas fa-stethoscope"></i> Analisar novamente</button>'
            : '<button class="btn-primary btn-muted" onclick="closeOpModal()"><i class="fas fa-eye-slash"></i> Continuar em segundo plano</button>';
    }

    async function pollJob(jobId) {
        try {
            const res = await secureFetch(`/api/recovery/job/${encodeURIComponent(jobId)}`);
            const json = await res.json();
            if (!json.success) throw new Error(json.error);
            renderJob(json.data);
            if (json.data.state === 'running') {
                jobTimer = setTimeout(() => pollJob(jobId), 1500);
            } else {
                jobTimer = null;
                loadRecoveryJobs();
                setTimeout(() => loadRecovery(true), 300);
                if (typeof refreshAllSections === 'function') setTimeout(refreshAllSections, 1500);
            }
        } catch (err) {
            jobTimer = setTimeout(() => pollJob(jobId), 3000);
        }
    }

    function showJob(jobId) {
        stopJobPolling();
        openOpModal({ title: 'Execução', subtitle: '', body: '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i> Carregando...</div>', wide: true, onClose: stopJobPolling });
        pollJob(jobId);
    }
    window.showRecoveryJob = showJob;

    async function loadRecoveryJobs() {
        const body = document.getElementById('rec-jobs-body');
        if (!body) return;
        try {
            const res = await secureFetch('/api/recovery/jobs');
            const json = await res.json();
            if (!json.success) return;
            if (!json.data.length) {
                body.innerHTML = '<tr><td colspan="5" class="empty-cell">Nenhuma execução desde que o painel foi iniciado.</td></tr>';
                return;
            }
            const st = { running: ['badge-blue', 'em execução'], done: ['badge-green', 'concluído'], failed: ['badge-red', 'falhou'] };
            body.innerHTML = json.data.map((j) => `
                <tr>
                    <td class="nowrap">${new Date(j.startedAt).toLocaleString('pt-BR')}</td>
                    <td><strong>${esc(j.title)}</strong><div class="form-hint">${esc(j.message || '')}</div></td>
                    <td>${esc(j.user)}</td>
                    <td><span class="badge ${(st[j.state] || st.failed)[0]}">${(st[j.state] || st.failed)[1]}</span></td>
                    <td class="col-action"><button class="btn-primary btn-xs" onclick="showRecoveryJob('${esc(j.id)}')"><i class="fas fa-file-lines"></i> Ver</button></td>
                </tr>`).join('');
        } catch (e) { /* ignore */ }
    }
})();

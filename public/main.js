/**
 * MAIN.JS - Controlador do Frontend do Oracle Pulse
 * Gerencia a navegação entre abas, inicialização de gráficos (Chart.js),
 * atualização de dados via fetch API e interações de modal.
 */

// Configurações Globais dos Gráficos
Chart.defaults.color = '#1e293b';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.font.size = 11;

let charts = {};
let UPDATE_INTERVAL = 5000;
let refreshIntervalId = null;
let authToken = sessionStorage.getItem('oracle_pulse_token');
let userRole = sessionStorage.getItem('oracle_pulse_role') || 'viewer';
let lastStorageData = [];   // cache p/ exportação CSV
let lastSessionsData = [];  // cache p/ exportação CSV
let currentSqlId = null;    // SQL_ID aberto no modal (p/ plano de execução)
let lastBackupConfig = null; // última config de backup carregada
let lastMemoryData = null;   // última resposta do advisor de memória

// Wrapper para o fetch que injeta o token de autenticação
async function secureFetch(url, options = {}) {
    if (!options.headers) options.headers = {};
    if (authToken) {
        options.headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    const response = await fetch(url, options);
    
    if (response.status === 401) {
        sessionStorage.removeItem('oracle_pulse_token');
        location.reload(); // Força login se o token for inválido
    }
    
    return response;
}

document.addEventListener('DOMContentLoaded', () => {
    initLogin();
    if (authToken) {
        initApp();
    }
});

function initApp() {
    document.getElementById('login-overlay').style.display = 'none';
    applyRoleVisibility();
    initNavigation();
    initCharts();
    setupRefreshInterval();
    refreshData();

    // Atualiza o gráfico de tendência na mesma cadência do sampler (30s)
    setInterval(loadTrendData, 30000);

    // Terminal SQL: Ctrl+Enter executa o script
    const sqlInput = document.getElementById('sql-input');
    if (sqlInput) {
        sqlInput.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                runSqlTerminal();
            }
        });
    }

    // Listener para o botão de atualização manual de sessões
    const refreshBtn = document.getElementById('refresh-sessions');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            const icon = refreshBtn.querySelector('i');
            icon.classList.add('fa-spin'); // Feedback visual de rotação
            loadSessionsData().finally(() => {
                setTimeout(() => icon.classList.remove('fa-spin'), 500);
            });
        });
    }
}

function initLogin() {
    const loginForm = document.getElementById('login-form');
    const loginError = document.getElementById('login-error');

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const user = document.getElementById('login-user').value;
            const pass = document.getElementById('login-pass').value;

            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user, password: pass })
                });

                const data = await res.json();

                if (data.success) {
                    authToken = data.token;
                    userRole = data.role || 'viewer';
                    sessionStorage.setItem('oracle_pulse_token', authToken);
                    sessionStorage.setItem('oracle_pulse_role', userRole);
                    initApp();
                } else {
                    loginError.style.display = 'block';
                }
            } catch (err) {
                alert('Erro ao conectar ao servidor de autenticação');
            }
        });
    }
}

window.handleLogout = async function() {
    if (!confirm('Deseja realmente sair do sistema?')) return;
    try {
        // Revoga o token no servidor (logout real, não só no cliente)
        await secureFetch('/api/logout', { method: 'POST' });
    } catch (err) { /* segue para limpeza local mesmo se a rede falhar */ }
    sessionStorage.removeItem('oracle_pulse_token');
    sessionStorage.removeItem('oracle_pulse_role');
    location.reload();
}


// ===================== Controle de perfil (DBA x Viewer) =====================
function applyRoleVisibility() {
    const isDba = userRole === 'dba';
    document.querySelectorAll('.dba-only').forEach(el => {
        el.style.display = isDba ? '' : 'none';
    });
    const roleText = document.getElementById('role-text');
    if (roleText) roleText.textContent = isDba ? 'DBA (acesso total)' : 'Visualizador';
}

// ===================== Sino de Notificações =====================
const dismissedAlertIds = new Set();   // ids fechados pelo usuário (memória da sessão)
let lastAlertsSnapshot = [];           // último array de alertas ativos do servidor

// Formata o timestamp ISO 'since' (vindo do backend) como tempo relativo curto.
function formatSince(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 1) return 'agora';
    if (mins < 60) return `há ${mins} min`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `há ${h}h`;
    return `há ${Math.floor(h / 24)}d`;
}

// Escapa texto para inserção segura em HTML.
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function renderAlerts(alerts) {
    const list = alerts || [];
    lastAlertsSnapshot = list;

    // 1) Reset de ids resolvidos: um alerta fechado que não está mais ativo
    //    volta a poder notificar se a condição reaparecer no servidor.
    const activeIds = new Set(list.map(a => String(a.id)));
    dismissedAlertIds.forEach(id => { if (!activeIds.has(id)) dismissedAlertIds.delete(id); });

    // 2) Visíveis = ativos ainda não fechados pelo usuário.
    const visible = list.filter(a => !dismissedAlertIds.has(String(a.id)));

    const badge = document.getElementById('notif-badge');
    const bellBtn = document.getElementById('notif-bell-btn');
    const listEl = document.getElementById('notif-list');
    const countLabel = document.getElementById('notif-count-label');
    const clearBtn = document.getElementById('notif-clear-all');
    if (!badge || !bellBtn || !listEl) return;

    const count = visible.length;
    const hasCritical = visible.some(a => a.severity === 'critical');

    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = '';
        badge.classList.toggle('badge-warning', !hasCritical);
    } else {
        badge.style.display = 'none';
    }

    bellBtn.classList.toggle('has-critical', hasCritical);
    if (countLabel) countLabel.textContent = count;
    if (clearBtn) clearBtn.disabled = count === 0;

    listEl.innerHTML = visible.map(a => {
        const icon = a.severity === 'critical' ? 'fa-circle-exclamation' : 'fa-triangle-exclamation';
        const rel = formatSince(a.since);
        const since = rel ? `<span class="notif-since"><i class="far fa-clock"></i> ${rel}</span>` : '';
        const safeId = String(a.id).replace(/'/g, "\\'");
        return `
        <div class="notif-item notif-${a.severity}">
            <i class="fas ${icon} notif-icon"></i>
            <div class="notif-body">${escapeHtml(a.message)}${since}</div>
            <button class="notif-dismiss" type="button" aria-label="Fechar alerta" onclick="dismissAlert('${safeId}', event)">
                <i class="fas fa-xmark"></i>
            </button>
        </div>`;
    }).join('');
}

window.toggleNotifPanel = function (event) {
    if (event) event.stopPropagation();
    const panel = document.getElementById('notif-panel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('open');
    if (isOpen) {
        document.addEventListener('click', handleNotifOutsideClick);
        document.addEventListener('keydown', handleNotifEscape);
    } else {
        closeNotifPanel();
    }
}

function closeNotifPanel() {
    const panel = document.getElementById('notif-panel');
    if (panel) panel.classList.remove('open');
    document.removeEventListener('click', handleNotifOutsideClick);
    document.removeEventListener('keydown', handleNotifEscape);
}

function handleNotifOutsideClick(e) {
    const wrapper = document.getElementById('notif-bell-wrapper');
    if (wrapper && !wrapper.contains(e.target)) closeNotifPanel();
}

function handleNotifEscape(e) {
    if (e.key === 'Escape') closeNotifPanel();
}

window.dismissAlert = function (id, event) {
    if (event) event.stopPropagation();
    dismissedAlertIds.add(String(id));
    renderAlerts(lastAlertsSnapshot);
}

window.dismissAllAlerts = function () {
    lastAlertsSnapshot.forEach(a => dismissedAlertIds.add(String(a.id)));
    renderAlerts(lastAlertsSnapshot);
}

function setupRefreshInterval() {
    const selector = document.getElementById('refresh-rate');
    refreshIntervalId = setInterval(refreshData, UPDATE_INTERVAL);

    if (selector) {
        selector.addEventListener('change', (e) => {
            clearInterval(refreshIntervalId);
            UPDATE_INTERVAL = parseInt(e.target.value, 10);
            if (UPDATE_INTERVAL > 0) {
                refreshData();
                refreshIntervalId = setInterval(refreshData, UPDATE_INTERVAL);
            }
        });
    }
}

function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.page-section');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const sectionId = item.getAttribute('data-section');
            navItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            // Sempre abre a nova página no topo (não na rolagem da página anterior)
            window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
            sections.forEach(s => {
                s.classList.remove('active');
                if (s.id === sectionId) {
                    s.classList.add('active');
                    if (sectionId === 'storage') loadStorageData();
                    if (sectionId === 'sessions') loadSessionsData();
                    if (sectionId === 'memory') loadMemoryAdvisor();
                    if (sectionId === 'backup') loadBackupData();
                    if (sectionId === 'sql-terminal') { const t = document.getElementById('sql-input'); if (t) t.focus(); }
                    if (sectionId === 'performance' || sectionId === 'overview') refreshData();
                }
            });
        });
    });

    const active = document.querySelector('.page-section.active');
    if (active && active.id !== 'overview') {
        if (active.id === 'storage') loadStorageData();
        if (active.id === 'sessions') loadSessionsData();
    }
}

const commandTypes = [
    { key: 'BLOCKED_SESSIONS', label: 'LOCK', color: '#ef4444' },
    { key: 'SELECTS', label: 'SELECT', color: '#0ea5e9' },
    { key: 'INSERTS', label: 'INSERT', color: '#eab308' },
    { key: 'UPDATES', label: 'UPDATE', color: '#f97316' },
    { key: 'DELETES', label: 'DELETE', color: '#ec4899' },
    { key: 'INSERT_WITH_SELECT', label: 'INSERT WITH SELECT', color: '#22c55e' },
    { key: 'UPDATE_WITH_SELECT', label: 'UPDATE WITH SELECT', color: '#f59e0b' },
    { key: 'DELETE_WITH_SELECT', label: 'DELETE WITH SELECT', color: '#8b5cf6' },
    { key: 'CTE', label: 'CTE', color: '#6366f1' },
    { key: 'MERGE', label: 'MERGE', color: '#10b981' },
    { key: 'OTHERS', label: 'OUTROS', color: '#64748b' }
];

function initCharts() {
    // 1. Activity Chart (Line)
    const activityCtx = document.getElementById('activityChart');
    if (activityCtx) {
        charts.activity = new Chart(activityCtx, {
            type: 'line',
            data: {
                labels: [], datasets: commandTypes.map(t => ({
                    label: t.label,
                    key: t.key,
                    data: [],
                    borderColor: t.color,
                    backgroundColor: t.color + '15',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0
                }))
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'nearest',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { boxWidth: 8, usePointStyle: true, color: '#64748b', font: { size: 10 } }
                    }
                },
                scales: {
                    x: { grid: { color: 'rgba(0,0,0,0.05)' } },
                    y: {
                        beginAtZero: true,
                        grace: '10%', // Adiciona uma folga de 10% no topo para não encostar no teto
                        ticks: {
                            precision: 0, // Garante apenas números inteiros (1, 2, 3...)
                            color: '#64748b'
                        },
                        grid: { color: 'rgba(0,0,0,0.05)' }
                    }
                }
            }
        });
    }

    // 2. Wait Classes (Doughnut)
    const wcCtx = document.getElementById('waitClassesChart');
    if (wcCtx) {
        charts.waitClasses = new Chart(wcCtx, {
            type: 'doughnut',
            data: { labels: [], datasets: [{ data: [], backgroundColor: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'] }] },
            options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } } }
        });
    }

    // 3. Wait Events (Bar)
    const waitsCtx = document.getElementById('waitsChart');
    if (waitsCtx) {
        charts.waits = new Chart(waitsCtx, {
            type: 'bar',
            data: { labels: [], datasets: [{ label: 'Tempo (s)', data: [], backgroundColor: '#3b82f6', borderRadius: 4 }] },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                scales: { x: { grid: { color: 'rgba(0,0,0,0.05)' } }, y: { grid: { display: false } } }
            }
        });
    }

    // 4. Memory Usage (Doughnut)
    const memoryCtx = document.getElementById('memoryChart');
    if (memoryCtx) {
        charts.memory = new Chart(memoryCtx, {
            type: 'doughnut',
            data: { 
                labels: ['SGA (Utilizado)', 'PGA (Utilizado)', 'Livre'], 
                datasets: [{ 
                    data: [0, 0, 0], 
                    backgroundColor: ['#2563eb', '#10b981', '#cbd5e1'] 
                }] 
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false, 
                cutout: '70%', 
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } }
                }
            }
        });
    }

    // 5. Trend Chart (Histórico de sessões ativas e memória)
    const trendCtx = document.getElementById('trendChart');
    if (trendCtx) {
        charts.trend = new Chart(trendCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    { label: 'Sessões Ativas', data: [], borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.1)', fill: true, tension: 0.4, pointRadius: 0, yAxisID: 'y' },
                    { label: 'Memória %', data: [], borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4, pointRadius: 0, yAxisID: 'y1' }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: { position: 'top', labels: { boxWidth: 8, usePointStyle: true, font: { size: 10 } } } },
                scales: {
                    x: { grid: { color: 'rgba(0,0,0,0.05)' } },
                    y: { position: 'left', beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'Sessões' } },
                    y1: { position: 'right', beginAtZero: true, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: 'Mem %' } }
                }
            }
        });
        loadTrendData();
    }
}

async function loadTrendData() {
    if (!charts.trend) return;
    try {
        const res = await secureFetch('/api/history');
        const data = await res.json();
        if (data.success && Array.isArray(data.data)) {
            const samples = data.data;
            charts.trend.data.labels = samples.map(s => new Date(s.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
            charts.trend.data.datasets[0].data = samples.map(s => s.activeSessions);
            charts.trend.data.datasets[1].data = samples.map(s => s.memoryPct);
            charts.trend.update('none');
        }
    } catch (err) { console.warn('Trend load error:', err); }
}

function updateWaitsChart(data) {
    if (!charts.waits) return;
    charts.waits.data.labels = data.map(w => w.EVENT.substring(0, 25));
    charts.waits.data.datasets[0].data = data.map(w => w.TIME_WAITED_SECONDS);
    charts.waits.update('none');
}

async function refreshData() {
    try {
        const [dashRes, healthRes] = await Promise.all([
            secureFetch('/api/dashboard'),
            secureFetch('/api/health')
        ]);
        const dash = await dashRes.json();
        const health = await healthRes.json();

        if (health.success) {
            const h = health.data;
            document.getElementById('instance-name').textContent = h.INSTANCE_NAME;
            document.getElementById('db-user').textContent = health.dbUser;
            document.getElementById('uptime-val').textContent = formatUptime(h.UPTIME_MINUTES);
            document.getElementById('last-update').textContent = `Sync: ${new Date().toLocaleTimeString()}`;
            document.getElementById('server-time').innerHTML = `<i class="far fa-clock"></i> Servidor: ${h.CURRENT_TIME}`;
        }

        // Banner de alertas (vem no topo da resposta do dashboard)
        renderAlerts(dash.alerts);

        if (dash.success) {
            const d = dash.data;

            // Overview KPIs
            const activeSessions = d.sessions?.find(s => s.STATUS === 'ACTIVE')?.COUNT || 0;
            document.getElementById('active-sessions-count').textContent = activeSessions;

            // KPIs antes "mortos": CPU Load (somatório do top SQL) e Wait Events (qtde)
            if (d.topSql) {
                const cpuLoad = d.topSql.reduce((sum, s) => sum + (s.CPU_SECONDS || 0), 0);
                const cpuEl = document.getElementById('cpu-load');
                if (cpuEl) cpuEl.textContent = `${cpuLoad.toFixed(1)}s`;
            }
            if (d.waits) {
                const waitEl = document.getElementById('wait-count');
                if (waitEl) waitEl.textContent = d.waits.length;
            }

            const lockedSessions = d.sqlCommands?.BLOCKED_SESSIONS || 0;
            const lockedEl = document.getElementById('locked-sessions-count');
            lockedEl.textContent = lockedSessions;
            if (lockedSessions > 0) {
                lockedEl.classList.add('lock-alert');
            } else {
                lockedEl.classList.remove('lock-alert');
            }

            // Line Chart Update
            if (d.sqlCommands && charts.activity) {
                const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                charts.activity.data.labels.push(now);
                if (charts.activity.data.labels.length > 20) charts.activity.data.labels.shift();

                charts.activity.data.datasets.forEach(ds => {
                    ds.data.push(d.sqlCommands[ds.key] || 0);
                    if (ds.data.length > 20) ds.data.shift();
                });
                charts.activity.update('none');
            }

            // Performance KPIs
            if (d.systemMetrics) {
                d.systemMetrics.forEach(m => {
                    if (m.LABEL === 'Database Wait Time Ratio') document.getElementById('wait-ratio').textContent = `${m.VALUE.toFixed(1)}%`;
                    if (m.LABEL === 'Database CPU Time Ratio') document.getElementById('cpu-ratio').textContent = `${m.VALUE.toFixed(1)}%`;
                    if (m.LABEL === 'Response Time Per Txn') document.getElementById('resp-time').textContent = `${(m.VALUE * 10).toFixed(2)}ms`;
                });
            }

            // Wait Class Chart
            if (d.waitClasses && charts.waitClasses) {
                charts.waitClasses.data.labels = d.waitClasses.map(w => w.LABEL);
                charts.waitClasses.data.datasets[0].data = d.waitClasses.map(w => w.VALUE);
                charts.waitClasses.update();

                if (d.waitClasses[0]) {
                    document.getElementById('critical-event').textContent = d.waitClasses[0].LABEL;
                    document.getElementById('critical-event-class').textContent = `Impacto: ${d.waitClasses[0].VALUE.toFixed(0)}s`;
                }
            }

            // Gráfico de Wait Events Detalhados
            if (d.waits) {
                updateWaitsChart(d.waits);
            }

            // Tables (using a helper)
            if (d.topSql) {
                updateSqlTable(d.topSql, 'top-sql-body');
                updateSqlTable(d.topSql, 'top-sql-body-perf');
            }
            
            // Memory Chart
            if (d.memory && charts.memory) {
                const sga = d.memory.SGA_MB || d.memory.sga_mb || 0;
                const pga = d.memory.PGA_MB || d.memory.pga_mb || 0;
                const totalUsed = d.memory.TOTAL_USED_MB || d.memory.total_used_mb || (sga + pga);
                const totalLimit = d.memory.TOTAL_CONFIG_MB || d.memory.total_config_mb || 0;
                const free = Math.max(0, totalLimit - totalUsed);
                
                charts.memory.data.datasets[0].data = [sga, pga, free];
                charts.memory.update('none');
                
                // Mostra a COMPOSIÇÃO alocada (não o "100%" enganoso). A SGA é
                // pré-alocada pelo Oracle; a RAM real do servidor fica na aba Memória.
                const statsEl = document.getElementById('memory-stats');
                if (statsEl) {
                    statsEl.textContent = `SGA: ${sga.toFixed(0)} MB · PGA: ${pga.toFixed(0)} MB`;
                }
            }

            // Top Memory Processes
            if (d.sessionMem) {
                const tbody = document.getElementById('top-memory-body');
                if (tbody) {
                    tbody.innerHTML = d.sessionMem.map(s => {
                        const user = s.USERNAME || s.username || 'N/A';
                        const prog = s.PROGRAM || s.program || 'N/A';
                        const sga = s.SGA_MB || s.sga_mb || 0;
                        const pga = s.PGA_MB || s.pga_mb || 0;
                        return `
                            <tr>
                                <td>
                                    <strong>${user}</strong><br>
                                    <span style="font-size: 0.75rem; color: var(--text-secondary);">${prog}</span>
                                </td>
                                <td><span class="badge badge-blue">${sga.toFixed(2)} MB</span></td>
                                <td><span class="badge badge-green">${pga.toFixed(2)} MB</span></td>
                            </tr>
                        `;
                    }).join('');
                }
            }
        }
    } catch (err) { console.warn('Refresh error:', err); }
}

function updateSqlTable(data, bodyId) {
    const body = document.getElementById(bodyId);
    if (!body) return;
    body.innerHTML = data.map(sql => `
        <tr>
            <td><span class="badge badge-blue">${sql.SQL_ID}</span></td>
            <td><strong>${sql.CPU_SECONDS.toFixed(2)}</strong></td>
            <td>${sql.EXECUTIONS}</td>
            <td style="font-family: 'JetBrains Mono'; font-size: 0.75rem; color: #64748b">${sql.SQL_SNIPPET}...</td>
            <td><button class="btn-primary" style="padding: 4px 8px; font-size: 0.7rem;" onclick="showSqlDetails('${sql.SQL_ID}')">Ver</button></td>
        </tr>
    `).join('');
}

// Manual Storage Refresh
document.getElementById('refresh-storage').addEventListener('click', loadStorageData);

let storageConfig = { files: [], basePath: '' };

async function loadStorageData() {
    const btn = document.getElementById('refresh-storage');
    if (!btn) return;
    const icon = btn.querySelector('i');
    try {
        btn.disabled = true; icon.classList.add('fa-spin');

        const [storageRes, configRes, osDiskRes] = await Promise.all([
            secureFetch('/api/storage'),
            secureFetch('/api/storage/config'),
            secureFetch('/api/storage/os-disk')
        ]);

        const storageData = await storageRes.json();
        const configData = await configRes.json();
        const osDiskData = await osDiskRes.json();

        if (osDiskData.success && osDiskData.data && !osDiskData.data.error) {
            const d = osDiskData.data;
            document.getElementById('os-disk-path').textContent = `Volume: ${d.path}`;
            document.getElementById('os-disk-text').textContent = `${d.freeGB} GB Livres / ${d.totalGB} GB Total`;
            const bar = document.getElementById('os-disk-bar');
            bar.style.width = `${d.usedPct}%`;
            bar.textContent = `${d.usedPct}%`;
            
            if (d.usedPct > 85) bar.style.background = 'var(--accent-red)';
            else if (d.usedPct > 70) bar.style.background = '#f59e0b';
            else bar.style.background = 'var(--accent-blue)';
        } else if (osDiskData.success && osDiskData.data && osDiskData.data.error) {
            document.getElementById('os-disk-path').textContent = 'Erro de Leitura (Veja as credenciais)';
            document.getElementById('os-disk-text').textContent = osDiskData.data.error;
            const bar = document.getElementById('os-disk-bar');
            bar.style.width = `100%`;
            bar.textContent = `Falha`;
            bar.style.background = 'var(--accent-red)';
        } else {
            document.getElementById('os-disk-path').textContent = 'ASM ou Caminho Restrito';
            document.getElementById('os-disk-text').textContent = '--';
            const bar = document.getElementById('os-disk-bar');
            bar.style.width = `0%`;
            bar.textContent = ``;
        }

        if (storageData.success) {
            lastStorageData = storageData.data;
            updateStorageList(storageData.data);
        }
        if (configData.success) {
            storageConfig = configData.data;
            populateStorageDropdowns(storageData.data, configData.data);
        }
    } catch (err) { console.error('Storage load fail:', err); }
    finally { setTimeout(() => { btn.disabled = false; icon.classList.remove('fa-spin'); }, 500); }
}

function populateStorageDropdowns(tablespaces, config) {
    const resizeSelect = document.getElementById('resize-file-select');
    const addTsSelect = document.getElementById('add-ts-select');

    if (resizeSelect) {
        resizeSelect.innerHTML = config.files.map(f =>
            `<option value="${f.FILE_NAME}">${f.TABLESPACE_NAME} - ${f.FILE_NAME} (${f.SIZE_MB}MB)</option>`
        ).join('');
    }

    if (addTsSelect) {
        addTsSelect.innerHTML = tablespaces.map(t =>
            `<option value="${t.TABLESPACE_NAME}">${t.TABLESPACE_NAME}</option>`
        ).join('');
    }
}

window.handleResize = async function () {
    const fileName = document.getElementById('resize-file-select').value;
    const newSize = document.getElementById('resize-new-size').value;

    if (!newSize) return alert('Informe o novo tamanho!');

    const command = `ALTER DATABASE DATAFILE '${fileName}' RESIZE ${newSize}M`;
    if (!confirm(`CONFIRMAÇÃO DE SEGURANÇA\n\nComando: ${command}\n\nDeseja executar esta alteração no banco de dados?`)) return;

    try {
        const res = await secureFetch('/api/storage/resize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName, newSizeMb: newSize })
        });
        const data = await res.json();
        alert(data.message);
        loadStorageData();
    } catch (err) { alert('Erro ao executar comando: ' + err.message); }
}

window.handleAddFile = async function () {
    const tablespace = document.getElementById('add-ts-select').value;
    const fileName = document.getElementById('add-file-name').value;
    const size = document.getElementById('add-file-size').value;

    if (!fileName || !size) return alert('Preencha todos os campos!');

    const fullPath = storageConfig.basePath + fileName;
    const command = `ALTER TABLESPACE "${tablespace}" ADD DATAFILE '${fullPath}' SIZE ${size}M AUTOEXTEND ON NEXT 100M MAXSIZE UNLIMITED`;

    if (!confirm(`CONFIRMAÇÃO DE SEGURANÇA\n\nComando: ${command}\n\nDeseja criar este novo datafile agora?`)) return;

    try {
        const res = await secureFetch('/api/storage/add-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tablespace, fileName: fullPath, sizeMb: size })
        });
        const data = await res.json();
        alert(data.message);
        loadStorageData();
    } catch (err) { alert('Erro ao executar comando: ' + err.message); }
}

function updateStorageList(data) {
    const container = document.getElementById('storage-detail-list');
    if (!container) return;
    container.innerHTML = `
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th style="text-align: left;">Tablespace</th>
                        <th style="text-align: center;">Total (MB)</th>
                        <th style="text-align: center;">Utilizado (MB)</th>
                        <th style="text-align: center;">Livre (MB)</th>
                        <th style="text-align: center;">Limite Máximo (MB)</th>
                        <th style="text-align: center;">Uso %</th>
                    </tr>
                </thead>
                <tbody>${data.map(s => `
                    <tr>
                        <td style="text-align: left;"><strong>${s.TABLESPACE_NAME}</strong></td>
                        <td style="text-align: center;">${s.TOTAL_MB.toFixed(0)} MB</td>
                        <td style="text-align: center; color: var(--accent-blue)">${s.USED_MB.toFixed(0)} MB</td>
                        <td style="text-align: center; color: var(--accent-green)">${s.FREE_MB.toFixed(0)} MB</td>
                        <td style="text-align: center;"><span class="badge" style="background: rgba(0,0,0,0.05); color: var(--text-primary)">${s.MAX_MB.toFixed(0)} MB</span></td>
                        <td>
                            <div style="display: flex; align-items: center; gap: 10px; justify-content: center;">
                                <div style="flex: 0 0 100px; height: 8px; background: rgba(0,0,0,0.06); border-radius: 4px; overflow: hidden;">
                                    <div style="width: ${s.USED_PCT}%; height: 100%; background: ${s.USED_PCT > 90 ? 'var(--accent-red)' : 'var(--accent-blue)'};"></div>
                                </div>
                                <span style="font-weight: 600; width: 45px; text-align: right;">${s.USED_PCT}%</span>
                            </div>
                        </td>
                    </tr>`).join('')}</tbody>
            </table>
        </div>`;
}

async function loadSessionsData() {
    loadLongRunningSessions();
    const container = document.getElementById('sessions-body');
    if (!container) return;
    try {
        const res = await secureFetch('/api/sessions');
        const data = await res.json();
        if (data.success) {
            lastSessionsData = data.data;
            if (data.data.length === 0) {
                container.innerHTML = `
                    <tr>
                        <td colspan="6" style="text-align: center; padding: 3rem; color: var(--text-secondary);">
                            <div style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.3;"><i class="fas fa-check-circle"></i></div>
                            <p style="font-weight: 500; font-size: 1.1rem;">Tudo limpo! Nenhuma sessão bloqueada ou presa no momento.</p>
                            <small>O banco de dados está operando sem locks impeditivos.</small>
                        </td>
                    </tr>`;
            } else {
                container.innerHTML = data.data.map(s => `
                    <tr style="${s.ROLE === 'VILÃO (RAIZ)' ? 'background: rgba(239, 68, 68, 0.05);' : ''}">
                        <td><span class="badge ${s.ROLE === 'VILÃO (RAIZ)' ? 'badge-red' : 'badge-blue'}">#${s.SID},${s.SERIAL}</span></td>
                        <td>
                            <strong style="color: ${s.ROLE === 'VILÃO (RAIZ)' ? 'var(--accent-red)' : 'inherit'}">
                                ${s.ROLE === 'VILÃO (RAIZ)' ? '<i class="fas fa-skull"></i> ' : ''}${s.VICTIM}
                            </strong>
                            <div style="font-size: 0.65rem; color: var(--text-secondary)">${s.ROLE}</div>
                        </td>
                        <td>
                            ${s.BLOCKER_SID ? 
                                `<span class="badge badge-red">ID: ${s.BLOCKER_SID} (${s.BLOCKER_USER})</span>` : 
                                '<span class="badge" style="background: #f1f5f9; color: #64748b">NENHUM (RAIZ)</span>'}
                        </td>
                        <td><small>${s.PROGRAM}</small></td>
                        <td>${userRole === 'dba'
                            ? `<button class="btn-primary" style="background: var(--accent-red); padding: 5px 10px;" onclick="killSession(${s.SID}, ${s.SERIAL})">KILL</button>`
                            : '<span class="badge" style="background:#f1f5f9;color:#94a3b8">—</span>'}</td>
                    </tr>`).join('');
            }
        }
    } catch (err) { console.error('Session load fail:', err); }
}

window.killSession = async function (sid, serial) {
    if (!confirm(`Deseja realmente matar a sessão ${sid},${serial}?`)) return;
    try {
        const res = await secureFetch('/api/sessions/kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sid, serial })
        });
        const data = await res.json();
        alert(data.message);
        loadSessionsData();
    } catch (err) { alert('Erro ao matar sessão'); }
}

window.showSqlDetails = async function (sqlId) {
    currentSqlId = sqlId;
    const modal = document.getElementById('sqlModal');
    const content = document.getElementById('fullSqlContent');
    const title = document.getElementById('modalSqlId');
    content.textContent = 'Carregando SQL Snippet...';
    title.textContent = `SQL Snippet: ${sqlId}`;
    modal.style.display = 'block';
    try {
        const res = await secureFetch(`/api/sql/${sqlId}`);
        const data = await res.json();
        if (data.success) content.textContent = data.data;
        else content.textContent = 'Erro ao carregar SQL';
    } catch (err) { content.textContent = 'Erro na requisição'; }
}

window.showSqlPlan = async function () {
    if (!currentSqlId) return;
    const content = document.getElementById('fullSqlContent');
    const title = document.getElementById('modalSqlId');
    title.textContent = `Plano de Execução: ${currentSqlId}`;
    content.textContent = 'Carregando plano de execução...';
    try {
        const res = await secureFetch(`/api/sql/${currentSqlId}/plan`);
        const data = await res.json();
        content.textContent = data.success ? data.data : (data.error || 'Plano não disponível');
    } catch (err) { content.textContent = 'Erro ao carregar o plano de execução'; }
}

// ===================== Sessões de longa duração =====================
async function loadLongRunningSessions() {
    const body = document.getElementById('long-running-body');
    if (!body) return;
    try {
        const res = await secureFetch('/api/sessions/long-running');
        const data = await res.json();
        if (!data.success) return;
        if (data.data.length === 0) {
            body.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:2rem; color:var(--text-secondary)">Nenhuma sessão ativa de longa duração.</td></tr>`;
            return;
        }
        body.innerHTML = data.data.map(s => `
            <tr>
                <td><span class="badge badge-blue">#${s.SID},${s.SERIAL}</span></td>
                <td><strong>${s.USERNAME || 'N/A'}</strong><br><span style="font-size:0.7rem;color:var(--text-secondary)">${s.PROGRAM || ''}</span></td>
                <td><strong>${formatDuration(s.SECONDS_RUNNING)}</strong></td>
                <td><small>${s.EVENT || '-'}</small></td>
                <td>${s.SQL_ID ? `<span class="badge badge-blue" style="cursor:pointer" onclick="showSqlDetails('${s.SQL_ID}')">${s.SQL_ID}</span>` : '-'}</td>
                <td>${userRole === 'dba'
                    ? `<button class="btn-primary" style="background: var(--accent-red); padding: 5px 10px;" onclick="killSession(${s.SID}, ${s.SERIAL})">KILL</button>`
                    : '<span class="badge" style="background:#f1f5f9;color:#94a3b8">—</span>'}</td>
            </tr>`).join('');
    } catch (err) { console.warn('Long-running load fail:', err); }
}

function formatDuration(seconds) {
    const s = Number(seconds) || 0;
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ===================== Backup & Auditoria =====================
window.loadBackupData = async function () {
    if (userRole === 'dba') loadBackupConfig();
    try {
        const [backupRes, auditRes] = await Promise.all([
            secureFetch('/api/backup/status'),
            userRole === 'dba' ? secureFetch('/api/audit') : Promise.resolve(null)
        ]);

        const backup = await backupRes.json();
        if (backup.success) {
            const d = backup.data;
            if (d.mode) {
                const modeEl = document.getElementById('archivelog-mode');
                modeEl.textContent = d.mode.LOG_MODE || '--';
                modeEl.style.color = d.mode.LOG_MODE === 'ARCHIVELOG' ? 'var(--accent-green)' : 'var(--accent-red)';
                document.getElementById('db-role').textContent = `${d.mode.NAME || ''} • ${d.mode.DATABASE_ROLE || ''}`;
            }
            const lastFull = (d.backups || []).find(b => b.STATUS && b.STATUS.indexOf('COMPLETED') >= 0) || (d.backups || [])[0];
            if (lastFull) {
                document.getElementById('last-backup').textContent = lastFull.END_TIME || lastFull.START_TIME || '--';
                const statusEl = document.getElementById('last-backup-status');
                statusEl.textContent = `${lastFull.INPUT_TYPE || ''} • ${lastFull.STATUS || ''}`;
                statusEl.style.color = (lastFull.STATUS || '').indexOf('COMPLETED') >= 0 ? 'var(--accent-green)' : 'var(--accent-orange)';
            }
            const fraUsageEl = document.getElementById('fra-usage');
            const fraDetailEl = document.getElementById('fra-detail');
            if (d.fra && (d.fra.LIMIT_MB ?? 0) > 0) {
                fraUsageEl.textContent = `${(d.fra.USED_PCT ?? 0).toFixed(1)}%`;
                fraUsageEl.style.color = '';
                const dest = d.fra.NAME || d.fra.name;
                fraDetailEl.innerHTML = `${(d.fra.USED_MB ?? 0).toFixed(0)} / ${(d.fra.LIMIT_MB ?? 0).toFixed(0)} MB` +
                    (dest ? `<br><span title="${escapeHtml(dest)}" style="font-size:0.7rem; color:var(--text-secondary)"><i class="fas fa-folder"></i> ${escapeHtml(dest)}</span>` : '');
                fraDetailEl.style.color = 'var(--text-secondary)';
            } else {
                fraUsageEl.textContent = 'N/D';
                fraUsageEl.style.color = 'var(--accent-orange)';
                fraDetailEl.innerHTML = '<i class="fas fa-triangle-exclamation"></i> FRA não configurada';
                fraDetailEl.style.color = 'var(--accent-orange)';
            }

            const rmanBody = document.getElementById('rman-body');
            if (rmanBody) {
                rmanBody.innerHTML = (d.backups || []).length === 0
                    ? `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-secondary)">Sem registros de backup.</td></tr>`
                    : d.backups.map(b => {
                        const key = b.SESSION_KEY ?? b.session_key;
                        const logBtn = (key != null && userRole === 'dba')
                            ? `<button class="btn-primary" style="padding:4px 9px; font-size:0.7rem;" onclick="showRmanRowLog(${key})"><i class="fas fa-file-lines"></i> Log</button>`
                            : '<span style="color:var(--text-secondary)">—</span>';
                        return `
                        <tr>
                            <td><strong>${b.INPUT_TYPE || '-'}</strong></td>
                            <td><span class="badge ${(b.STATUS||'').indexOf('COMPLETED')>=0 ? 'badge-green' : 'badge-red'}">${b.STATUS || '-'}</span></td>
                            <td>${b.START_TIME || '-'}</td>
                            <td>${b.END_TIME || '-'}</td>
                            <td>${b.ELAPSED_MINUTES ?? '-'}</td>
                            <td>${b.OUTPUT_BYTES_DISPLAY || '-'}</td>
                            <td>${logBtn}</td>
                        </tr>`; }).join('');
            }
        }

        if (auditRes) {
            const audit = await auditRes.json();
            const auditBody = document.getElementById('audit-body');
            if (audit.success && auditBody) {
                auditBody.innerHTML = audit.data.length === 0
                    ? `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-secondary)">Sem registros de auditoria.</td></tr>`
                    : audit.data.map(a => `
                        <tr>
                            <td><small>${new Date(a.ts).toLocaleString('pt-BR')}</small></td>
                            <td><span class="badge badge-blue">${a.action}</span></td>
                            <td>${a.user} <span style="font-size:0.65rem;color:var(--text-secondary)">(${a.role})</span></td>
                            <td><small>${a.ip}</small></td>
                            <td><span class="badge ${a.success ? 'badge-green' : 'badge-red'}">${a.success ? 'OK' : 'FALHA'}</span></td>
                            <td><small style="color:var(--text-secondary)">${(a.detail || '').substring(0, 80)}</small></td>
                        </tr>`).join('');
            }
        }
    } catch (err) { console.warn('Backup load fail:', err); }
}

// ===================== Otimização de Memória (Advisor) =====================
window.loadMemoryAdvisor = async function () {
    try {
        const res = await secureFetch('/api/memory/advisor');
        const json = await res.json();
        if (!json.success) return;
        const d = json.data;
        lastMemoryData = d;
        const p = d.params || {};

        // KPIs de configuração
        document.getElementById('mem-mode').textContent = d.mode || '--';
        document.getElementById('mem-sga').textContent = p.sga_target ? `${p.sga_target} MB` : '—';
        document.getElementById('mem-sga-max').textContent = p.sga_max_size ? `${p.sga_max_size} MB` : '—';
        document.getElementById('mem-pga').textContent = p.pga_aggregate_target ? `${p.pga_aggregate_target} MB` : '—';
        document.getElementById('mem-pga-limit').textContent = p.pga_aggregate_limit ? `${p.pga_aggregate_limit} MB` : '—';

        // Monta os campos de ajuste conforme o modo (AMM/ASMM/MANUAL)
        const recItems = d.recommendation?.items || [];
        const suggestions = {
            sga_target: recItems.find(i => i.area === 'SGA')?.suggestedMb,
            pga_aggregate_target: recItems.find(i => i.area === 'PGA')?.suggestedMb,
        };
        buildMemoryFields(p, suggestions);

        // Memória física do servidor (RAM + swap)
        const os = d.osMemory;
        const area = document.getElementById('mem-os-area');
        const errEl = document.getElementById('mem-os-error');
        if (os && !os.error) {
            area.style.display = '';
            errEl.style.display = 'none';

            document.getElementById('mem-ram-pct').textContent = `${os.usedPct}%`;
            document.getElementById('mem-ram-detail').textContent = `${os.freeMB} MB livres`;
            document.getElementById('mem-ram-text').textContent = `${os.usedMB} / ${os.totalMB} MB`;
            const ramBar = document.getElementById('mem-ram-bar');
            ramBar.style.width = `${os.usedPct}%`;
            ramBar.textContent = `${os.usedPct}%`;
            ramBar.style.background = os.usedPct > 92 ? 'var(--accent-red)' : os.usedPct > 80 ? '#f59e0b' : 'var(--accent-blue)';

            const sw = os.swap;
            const swText = document.getElementById('mem-swap-text');
            const swBar = document.getElementById('mem-swap-bar');
            if (sw && sw.totalMB > 0) {
                swText.textContent = `${sw.usedMB} / ${sw.totalMB} MB`;
                swBar.style.width = `${sw.usedPct}%`;
                swBar.textContent = `${sw.usedPct}%`;
                // Swap em uso é o sinal real de pressão: vermelho a partir de 10%.
                swBar.style.background = sw.usedPct >= 25 ? 'var(--accent-red)' : sw.usedPct >= 10 ? '#f59e0b' : 'var(--accent-green)';
            } else {
                swText.textContent = 'sem swap';
                swBar.style.width = '0%';
                swBar.textContent = '';
            }
        } else {
            area.style.display = 'none';
            errEl.style.display = 'block';
            errEl.textContent = (os && os.error) ? os.error : 'Memória do servidor indisponível (configure o acesso SSH no .env).';
            document.getElementById('mem-ram-pct').textContent = 'N/D';
            document.getElementById('mem-ram-detail').textContent = 'ver SSH';
        }

        // Recomendações
        const recBox = document.getElementById('mem-recommendations');
        const sevStyle = {
            ok: { bg: 'rgba(16,185,129,0.1)', color: 'var(--accent-green)', icon: 'fa-circle-check' },
            info: { bg: 'rgba(37,99,235,0.1)', color: 'var(--accent-blue)', icon: 'fa-circle-info' },
            warning: { bg: 'rgba(245,158,11,0.1)', color: '#b45309', icon: 'fa-triangle-exclamation' },
            critical: { bg: 'rgba(239,68,68,0.1)', color: 'var(--accent-red)', icon: 'fa-circle-exclamation' },
        };
        recBox.innerHTML = (d.recommendation?.items || []).map(it => {
            const s = sevStyle[it.severity] || sevStyle.info;
            return `<div style="display:flex; gap:12px; align-items:flex-start; padding:12px 16px; border-radius:10px; background:${s.bg}; margin-bottom:8px;">
                <i class="fas ${s.icon}" style="color:${s.color}; margin-top:3px;"></i>
                <div><strong style="color:${s.color}">${it.area}</strong><div style="font-size:0.85rem; margin-top:2px;">${escapeHtml(it.text)}</div></div>
            </div>`;
        }).join('');

        // Tabela PGA advice
        const pgaBody = document.getElementById('mem-pga-advice');
        pgaBody.innerHTML = (d.pga || []).map(r => {
            const isCurrent = Number(r.FACTOR) === 1;
            const over = Number(r.OVERALLOC);
            return `<tr style="${isCurrent ? 'background:rgba(37,99,235,0.06);' : ''}">
                <td><strong>${r.TARGET_MB}</strong>${isCurrent ? ' <span class="badge badge-blue">atual</span>' : ''}</td>
                <td>${Number(r.FACTOR).toFixed(2)}x</td>
                <td>${r.CACHE_HIT_PCT}%</td>
                <td><span class="badge ${over > 0 ? 'badge-red' : 'badge-green'}">${over}</span></td>
            </tr>`;
        }).join('') || emptyRow(4);

        // Tabela SGA advice
        const sgaBody = document.getElementById('mem-sga-advice');
        sgaBody.innerHTML = (d.sga || []).map(r => {
            const isCurrent = Number(r.FACTOR) === 1;
            const f = Number(r.DB_TIME_FACTOR);
            return `<tr style="${isCurrent ? 'background:rgba(37,99,235,0.06);' : ''}">
                <td><strong>${r.SIZE_MB}</strong>${isCurrent ? ' <span class="badge badge-blue">atual</span>' : ''}</td>
                <td>${Number(r.FACTOR).toFixed(2)}x</td>
                <td><span class="badge ${f < 1 ? 'badge-green' : f > 1 ? 'badge-red' : ''}" style="${f === 1 ? 'background:rgba(0,0,0,0.05)' : ''}">${f.toFixed(3)}x</span></td>
                <td>${Number(r.PHYSICAL_READS).toLocaleString('pt-BR')}</td>
            </tr>`;
        }).join('') || emptyRow(4);

        // Aviso quando os advisors estão vazios (parâmetros não definidos)
        if ((d.pga || []).length === 0 && (d.sga || []).length === 0) {
            const msg = `<tr><td colspan="4" style="text-align:center; padding:1.5rem; color:var(--text-secondary)">Advisor indisponível. Verifique se SGA_TARGET/PGA_AGGREGATE_TARGET estão definidos e STATISTICS_LEVEL=TYPICAL.</td></tr>`;
            pgaBody.innerHTML = msg; sgaBody.innerHTML = msg;
        }
    } catch (err) { console.warn('Memory advisor load fail:', err); }
}

function emptyRow(cols) {
    return `<tr><td colspan="${cols}" style="text-align:center; padding:1.5rem; color:var(--text-secondary)">Sem dados.</td></tr>`;
}

// Descritores de cada parâmetro de memória ajustável.
const MEM_FIELDS = {
    memory_target: { label: 'MEMORY_TARGET (MB)', icon: 'fa-layer-group', endpoint: '/api/memory/memory-target', static: false, note: 'Memória total (SGA+PGA) gerenciada pelo Oracle.' },
    memory_max_target: { label: 'MEMORY_MAX_TARGET (MB)', icon: 'fa-up-right-and-down-left-from-center', endpoint: '/api/memory/memory-max-target', static: true, note: 'Teto da memória total.' },
    pga_aggregate_target: { label: 'PGA Aggregate Target (MB)', icon: 'fa-microchip', endpoint: '/api/memory/pga-target', static: false },
    pga_aggregate_limit: { label: 'PGA Aggregate Limit (MB)', icon: 'fa-shield-halved', endpoint: '/api/memory/pga-limit', static: false, allowZero: true, note: '0 = sem limite' },
    sga_target: { label: 'SGA Target (MB)', icon: 'fa-database', endpoint: '/api/memory/sga-target', static: false },
    sga_max_size: { label: 'SGA Max Size (MB)', icon: 'fa-up-right-and-down-left-from-center', endpoint: '/api/memory/sga-max-size', static: true, orientation: true },
};

// Campos exibidos por modo, agrupando parâmetros iguais.
const MODE_FIELDS = {
    AMM: ['memory_target', 'memory_max_target', 'pga_aggregate_limit'],
    ASMM: ['pga_aggregate_target', 'pga_aggregate_limit', 'sga_target', 'sga_max_size'],
    MANUAL: ['pga_aggregate_target', 'pga_aggregate_limit', 'sga_max_size'],
};

function detectMemMode(p) {
    if (p.memory_target > 0) return 'AMM';
    if (p.sga_target > 0) return 'ASMM';
    return 'MANUAL';
}

function buildMemoryFields(p, suggestions = {}) {
    const container = document.getElementById('mem-adjust-fields');
    if (!container) return;
    const mode = detectMemMode(p);
    const modeTag = document.getElementById('mem-mode-tag');
    if (modeTag) modeTag.textContent = `· Modo ${mode}`;

    const keys = MODE_FIELDS[mode] || MODE_FIELDS.ASMM;
    container.innerHTML = keys.map((k) => {
        const f = MEM_FIELDS[k];
        const cur = p[k];
        const sug = suggestions[k];
        const staticTag = f.static ? '<span style="font-size:0.65rem; font-weight:700; color:var(--accent-orange); margin-left:4px;">requer reinício</span>' : '';
        const btnBg = f.static ? 'background:var(--accent-orange);' : '';
        const zeroHint = f.allowZero ? ' · <span style="color:var(--accent-blue)">0 = sem limite</span>' : '';
        const staticHint = f.static ? ' · <span style="color:var(--accent-orange)">SCOPE=SPFILE (vale após reiniciar)</span>' : '';
        const sugHint = sug ? ` · <span style="color:var(--accent-blue)">sugerido: ${sug} MB</span>` : '';
        const noteHint = f.note ? ` · ${f.note === '0 = sem limite' ? '' : f.note}` : '';
        const orient = f.orientation ? '<a onclick="showSgaMaxOrientation()" style="cursor:pointer; color:var(--accent-blue); font-size:0.75rem; font-weight:600; display:inline-block; margin-top:4px;"><i class="fas fa-circle-question"></i> Como definir sem limite?</a>' : '';
        const curTxt = (cur !== undefined && cur !== null) ? `${cur} MB` : '?';
        const valAttr = (cur !== undefined && cur !== null) ? `value="${cur}"` : '';
        return `
        <div>
            <label style="display:block; margin-bottom:0.5rem; font-weight:600; color:var(--text-secondary);">
                <i class="fas ${f.icon}"></i> ${f.label} ${staticTag}
            </label>
            <div style="display:flex; gap:8px;">
                <input type="number" id="memf-${k}" min="${f.allowZero ? 0 : 100}" ${valAttr} class="form-control"
                    style="flex:1; min-width:0; padding:0.7rem; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-main);">
                <button class="btn-primary" style="${btnBg}" onclick="applyMemoryParam('${k}')"><i class="fas fa-save"></i> Aplicar</button>
            </div>
            <small style="color:var(--text-secondary); display:block; margin-top:0.5rem;">Atual: <strong>${curTxt}</strong>${staticHint}${zeroHint}${sugHint}${noteHint}</small>
            ${orient}
        </div>`;
    }).join('');
}

window.applyMemoryParam = async function (key) {
    const f = MEM_FIELDS[key];
    if (!f) return;
    const raw = document.getElementById(`memf-${key}`).value;
    if (raw === '' || raw === null) return alert('Informe o valor em MB.');
    const sizeMb = Number(raw);
    const min = f.allowZero ? 0 : 100;
    if (!Number.isInteger(sizeMb) || sizeMb < min) return alert(`Valor inválido (mínimo ${min}).`);

    let msg = (f.allowZero && sizeMb === 0)
        ? `Definir ${f.label} como 0 (SEM LIMITE)?`
        : `Definir ${f.label} para ${sizeMb} MB?`;
    msg += f.static
        ? '\n\n⚠️ Parâmetro ESTÁTICO: gravado no SPFILE, só vale após REINICIAR o banco.'
        : '\n\n(Aplicado imediatamente, sem reiniciar.)';
    if (!confirm(msg)) return;

    try {
        const res = await secureFetch(f.endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sizeMb })
        });
        const data = await res.json();
        alert(data.success ? data.message : 'Erro: ' + (data.error || 'falha ao aplicar'));
        if (data.success) loadMemoryAdvisor();
    } catch (err) { alert('Erro ao aplicar: ' + err.message); }
}

window.showSgaMaxOrientation = function () {
    const p = lastMemoryData?.params || {};
    const os = lastMemoryData?.osMemory;
    const pga = p.pga_aggregate_target || 0;

    let sugestao = '';
    if (os && !os.error && os.totalMB) {
        // Teto "sem limite prático": ~75% da RAM menos a PGA (deixa folga p/ SO e PGA).
        const tetoMb = Math.max(p.sga_target || 0, Math.floor(os.totalMB * 0.75) - pga);
        sugestao =
            `\nSeu servidor tem ${os.totalMB} MB de RAM.\n` +
            `Teto sugerido (sem limite prático): ~${tetoMb} MB  (≈75% da RAM − PGA de ${pga} MB).\n` +
            `Comando: ALTER SYSTEM SET SGA_MAX_SIZE = ${tetoMb}M SCOPE=SPFILE;\n`;
    } else {
        sugestao = '\n(Abra esta aba com o SSH configurado para o painel sugerir um valor com base na RAM real do servidor.)\n';
    }

    const texto =
        'Como definir o SGA_MAX_SIZE "sem limite"\n' +
        '========================================\n\n' +
        'Não existe valor "ILIMITADO" para o SGA_MAX_SIZE — ele é sempre um número fixo,\n' +
        'limitado pela RAM FÍSICA do servidor. O que se faz é defini-lo ALTO o suficiente\n' +
        'para o SGA_TARGET poder crescer livremente (sem teto na prática).\n\n' +
        'Regras importantes:\n' +
        '1) É um parâmetro ESTÁTICO: use SCOPE=SPFILE e REINICIE o banco para valer.\n' +
        '2) Deixe folga para a PGA e para o Sistema Operacional — não use 100% da RAM,\n' +
        '   senão o banco pode nem subir (e pode causar swap).\n' +
        '3) Regra prática: SGA_MAX_SIZE ≈ 75% da RAM − PGA_AGGREGATE_TARGET.\n' +
        '4) Se o banco usa AMM (MEMORY_TARGET definido), ajuste MEMORY_MAX_TARGET em vez disto.\n' +
        sugestao +
        '\nDepois de gravar no SPFILE, reinicie o banco (janela de manutenção).';

    openTextModal('SGA_MAX_SIZE — orientação', texto);
}

// ===================== Configuração de Backup (DBA) =====================
async function loadBackupConfig() {
    try {
        const res = await secureFetch('/api/backup/config');
        if (res.status === 403) return; // viewer
        const json = await res.json();
        if (!json.success) return;
        lastBackupConfig = json.data;
        const d = json.data;

        // FRA — mostra o caminho quando configurada, alerta quando não.
        const fraCur = document.getElementById('cfg-fra-current');
        if (fraCur) {
            const usedTxt = d.fra.usedPct != null ? ` · em uso: ${Number(d.fra.usedPct).toFixed(0)}%` : '';
            if (d.fra.dest) {
                fraCur.innerHTML = `Atual: <strong>${d.fra.sizeGb || '?'} GB</strong>${usedTxt}` +
                    `<br><span style="color:var(--accent-green)"><i class="fas fa-circle-check"></i> Configurada em: <strong>${escapeHtml(d.fra.dest)}</strong></span>`;
            } else {
                fraCur.innerHTML = `<span style="color:var(--accent-orange); font-weight:600;"><i class="fas fa-triangle-exclamation"></i> FRA NÃO configurada</span>` +
                    `<br><span style="color:var(--text-secondary)">Defina um tamanho e clique em <strong>Aplicar</strong>: o sistema cria a pasta no servidor e a define como destino automaticamente.</span>`;
            }
        }
        const fraInput = document.getElementById('cfg-fra-size');
        if (fraInput && !fraInput.value && d.fra.sizeGb) fraInput.value = d.fra.sizeGb;

        // Retenção
        const retCur = document.getElementById('cfg-retention-current');
        if (retCur) {
            const r = d.retention || {};
            let txt;
            if (r.type === 'recovery-window') txt = `Atual: <strong>janela de ${r.days} dias</strong>`;
            else if (r.type === 'redundancy') txt = `Atual: <strong>redundância ${r.redundancy}</strong> (não é janela de dias)`;
            else txt = `Atual: ${escapeHtml(r.raw || '--')}`;
            if (!d.rmanAutomationReady) txt += '<br><span style="color:var(--accent-orange)">Automação RMAN não configurada (DB_ORACLE_HOME/DB_ORACLE_SID) — o painel mostrará o comando para rodar manualmente.</span>';
            retCur.innerHTML = txt;
        }
        const retInput = document.getElementById('cfg-retention-days');
        if (retInput && !retInput.value && d.retention?.days) retInput.value = d.retention.days;

        // Política de deleção de archive
        const delpolStatus = document.getElementById('cfg-delpol-status');
        const delpolBtn = document.getElementById('cfg-delpol-btn');
        const delpolLabel = document.getElementById('cfg-delpol-label');
        const dpEnabled = d.deletionPolicy?.enabled;
        if (delpolStatus) {
            delpolStatus.textContent = dpEnabled ? `ATIVA (${escapeHtml(d.deletionPolicy.raw)})` : 'inativa (NONE)';
            delpolStatus.style.color = dpEnabled ? 'var(--accent-green)' : 'var(--accent-orange)';
        }
        if (delpolBtn && delpolLabel) {
            delpolLabel.textContent = dpEnabled ? 'Desativar' : 'Ativar';
            delpolBtn.style.background = dpEnabled ? 'var(--accent-red)' : 'var(--accent-blue)';
            delpolBtn.dataset.enable = dpEnabled ? 'false' : 'true';
            delpolBtn.disabled = !d.rmanAutomationReady;
        }

        // Archivelog: status + botão de ação (ativar/desativar)
        const archEl = document.getElementById('cfg-arch-mode');
        const isOn = d.archivelog && d.archivelog.LOG_MODE === 'ARCHIVELOG';
        if (archEl && d.archivelog) {
            archEl.textContent = d.archivelog.LOG_MODE || '--';
            archEl.style.color = isOn ? 'var(--accent-green)' : 'var(--accent-red)';
        }
        const actBtn = document.getElementById('cfg-arch-action');
        const actLabel = document.getElementById('cfg-arch-action-label');
        if (actBtn && actLabel) {
            actLabel.textContent = isOn ? 'Desativar agora' : 'Ativar agora';
            actBtn.style.background = isOn ? 'var(--accent-red)' : 'var(--accent-green)';
            actBtn.dataset.enable = isOn ? 'false' : 'true';
            actBtn.disabled = !d.rmanAutomationReady;
            actBtn.title = d.rmanAutomationReady ? '' : 'Configure DB_ORACLE_HOME e DB_ORACLE_SID no .env para habilitar';
        }
    } catch (err) { console.warn('Backup config load fail:', err); }
}

window.handleSuggestFra = async function () {
    const btn = event?.currentTarget;
    try {
        if (btn) { btn.disabled = true; }
        const res = await secureFetch('/api/backup/config/fra-recommendation');
        const json = await res.json();
        if (!json.success) return alert('Não foi possível calcular: ' + (json.error || ''));
        const d = json.data;
        const b = d.basis;
        document.getElementById('cfg-fra-size').value = d.recommendedGb;
        let msg = `Sugestão: ${d.recommendedGb} GB para a FRA.\n\n` +
            `Base do cálculo:\n` +
            `• Redo gerado por dia: ${b.redoPerDayGb} GB\n` +
            `• Retenção: ${b.retentionDays} dias\n` +
            `• Fórmula: redo/dia × retenção × 1,5 (margem) + reserva\n`;
        if (b.freeDiskGb != null) msg += `• Disco livre no volume: ${b.freeDiskGb} GB${b.cappedByDisk ? ' (sugestão limitada a 75% disso)' : ''}\n`;
        msg += `\nObs.: se seus backups RMAN forem para a FRA, some ~${b.backupAllowanceGb} GB (1 full comprimido do banco de ${b.dbSizeGb} GB).`;
        alert(msg);
    } catch (err) {
        alert('Erro ao sugerir tamanho: ' + err.message);
    } finally {
        if (btn) btn.disabled = false;
    }
}

window.handleToggleArchivelog = async function () {
    const btn = document.getElementById('cfg-arch-action');
    const enable = btn?.dataset.enable === 'true';
    const acao = enable ? 'ATIVAR' : 'DESATIVAR';

    const aviso = `⚠️ ATENÇÃO — esta operação vai REINICIAR o banco de dados.\n\n` +
        `Vai ${acao} o modo Archivelog executando, em segundo plano:\n` +
        `SHUTDOWN IMMEDIATE → STARTUP MOUNT → ALTER DATABASE ${enable ? 'ARCHIVELOG' : 'NOARCHIVELOG'} → OPEN.\n\n` +
        `• Haverá uma INDISPONIBILIDADE de ~1 minuto.\n` +
        `• Todas as sessões ativas serão encerradas.\n` +
        (enable ? `• Confirme que o tamanho da FRA é adequado (use "Sugerir") para o banco não parar por falta de espaço.\n` : '') +
        `\nDeseja continuar?`;
    if (!confirm(aviso)) return;
    if (!confirm(`Confirmação final: ${acao} archivelog e reiniciar o banco agora?`)) return;

    try {
        const res = await secureFetch('/api/backup/config/archivelog', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enable })
        });
        const data = await res.json();
        if (!data.success) {
            return openTextModal('Archivelog', (data.error || 'Falha ao iniciar.') +
                (data.needsConfig ? '\n\nConfigure DB_ORACLE_HOME e DB_ORACLE_SID no .env, ou use "Ver procedimento" para fazer manualmente.' : ''));
        }
        openTextModal('Archivelog — em andamento', 'Operação iniciada em segundo plano. O banco está sendo reiniciado...\n\nAguarde — esta janela atualiza sozinha.');
        pollJob(data.jobId, { title: 'Archivelog', runningNote: 'o painel reconecta ao banco automaticamente ao final.' });
    } catch (err) {
        alert('Erro ao iniciar: ' + err.message);
    }
}

// Poller genérico para jobs em segundo plano (archivelog, delete-obsolete, backup).
function pollJob(jobId, opts = {}) {
    const title = opts.title || 'Operação';
    const contentEl = document.getElementById('fullSqlContent');
    let elapsed = 0;
    const timer = setInterval(async () => {
        elapsed += 2;
        try {
            const res = await secureFetch(`/api/backup/config/job/${jobId}`);
            const json = await res.json();
            if (!json.success) return;
            const job = json.data;
            if (job.state === 'running') {
                if (contentEl) contentEl.textContent = `${job.message}\n\n(${elapsed}s decorridos${opts.runningNote ? ' — ' + opts.runningNote : ''})`;
                return;
            }
            clearInterval(timer);
            const ok = job.state === 'done';
            if (contentEl) contentEl.textContent = `${ok ? '✅' : '❌'} ${job.message}\n\n--- Saída do RMAN/banco ---\n${job.output || '(sem saída)'}`;
            document.getElementById('modalSqlId').textContent = `${title} — ${ok ? 'concluído' : 'falhou'}`;
            // Ao terminar a execução, atualiza TODAS as telas automaticamente.
            setTimeout(refreshAllSections, 1500);
            if (ok && opts.onDone) opts.onDone();
        } catch (err) {
            if (contentEl) contentEl.textContent = `Processando... (${elapsed}s)`;
        }
    }, 2000);
}

window.handleToggleDeletionPolicy = async function () {
    const btn = document.getElementById('cfg-delpol-btn');
    const enable = btn?.dataset.enable === 'true';
    const acao = enable ? 'ATIVAR (BACKED UP 1 TIMES TO DISK)' : 'DESATIVAR (NONE)';
    if (!confirm(`${enable ? 'Ativar' : 'Desativar'} a política de deleção de archivelog?\n\nComando: CONFIGURE ARCHIVELOG DELETION POLICY TO ${enable ? 'BACKED UP 1 TIMES TO DISK' : 'NONE'};\n\n${enable ? 'Com ela ativa, a FRA recicla automaticamente os archives já copiados.' : 'Sem ela, a FRA não recicla archives automaticamente.'}`)) return;
    try {
        const res = await secureFetch('/api/backup/config/deletion-policy', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enable })
        });
        const data = await res.json();
        if (data.success) { alert(data.message); loadBackupConfig(); }
        else openTextModal('Política de deleção', (data.message || data.error || 'Falha.') + (data.manual ? `\n\n--- Comando manual ---\n${data.manual}` : ''));
    } catch (err) { alert('Erro: ' + err.message); }
}

window.handleDeleteObsolete = async function () {
    if (!confirm('Rodar DELETE OBSOLETE agora?\n\nIsto apaga FISICAMENTE os backups/arquivos já fora da política de retenção. Itens dentro da janela de retenção NÃO são afetados.\n\nDeseja continuar?')) return;
    try {
        const res = await secureFetch('/api/backup/config/delete-obsolete', { method: 'POST' });
        const data = await res.json();
        if (!data.success) return openTextModal('Limpar obsoletos', (data.error || 'Falha ao iniciar.') + (data.needsConfig ? '\n\nConfigure DB_ORACLE_HOME e DB_ORACLE_SID no .env.' : ''));
        openTextModal('Limpeza de obsoletos — em andamento', 'Iniciada em segundo plano...\n\nAguarde — esta janela atualiza sozinha.');
        pollJob(data.jobId, { title: 'Limpeza de obsoletos' });
    } catch (err) { alert('Erro: ' + err.message); }
}

window.handleRunBackup = async function () {
    const type = document.getElementById('cfg-backup-type').value;
    const label = type === 'archivelog' ? 'apenas archivelogs' : 'banco completo + archivelogs';
    if (!confirm(`Executar backup (${label}) agora?\n\nO backup é gravado no destino configurado (geralmente a FRA) e pode levar tempo. Os archivelogs são removidos após o backup (DELETE INPUT), liberando espaço.\n\nDeseja continuar?`)) return;
    try {
        const res = await secureFetch('/api/backup/config/backup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type })
        });
        const data = await res.json();
        if (!data.success) return openTextModal('Backup', (data.error || 'Falha ao iniciar.') + (data.needsConfig ? '\n\nConfigure DB_ORACLE_HOME e DB_ORACLE_SID no .env.' : ''));
        openTextModal('Backup — em andamento', `Backup (${label}) iniciado em segundo plano...\n\nPode levar vários minutos. Esta janela atualiza sozinha; você pode fechá-la — o backup continua no servidor.`);
        pollJob(data.jobId, { title: 'Backup' });
    } catch (err) { alert('Erro: ' + err.message); }
}

window.handleSetFraSize = async function () {
    const sizeGb = document.getElementById('cfg-fra-size').value;
    if (!sizeGb) return alert('Informe o tamanho da FRA em GB.');

    const notConfigured = !(lastBackupConfig && lastBackupConfig.fra && lastBackupConfig.fra.dest);
    const msg = notConfigured
        ? `A FRA ainda NÃO está configurada.\n\nAo confirmar, o sistema vai (sem reiniciar o banco):\n` +
          `1) criar a pasta da FRA no servidor;\n` +
          `2) defini-la como destino (DB_RECOVERY_FILE_DEST);\n` +
          `3) definir o tamanho máximo em ${sizeGb} GB.\n\nDeseja continuar?`
        : `Definir o tamanho máximo da FRA para ${sizeGb} GB?\n\nComando: ALTER SYSTEM SET DB_RECOVERY_FILE_DEST_SIZE = ${sizeGb}G SCOPE=BOTH\n\n(É aplicado imediatamente, sem reiniciar o banco.)`;
    if (!confirm(msg)) return;

    try {
        const res = await secureFetch('/api/backup/config/fra-size', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sizeGb: Number(sizeGb) })
        });
        const data = await res.json();
        alert(data.success ? data.message : 'Erro: ' + (data.error || 'falha ao aplicar'));
        if (data.success) loadBackupData(); // atualiza stat + config (mostra o novo caminho)
    } catch (err) { alert('Erro ao aplicar: ' + err.message); }
}

window.handleSetRetention = async function () {
    const days = document.getElementById('cfg-retention-days').value;
    if (!days) return alert('Informe a quantidade de dias de retenção.');
    if (!confirm(`Definir a retenção do RMAN para janela de ${days} dias?\n\n(É aplicado via RMAN, sem reiniciar o banco.)`)) return;
    try {
        const res = await secureFetch('/api/backup/config/retention', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days: Number(days) })
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message);
            loadBackupConfig();
        } else {
            // Não aplicado automaticamente → mostra a mensagem + comando manual no modal.
            const body = (data.message || data.error || 'Não foi possível aplicar.') +
                (data.detail ? `\n\nDetalhe: ${data.detail}` : '') +
                (data.manual ? `\n\n--- Rode este comando no servidor: ---\n${data.manual}` : '');
            openTextModal('Retenção do RMAN', body);
        }
    } catch (err) { alert('Erro ao aplicar: ' + err.message); }
}

window.showArchivelogProcedure = function () {
    if (!lastBackupConfig) return;
    const mode = lastBackupConfig.archivelog?.LOG_MODE || '';
    const proc = lastBackupConfig.archivelogProcedure || {};
    const isOn = mode === 'ARCHIVELOG';
    const target = isOn ? proc.disable : proc.enable;
    const titulo = isOn ? 'Desativar Archivelog (NOARCHIVELOG)' : 'Ativar Archivelog';
    const intro = `Modo atual: ${mode}\n\nObservação: este procedimento exige uma parada breve do banco (estado MOUNT). Execute em janela de manutenção.\n\n`;
    openTextModal(titulo, intro + (target || ''));
}

// Reusa o modal de SQL para exibir texto genérico (procedimentos / comandos)
function openTextModal(title, text) {
    currentSqlId = null; // desabilita o botão "Ver Plano"
    const modal = document.getElementById('sqlModal');
    document.getElementById('modalSqlId').textContent = title;
    document.getElementById('fullSqlContent').textContent = text;
    modal.style.display = 'block';
}

// ===================== Atualização global após execuções =====================
// Recarrega os dados de TODAS as telas. Chamado ao fim de um job (backup,
// archivelog, limpeza) ou de um comando DML/DDL no Terminal SQL.
function refreshAllSections() {
    [refreshData, loadStorageData, loadSessionsData, loadMemoryAdvisor, loadBackupData, loadTrendData]
        .forEach((fn) => { try { fn(); } catch (e) { /* cada loader trata o próprio erro */ } });
}

// ===================== Logs de Backup =====================
// Botão "Logs das execuções": saída completa dos jobs disparados pelo painel.
window.showBackupLogs = async function () {
    openTextModal('Logs das execuções (painel)', 'Carregando...');
    const el = document.getElementById('fullSqlContent');
    try {
        const res = await secureFetch('/api/backup/config/jobs');
        const json = await res.json();
        if (!json.success || !json.data || json.data.length === 0) {
            el.textContent = 'Nenhuma execução registrada nesta sessão do servidor.\n\n' +
                '(As operações de backup, archivelog, limpeza de obsoletos e retenção feitas pelo painel aparecem aqui com a saída completa.)';
            return;
        }
        const fmt = (ts) => ts ? new Date(ts).toLocaleString('pt-BR') : '-';
        el.textContent = json.data.map((j) => {
            const dur = j.finishedAt ? `${Math.round((j.finishedAt - j.startedAt) / 1000)}s` : 'em andamento';
            const status = j.state === 'done' ? '✅ concluído' : j.state === 'failed' ? '❌ falhou' : '⏳ rodando';
            return '══════════════════════════════════════════════\n' +
                `[${j.action}] ${status}  •  ${fmt(j.startedAt)}  •  ${dur}\n` +
                `${j.message || ''}\n` +
                `------ saída ------\n${j.output || '(sem saída)'}\n`;
        }).join('\n');
    } catch (err) {
        el.textContent = 'Erro ao carregar logs: ' + err.message;
    }
}

// Botão "Log" por linha do histórico: saída do v$rman_output (volátil).
window.showRmanRowLog = async function (sessionKey) {
    openTextModal(`Log RMAN — sessão ${sessionKey}`, 'Carregando log do v$rman_output...');
    const el = document.getElementById('fullSqlContent');
    try {
        const res = await secureFetch(`/api/backup/rman-log/${sessionKey}`);
        const json = await res.json();
        if (!json.success) { el.textContent = 'Erro: ' + (json.error || 'falha ao carregar'); return; }
        el.textContent = (json.data.output && json.data.output.trim())
            ? json.data.output
            : 'Log não disponível para esta sessão.\n\n' +
              'O v$rman_output é volátil: guarda apenas a saída de execuções recentes na instância atual. ' +
              'Para backups antigos ou após reiniciar o banco, o log pode não estar mais disponível.\n\n' +
              'Dica: use "Logs das execuções" para ver a saída dos backups disparados pelo painel.';
    } catch (err) {
        el.textContent = 'Erro ao carregar: ' + err.message;
    }
}

// ===================== Terminal SQL =====================
window.clearSqlTerminal = function () {
    const input = document.getElementById('sql-input');
    if (input) { input.value = ''; input.focus(); }
    const el = document.getElementById('sql-results');
    if (el) el.innerHTML = '';
}

function sqlNotice(kind, html) {
    const map = {
        info: { bg: 'rgba(37,99,235,0.1)', col: 'var(--accent-blue)', icon: 'fa-circle-info' },
        ok: { bg: 'rgba(16,185,129,0.1)', col: 'var(--accent-green)', icon: 'fa-circle-check' },
        error: { bg: 'rgba(239,68,68,0.1)', col: 'var(--accent-red)', icon: 'fa-circle-exclamation' },
    };
    const c = map[kind] || map.info;
    return `<div class="card col-12" style="margin-bottom:1rem;"><div style="display:flex; gap:10px; align-items:flex-start; padding:14px 16px; border-radius:10px; background:${c.bg}; color:${c.col};">
        <i class="fas ${c.icon}" style="margin-top:3px;"></i>
        <div style="font-family:'JetBrains Mono','Consolas',monospace; font-size:0.85rem; white-space:pre-wrap; word-break:break-word;">${html}</div></div></div>`;
}

function formatCell(v) {
    if (v === null || v === undefined) return '<span style="color:var(--text-secondary); font-style:italic;">(null)</span>';
    return escapeHtml(String(v));
}

function renderSqlResults(results) {
    const el = document.getElementById('sql-results');
    if (!el) return;
    if (!results || results.length === 0) { el.innerHTML = sqlNotice('info', 'Comando executado (sem retorno).'); return; }

    el.innerHTML = results.map((r, idx) => {
        const stmt = escapeHtml((r.statement || '').length > 300 ? r.statement.slice(0, 300) + '…' : (r.statement || ''));
        const head = `<div style="font-family:'JetBrains Mono','Consolas',monospace; font-size:0.78rem; color:var(--text-secondary); margin-bottom:0.6rem; white-space:pre-wrap; word-break:break-word;"><span class="badge badge-blue">#${idx + 1}</span> ${stmt}</div>`;

        if (r.type === 'error') {
            return `<div class="card col-12" style="margin-bottom:1rem;"><div class="card-body" style="padding:1.1rem;">${head}
                <div style="display:flex; gap:10px; align-items:flex-start; padding:12px 14px; border-radius:8px; background:rgba(239,68,68,0.1); color:var(--accent-red);">
                    <i class="fas fa-circle-exclamation" style="margin-top:3px;"></i>
                    <div style="font-family:'JetBrains Mono','Consolas',monospace; font-size:0.85rem; white-space:pre-wrap;">${escapeHtml(r.error)}</div>
                </div></div></div>`;
        }
        if (r.type === 'status') {
            return `<div class="card col-12" style="margin-bottom:1rem;"><div class="card-body" style="padding:1.1rem;">${head}
                <div style="display:flex; gap:10px; align-items:center; padding:12px 14px; border-radius:8px; background:rgba(16,185,129,0.1); color:var(--accent-green);">
                    <i class="fas fa-circle-check"></i><div style="font-weight:600;">${escapeHtml(r.message)}</div>
                </div></div></div>`;
        }
        // type === 'rows'
        const cols = r.columns || [];
        if (!r.rowCount) {
            return `<div class="card col-12" style="margin-bottom:1rem;"><div class="card-body" style="padding:1.1rem;">${head}
                <div style="color:var(--text-secondary); padding:8px 0;"><i class="fas fa-circle-info"></i> 0 linha(s) retornada(s).</div></div></div>`;
        }
        const thead = `<tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
        const tbody = r.rows.map((row) => `<tr>${cols.map((c) => `<td style="font-family:'JetBrains Mono','Consolas',monospace; font-size:0.8rem; white-space:nowrap;">${formatCell(row[c])}</td>`).join('')}</tr>`).join('');
        const trunc = r.truncated ? `<div style="font-size:0.75rem; color:var(--accent-orange); margin-top:0.5rem;"><i class="fas fa-triangle-exclamation"></i> Exibindo as primeiras ${r.rowCount} linhas (resultado truncado).</div>` : '';
        return `<div class="card col-12" style="margin-bottom:1rem;"><div class="card-body" style="padding:1.1rem;">${head}
            <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:0.5rem;">${r.rowCount} linha(s)</div>
            <div class="table-container" style="max-height:440px; overflow:auto;"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>${trunc}</div></div>`;
    }).join('');
}

window.runSqlTerminal = async function () {
    const input = document.getElementById('sql-input');
    const btn = document.getElementById('sql-run-btn');
    const resultsEl = document.getElementById('sql-results');
    const sql = (input && input.value || '').trim();
    if (!sql) { resultsEl.innerHTML = sqlNotice('info', 'Digite um comando SQL para executar.'); return; }

    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Executando...';
    resultsEl.innerHTML = sqlNotice('info', 'Executando...');

    try {
        const res = await secureFetch('/api/sql/execute', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql })
        });
        const data = await res.json();
        if (!data.success) {
            resultsEl.innerHTML = sqlNotice('error', escapeHtml(data.error || 'Falha ao executar.'));
        } else {
            renderSqlResults(data.results);
            // Se houve DML/DDL (algo que muda estado), atualiza as outras telas.
            if (data.results.some((r) => r.type === 'status')) refreshAllSections();
        }
    } catch (err) {
        resultsEl.innerHTML = sqlNotice('error', 'Erro de rede: ' + escapeHtml(err.message));
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
}

// ===================== Exportação CSV =====================
function downloadCsv(filename, rows) {
    if (!rows || rows.length === 0) return alert('Não há dados para exportar.');
    const headers = Object.keys(rows[0]);
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [headers.join(',')]
        .concat(rows.map(r => headers.map(h => escape(r[h])).join(',')))
        .join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}

window.exportStorageCsv = function () {
    downloadCsv(`tablespaces_${new Date().toISOString().slice(0, 10)}.csv`, lastStorageData);
}

window.exportSessionsCsv = function () {
    downloadCsv(`sessoes_locks_${new Date().toISOString().slice(0, 10)}.csv`, lastSessionsData);
}

window.closeModal = () => document.getElementById('sqlModal').style.display = 'none';
window.copySql = () => {
    const content = document.getElementById('fullSqlContent').textContent;
    navigator.clipboard.writeText(content).then(() => alert('Copiado!'));
}

window.handleOptimize = async function () {
    if (!confirm('Deseja realmente iniciar a otimização das tabelas do banco? \nEste processo irá deletar as estatísticas atuais de 17 tabelas críticas.')) return;

    // Feedback visual de carregamento
    const btn = event.currentTarget;
    const originalContent = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Otimizando...';

    try {
        const res = await secureFetch('/api/performance/optimize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        alert(data.message);
    } catch (err) {
        alert('Erro ao executar otimização: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalContent;
    }
}

window.onclick = (e) => { if (e.target == document.getElementById('sqlModal')) closeModal(); }

function formatUptime(minutes) {
    if (minutes < 60) return `${Math.floor(minutes)}m`;
    const hours = minutes / 60;
    if (hours < 24) return `${Math.floor(hours)}h ${Math.floor(minutes % 60)}m`;
    return `${Math.floor(hours / 24)}d ${Math.floor(hours % 24)}h`;
}

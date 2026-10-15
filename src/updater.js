/**
 * UPDATER.JS - Verificação e atualização pelo GitHub (tela "Sobre").
 *
 * - checkLatest(): consulta a última Release do repositório no GitHub e compara
 *   com a versão atual (package.json). Usa o módulo https (funciona no Node 16+).
 * - startUpdate(): SÓ na instalação Windows (serviço). Baixa o instalador oficial
 *   anexado à Release, confere o SHA-256 (se publicado nas notas), e o executa em
 *   modo silencioso mantendo o .env (/KEEPCONFIG=1). O instalador para o serviço,
 *   troca os arquivos e reinicia — por isso ele é lançado pelo Agendador de Tarefas
 *   (via launchUpdater), FORA do job object do serviço, para sobreviver à parada do
 *   serviço durante a troca de arquivos.
 *
 * Segurança: rota só-DBA e auditada; download apenas do host do GitHub e do
 * repositório configurado; exige a senha de instalação do dia (o instalador a
 * valida). Nada é executado fora esse instalador oficial.
 */
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { config } = require('./config');
const logger = require('./logger');

const ROOT = path.join(__dirname, '..');
const UA = 'Oracle-Pulse-Updater';
const ALLOWED_HOST = /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/;

function currentVersion() {
    try { return String(require('../package.json').version || '0.0.0'); } catch { return '0.0.0'; }
}

/** Compara "X.Y.Z" (ignora um "v" inicial). >0 se a>b, <0 se a<b, 0 se iguais. */
function compareVersions(a, b) {
    const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
}

function badRequest(message) {
    const e = new Error(message);
    e.status = 400;
    return e;
}

/** GET HTTPS com redirecionamento e User-Agent (GitHub exige UA). */
function httpsGet(url, opts = {}) {
    const { headers = {}, redirects = 5, timeoutMs = 20000 } = opts;
    return new Promise((resolve, reject) => {
        let req;
        try {
            req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json', ...headers } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                    res.resume();
                    const next = new URL(res.headers.location, url).toString();
                    return resolve(httpsGet(next, { headers, redirects: redirects - 1, timeoutMs }));
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
            });
        } catch (err) { return reject(err); }
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('tempo esgotado ao contatar o GitHub')));
    });
}

/** Extrai o primeiro SHA-256 (64 hex) das notas da release, se houver. */
function extractSha256(notes) {
    const m = /\bSHA-?256\b[^0-9a-f]*([0-9a-f]{64})/i.exec(String(notes || ''));
    return m ? m[1].toLowerCase() : null;
}

function pickAsset(assets) {
    const list = assets || [];
    return list.find((a) => /\.exe$/i.test(a.name) && /setup/i.test(a.name))
        || list.find((a) => /\.exe$/i.test(a.name))
        || null;
}

/** Instalação Windows reconhecida (serviço): existe o desinstalador do Inno. */
function isInstalledService() {
    return process.platform === 'win32' && fs.existsSync(path.join(ROOT, 'unins000.exe'));
}

/** Consulta a última release e compara com a versão atual. */
async function checkLatest() {
    const current = currentVersion();
    if (!config.update.enabled) return { current, latest: null, newer: false, reason: 'Verificação de atualização desativada (UPDATE_DISABLED).' };

    if (config.demoMode) {
        const latest = current.replace(/(\d+)$/, (n) => String(Number(n) + 1)); // ex.: 2.2.7 -> 2.2.8
        return {
            current, latest, newer: true, demo: true,
            url: `https://github.com/${config.update.repo}/releases`,
            notes: 'Versão de demonstração: correções e melhorias.\nSHA-256: (exemplo)',
            publishedAt: new Date().toISOString(),
            asset: { name: `OraclePulse-Setup-${latest}.exe`, url: 'https://example/demo', size: 27000000 },
        };
    }

    const repo = config.update.repo;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw badRequest('UPDATE_REPO inválido (use "dono/repositorio").');
    const r = await httpsGet(`https://api.github.com/repos/${repo}/releases/latest`);
    if (r.status === 404) return { current, latest: null, newer: false, reason: 'Ainda não há versões publicadas (Releases) no GitHub.' };
    if (r.status === 403) return { current, latest: null, newer: false, reason: 'Limite de consultas ao GitHub atingido. Tente mais tarde.' };
    if (r.status !== 200) throw new Error(`GitHub respondeu ${r.status} ao consultar as versões.`);

    let rel;
    try { rel = JSON.parse(r.body.toString('utf8')); } catch { throw new Error('Resposta inesperada do GitHub.'); }
    const latest = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
    if (!latest) return { current, latest: null, newer: false, reason: 'A última release não tem número de versão (tag).' };
    const asset = pickAsset(rel.assets);
    return {
        current, latest,
        newer: compareVersions(latest, current) > 0,
        url: rel.html_url,
        notes: rel.body || '',
        publishedAt: rel.published_at,
        asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
        sha256: extractSha256(rel.body),
    };
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Baixa uma URL (com redirecionamento) para um arquivo. */
async function downloadTo(url, dest) {
    const u = new URL(url);
    if (!ALLOWED_HOST.test(u.hostname)) throw badRequest('URL de download não confiável (fora do GitHub).');
    const r = await httpsGet(url, { headers: { Accept: 'application/octet-stream' }, timeoutMs: 120000 });
    if (r.status !== 200) throw new Error(`Falha ao baixar o instalador (HTTP ${r.status}).`);
    fs.writeFileSync(dest, r.body);
    return dest;
}

/**
 * Baixa o instalador oficial da última release e o executa (silencioso, mantendo
 * o .env). Só na instalação Windows (serviço). Exige a senha de instalação do dia.
 */
async function startUpdate({ installPassword } = {}) {
    if (!config.update.enabled) throw badRequest('Atualização desativada por configuração.');
    const pwd = String(installPassword || '').trim();
    if (!pwd) throw badRequest('Informe a senha de instalação:');

    if (config.demoMode) return { started: false, demo: true, message: 'Simulação: em uma instalação real, o instalador seria baixado e executado agora.' };

    if (process.platform !== 'win32' || !isInstalledService()) {
        throw badRequest('A atualização automática está disponível só na instalação Windows (serviço). Em outros ambientes, atualize manualmente (git pull / novo instalador).');
    }

    const info = await checkLatest();
    if (!info.newer) throw badRequest('Você já está na versão mais recente.');
    if (!info.asset || !info.asset.url) throw badRequest('A versão mais recente não tem o instalador (.exe) anexado no GitHub Releases.');

    const tmp = path.join(os.tmpdir(), `OraclePulse-Update-${info.latest}-${Date.now()}.exe`);
    await downloadTo(info.asset.url, tmp);

    if (info.sha256) {
        const got = sha256File(tmp);
        if (got !== info.sha256) {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            throw badRequest('Verificação de integridade falhou: o SHA-256 do download não bate com o publicado na release.');
        }
    }

    // Confere a senha do dia ANTES de agendar: o instalador baixado valida a senha
    // (modo /VERIFYONLY) e devolve OK/BAD. Assim o usuário tem retorno imediato.
    const verdict = verifyInstallPassword(tmp, pwd);
    if (verdict === 'BAD') {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw badRequest('Senha de instalação incorreta. Confira o código do dia no aplicativo "Oracle Pulse" e tente de novo.');
    }
    // 'OK' segue; '' ou 'NOGATE' (verificação indisponível): segue — o próprio
    // instalador ainda confere a senha antes de parar o serviço.

    const launched = launchUpdater(tmp, ROOT, pwd);
    logger.warn(`Atualização iniciada para a versão ${info.latest} (instalador: ${tmp}, tarefa: ${launched.taskName}).`);
    return { started: true, version: info.latest, verified: !!info.sha256, log: launched.log };
}

/**
 * Lança o instalador por uma via INDEPENDENTE do serviço: o Agendador de Tarefas.
 *
 * Por que não `spawn(..., {detached:true})`: o painel roda como serviço do Windows
 * (WinSW). Um processo filho, mesmo "detached", fica no MESMO job object do serviço;
 * quando o instalador manda parar o serviço, o Windows encerra o job inteiro e mata
 * o próprio instalador — a atualização nunca conclui (foi o que acontecia). Uma
 * tarefa agendada roda no processo do Agendador, fora do nosso job, e sobrevive.
 *
 * Fluxo: grava um .cmd (espera a resposta HTTP voltar, roda o instalador silencioso,
 * se apaga), cria uma tarefa ONCE como SYSTEM e dispara com /Run. O instalador para
 * o serviço, troca os arquivos mantendo o .env (/KEEPCONFIG) e reinicia o serviço.
 * @returns {{log:string, taskName:string, cmdFile:string}}
 */
/**
 * Confere a senha do dia rodando o instalador baixado em modo "só verificar"
 * (/VERIFYONLY): ele valida a senha com o mesmo algoritmo do gate, grava OK/BAD
 * num arquivo e sai SEM instalar nada. Retorna 'OK', 'BAD', 'NOGATE' ou '' (quando
 * não foi possível verificar — aí o fluxo segue e o próprio instalador confere).
 */
function verifyInstallPassword(installerExe, pwd) {
    const out = path.join(os.tmpdir(), `OraclePulse-Verify-${Date.now()}.txt`);
    try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch { /* ignore */ }
    try {
        spawnSync(installerExe, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/VERIFYONLY=1', `/INSTALLPWD=${pwd}`, `/VERIFYOUT=${out}`], { windowsHide: true, timeout: 120000 });
    } catch { /* o resultado é lido do arquivo, não do código de saída */ }
    let res = '';
    try { res = fs.readFileSync(out, 'utf8').trim().toUpperCase(); } catch { /* ignore */ }
    try { fs.unlinkSync(out); } catch { /* ignore */ }
    return res;
}

function launchUpdater(installerExe, installDir, pwd) {
    const stamp = Date.now();
    const log = path.join(os.tmpdir(), `OraclePulse-Update-${stamp}.log`);
    const cmdFile = path.join(os.tmpdir(), `OraclePulse-Update-${stamp}.cmd`);
    const taskName = `OraclePulseUpdate_${stamp}`;
    const cmd = [
        '@echo off',
        'ping -n 4 127.0.0.1 >nul',   // ~3 s: deixa a resposta HTTP chegar ao navegador antes de parar o serviço
        `"${installerExe}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART "/INSTALLPWD=${pwd}" /KEEPCONFIG=1 "/DIR=${installDir}" "/LOG=${log}"`,
        `schtasks /Delete /TN "${taskName}" /F >nul 2>&1`,
        'del "%~f0" >nul 2>&1',       // o .cmd se apaga
    ].join('\r\n') + '\r\n';
    fs.writeFileSync(cmdFile, cmd, { encoding: 'latin1' }); // code page padrão do cmd.exe

    const create = spawnSync('schtasks', ['/Create', '/TN', taskName, '/TR', `"${cmdFile}"`, '/SC', 'ONCE', '/ST', '00:00', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F'], { windowsHide: true, encoding: 'utf8' });
    if (create.status !== 0) {
        try { fs.unlinkSync(cmdFile); } catch { /* ignore */ }
        throw new Error('não foi possível agendar a atualização: ' + String(create.stderr || create.stdout || create.error || '').trim().slice(0, 200));
    }
    const run = spawnSync('schtasks', ['/Run', '/TN', taskName], { windowsHide: true, encoding: 'utf8' });
    if (run.status !== 0) {
        throw new Error('não foi possível iniciar a atualização agendada: ' + String(run.stderr || run.stdout || '').trim().slice(0, 200));
    }
    return { log, taskName, cmdFile };
}

function about() {
    // A referência ao repositório fica OCULTA no sistema: o repo é usado só
    // internamente (verificação/atualização) e não é exposto na interface/API.
    return {
        name: 'Oracle Pulse',
        version: currentVersion(),
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        installDir: ROOT,
        installedService: isInstalledService(),
        updateEnabled: config.update.enabled,
        demo: config.demoMode,
    };
}

/** Versão da verificação SEM dados que identifiquem o repositório (para a UI/API). */
function checkLatestPublic(info) {
    return {
        current: info.current,
        latest: info.latest,
        newer: info.newer,
        reason: info.reason || null,
        notes: info.notes || null,
        publishedAt: info.publishedAt || null,
        demo: info.demo || false,
        asset: info.asset ? { name: info.asset.name, size: info.asset.size } : null,
    };
}

module.exports = { about, checkLatest, checkLatestPublic, startUpdate, launchUpdater, verifyInstallPassword, currentVersion, compareVersions, isInstalledService, extractSha256, pickAsset };

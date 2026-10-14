/**
 * UPDATER.JS - Verificação e atualização pelo GitHub (tela "Sobre").
 *
 * - checkLatest(): consulta a última Release do repositório no GitHub e compara
 *   com a versão atual (package.json). Usa o módulo https (funciona no Node 16+).
 * - startUpdate(): SÓ na instalação Windows (serviço). Baixa o instalador oficial
 *   anexado à Release, confere o SHA-256 (se publicado nas notas), e o executa em
 *   modo silencioso mantendo o .env (/KEEPCONFIG=1). O instalador para o serviço,
 *   troca os arquivos e reinicia — por isso ele é lançado "destacado" (sobrevive ao
 *   fim do processo do painel).
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
const { spawn } = require('child_process');
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
    if (!pwd) throw badRequest('Informe a senha de instalação do dia (aplicativo "Oracle Pulse").');

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

    const log = path.join(os.tmpdir(), `OraclePulse-Update-${info.latest}-${Date.now()}.log`);
    const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/INSTALLPWD=${pwd}`, '/KEEPCONFIG=1', `/DIR=${ROOT}`, `/LOG=${log}`];
    // Destacado: o instalador para o serviço (encerra o painel) e segue sozinho.
    const child = spawn(tmp, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    logger.warn(`Atualização iniciada para a versão ${info.latest} (instalador: ${tmp}).`);
    return { started: true, version: info.latest, verified: !!info.sha256, log };
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

module.exports = { about, checkLatest, checkLatestPublic, startUpdate, currentVersion, compareVersions, isInstalledService, extractSha256, pickAsset };

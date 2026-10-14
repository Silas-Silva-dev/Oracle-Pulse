/**
 * AUDIT.JS - Registro de auditoria das ações sensíveis (kill, resize, add-file,
 * optimize, login). Grava em logs/audit.log (JSON lines) e mantém os últimos
 * registros em memória para exibição rápida no painel.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const logger = require('./logger');

const MAX_MEMORY = 200;
// Limite p/ rotação (audit.log.1). Padrão 5 MB; ajustável via AUDIT_MAX_MB.
const MAX_AUDIT_BYTES = parseInt(process.env.AUDIT_MAX_BYTES, 10) ||
    (parseInt(process.env.AUDIT_MAX_MB, 10) || 5) * 1024 * 1024;
const recent = []; // mais recentes no fim
const auditFile = path.join(config.paths.logs, 'audit.log');
const archiveFile = auditFile + '.1';
let currentBytes = 0;

// Garante a pasta de logs
try {
    fs.mkdirSync(config.paths.logs, { recursive: true });
} catch (err) {
    logger.warn('Não foi possível criar a pasta de logs:', err.message);
}

/**
 * Carrega as últimas entradas para a memória (do arquivo arquivado + o atual),
 * para que a trilha continue visível no painel após reiniciar a aplicação.
 */
function loadFromDisk() {
    const all = [];
    for (const file of [archiveFile, auditFile]) { // ordem cronológica
        try {
            if (!fs.existsSync(file)) continue;
            const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
            for (const line of lines) {
                try { all.push(JSON.parse(line)); } catch { /* ignora linha corrompida */ }
            }
        } catch (err) {
            logger.warn(`Não foi possível ler ${path.basename(file)}:`, err.message);
        }
    }
    for (const e of all.slice(-MAX_MEMORY)) recent.push(e);
    if (recent.length > 0) {
        logger.info(`Auditoria: ${recent.length} registro(s) restaurado(s) do disco.`);
    }
    // Tamanho atual do arquivo, para controlar a rotação.
    try { currentBytes = fs.existsSync(auditFile) ? fs.statSync(auditFile).size : 0; } catch { currentBytes = 0; }
}

/** Rotaciona o audit.log para audit.log.1 quando passa do tamanho limite. */
function rotateIfNeeded(nextBytes) {
    if (currentBytes + nextBytes <= MAX_AUDIT_BYTES) return;
    try {
        if (fs.existsSync(archiveFile)) fs.unlinkSync(archiveFile); // sobrescreve o .1 anterior (Windows-safe)
        if (fs.existsSync(auditFile)) fs.renameSync(auditFile, archiveFile);
        currentBytes = 0;
        logger.info('Auditoria: audit.log rotacionado para audit.log.1');
    } catch (err) {
        logger.warn('Falha ao rotacionar audit.log:', err.message);
    }
}

loadFromDisk();

/**
 * Registra um evento de auditoria.
 * @param {object} entry { action, user, role, ip, detail, success }
 */
function record({ action, user = 'desconhecido', role = '-', ip = '-', detail = '', success = true }) {
    const entry = {
        ts: new Date().toISOString(),
        action,
        user,
        role,
        ip,
        detail,
        success,
    };

    recent.push(entry);
    if (recent.length > MAX_MEMORY) recent.shift();

    const line = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(line);
    rotateIfNeeded(bytes);
    fs.appendFile(auditFile, line, (err) => {
        if (err) logger.warn('Falha ao gravar audit.log:', err.message);
    });
    currentBytes += bytes;

    logger.info(`AUDIT [${success ? 'OK' : 'FALHA'}] ${action} por ${user}@${ip} ${detail ? '- ' + detail : ''}`);
    return entry;
}

/** Helper para extrair IP do request. */
function ipOf(req) {
    return req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '-';
}

function getRecent(limit = 100) {
    return recent.slice(-limit).reverse();
}

/**
 * Zera a trilha (audit.log e audit.log.1) e a memória. Quem chama registra a
 * limpeza logo em seguida: a nova trilha começa por ela.
 * @returns {{files:number, bytes:number}}
 */
function clear() {
    let files = 0;
    let bytes = 0;
    for (const file of [archiveFile, auditFile]) {
        try {
            if (!fs.existsSync(file)) continue;
            bytes += fs.statSync(file).size;
            fs.unlinkSync(file);
            files++;
        } catch (err) {
            // Arquivo preso (Windows): zera o conteúdo.
            try { fs.truncateSync(file, 0); files++; } catch { logger.warn(`Não foi possível limpar ${path.basename(file)}:`, err.message); }
        }
    }
    recent.length = 0;
    currentBytes = 0;
    return { files, bytes };
}

module.exports = { record, getRecent, ipOf, clear };

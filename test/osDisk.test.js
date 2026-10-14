/**
 * Leitura REAL de volumes com os comandos do painel:
 *  - Windows (quando o teste roda no Windows): Win32_Volume via PowerShell,
 *    exatamente como no servidor Windows sem SSH;
 *  - Linux: o comando sh do `df` por diretório, executado num bash/sh local
 *    (Git Bash no Windows, ou o próprio sh no Linux).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APP = process.env.OP_APP_DIR ? path.resolve(process.env.OP_APP_DIR) : path.resolve(__dirname, '..');

// Carrega a app sem ler o .env do desenvolvedor e sem SSH (modo "painel local").
function loadOsDisk() {
    const prev = process.cwd();
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'op-osdisk-')));
    process.env.SSH_HOST = '';
    process.env.DOTENV_CONFIG_QUIET = 'true';
    try {
        return require(path.join(APP, 'src', 'osDisk.js'));
    } finally {
        process.chdir(prev);
    }
}

function findSh() {
    const candidates = process.platform === 'win32'
        ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), 'C:\\Program Files\\Git\\bin\\bash.exe']
        : ['/bin/sh'];
    return candidates.find((c) => fs.existsSync(c)) || null;
}

test('Windows: lê os volumes reais (Win32_Volume) e associa os diretórios', { skip: process.platform !== 'win32' && 'só no Windows' }, async () => {
    const { readDiskUsage } = loadOsDisk();
    const sp = require(path.join(APP, 'src', 'storagePaths.js'));
    const sysDir = sp.normalizeDir(process.env.SystemRoot || 'C:\\Windows');
    const tmpDir = sp.normalizeDir(os.tmpdir());
    const usage = await readDiskUsage([sysDir, tmpDir.toLowerCase()]);
    assert.deepEqual(usage.errors, [], usage.errors.join('; '));
    const sysMount = usage.dirMount[sp.dirKey(sysDir)];
    assert.ok(sysMount, 'diretório do Windows associado a um volume');
    assert.equal(sysMount.slice(0, 2).toUpperCase(), sysDir.slice(0, 2).toUpperCase());
    assert.ok(usage.dirMount[sp.dirKey(tmpDir)], 'grafia em minúsculas associada mesmo assim');
    const m = usage.mounts.find((x) => x.mount === sysMount);
    assert.ok(m.totalBytes > 1024 ** 3 && m.freeBytes > 0 && m.freeBytes <= m.totalBytes);
});

test('Linux: comando df por diretório roda num sh real e mapeia/marca inexistentes', { skip: !findSh() && 'sem sh/bash disponível' }, () => {
    const { dfByDirCommand } = loadOsDisk();
    const sp = require(path.join(APP, 'src', 'storagePaths.js'));
    const existing = process.platform === 'win32' ? '/usr/bin/' : '/usr/';
    const missing = '/caminho/que/nao/existe/';
    const r = spawnSync(findSh(), ['-c', dfByDirCommand([existing, missing])], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const parsed = sp.parseDfByDir(r.stdout);
    assert.ok(parsed.dirMount[sp.dirKey(existing)], `sem ponto de montagem para ${existing}:\n${r.stdout}`);
    assert.deepEqual(parsed.missing, [missing]);
    assert.ok(parsed.mounts[0].totalBytes > 0);
});

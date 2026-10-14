'use strict';
// Verificação/atualização pelo GitHub. Testa as partes puras + o caminho DEMO
// (sem rede). O download/execução real do instalador não é exercitado aqui.
process.env.DEMO_MODE = 'true';
process.env.UPDATE_REPO = 'Silas-Silva-dev/Oracle-Pulse';

const test = require('node:test');
const assert = require('node:assert/strict');
const up = require('../src/updater');

test('compareVersions: numérico, com "v", tamanhos diferentes', () => {
    assert.equal(up.compareVersions('2.2.8', '2.2.7'), 1);
    assert.equal(up.compareVersions('2.2.7', '2.2.8'), -1);
    assert.equal(up.compareVersions('2.3.0', '2.2.9'), 1);
    assert.equal(up.compareVersions('v2.2.7', '2.2.7'), 0);
    assert.equal(up.compareVersions('2.2', '2.2.0'), 0);
    assert.equal(up.compareVersions('2.10.0', '2.9.0'), 1, 'compara número, não texto');
});

test('pickAsset: prefere o Setup .exe; cai para qualquer .exe; null sem exe', () => {
    const a = up.pickAsset([
        { name: 'checksums.txt', browser_download_url: 'x' },
        { name: 'OraclePulse-Setup-2.3.0.exe', browser_download_url: 's' },
        { name: 'outro.exe', browser_download_url: 'o' },
    ]);
    assert.equal(a.name, 'OraclePulse-Setup-2.3.0.exe');
    assert.equal(up.pickAsset([{ name: 'ferramenta.exe', browser_download_url: 'o' }]).name, 'ferramenta.exe');
    assert.equal(up.pickAsset([{ name: 'notas.txt' }]), null);
    assert.equal(up.pickAsset([]), null);
});

test('extractSha256: acha o hash nas notas (qualquer caixa), senão null', () => {
    assert.equal(up.extractSha256('Build 2.3.0\nSHA-256: ' + 'A'.repeat(64) + '\nfim'), 'a'.repeat(64));
    assert.equal(up.extractSha256('sha256 ' + 'b'.repeat(64)), 'b'.repeat(64));
    assert.equal(up.extractSha256('sem hash aqui'), null);
    assert.equal(up.extractSha256('hex curto: ' + 'c'.repeat(10)), null);
});

test('about(): versão e flags; o repositório NÃO é exposto; isInstalledService falso fora da instalação', () => {
    const a = up.about();
    assert.equal(a.name, 'Oracle Pulse');
    assert.match(a.version, /^\d+\.\d+\.\d+/);
    assert.equal(a.repo, undefined, 'repo oculto');
    assert.equal(a.repoUrl, undefined, 'repoUrl oculto');
    assert.equal(a.demo, true);
    assert.equal(typeof a.installedService, 'boolean');
    assert.equal(up.isInstalledService(), false, 'sem unins000.exe no repo');
});

test('checkLatest (DEMO): simula versão nova; a saída pública não revela o repositório', async () => {
    const d = await up.checkLatest();
    assert.equal(d.demo, true);
    assert.equal(d.newer, true);
    assert.equal(up.compareVersions(d.latest, d.current), 1);
    assert.ok(d.asset && /\.exe$/.test(d.asset.name));

    // A versão enviada à interface/API não traz URL nem nome do repositório.
    const pub = up.checkLatestPublic(d);
    assert.equal(pub.url, undefined);
    assert.equal(pub.sha256, undefined);
    assert.equal(pub.asset.url, undefined);
    assert.ok(!JSON.stringify(pub).includes('github.com'), 'sem referência ao GitHub na saída pública');
    assert.equal(pub.latest, d.latest);
    assert.equal(pub.asset.name, d.asset.name);
});

test('startUpdate (DEMO): exige senha e devolve simulação (não executa nada)', async () => {
    await assert.rejects(up.startUpdate({}), /senha de instalação/i);
    const r = await up.startUpdate({ installPassword: 'SENHA-DEMO' });
    assert.equal(r.demo, true);
    assert.equal(r.started, false);
    assert.match(r.message, /Simula/i);
});

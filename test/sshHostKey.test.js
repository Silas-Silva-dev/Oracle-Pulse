/**
 * Verificação da chave do servidor SSH (anti man-in-the-middle): fingerprint no
 * formato do OpenSSH, pinning por SSH_HOST_FINGERPRINT e TOFU em arquivo.
 * Vetores: chaves ed25519 descartáveis, fingerprints conferidos com `ssh-keygen -lf`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const osDisk = require('../src/osDisk');

const K1 = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIPU9/ZaLPIM3wHk4WB99N4SsHHPPtqgaZ1oHnWc9u1Yb', 'base64');
const K1_FP = 'SHA256:hAG/6i3rTA0/ORR2uSPo9Dw3xy/Pd9qaOKYt6qYzn8I';
const K2 = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIERBDTDmAbmVp38pbQ1R8ly7IgjSLVlREWJNFDVmtoOu', 'base64');
const K2_FP = 'SHA256:KYDRteKGRRKtxHsmLzm56ApZz9J/LOKw/COPamGbxwQ';

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-known-hosts-'));
    return path.join(dir, 'ssh-known-hosts.json');
}

test('sshFingerprint: igual ao ssh-keygen -lf (SHA256 em base64 sem "=")', () => {
    assert.equal(osDisk.sshFingerprint(K1), K1_FP);
    assert.equal(osDisk.sshFingerprint(K2), K2_FP);
    assert.equal(osDisk.sshKeyType(K1), 'ssh-ed25519');
});

test('pinnedFingerprints: aceita com ou sem prefixo SHA256: e vários separados por vírgula', () => {
    assert.deepEqual(osDisk.pinnedFingerprints(`${K1_FP}, ${K2_FP.slice(7)}=`), [K1_FP, K2_FP]);
    assert.deepEqual(osDisk.pinnedFingerprints(''), []);
});

test('pinning: aceita só a chave configurada (chave diferente = recusada)', () => {
    const file = tmpFile();
    assert.equal(osDisk.checkHostKey(K1, { host: 'db', port: 22, pinned: [K1_FP], file }).ok, true);
    const bad = osDisk.checkHostKey(K2, { host: 'db', port: 22, pinned: [K1_FP], file });
    assert.equal(bad.ok, false);
    assert.equal(bad.fingerprint, K2_FP);
    assert.deepEqual(bad.expected, [K1_FP]);
    assert.equal(fs.existsSync(file), false, 'com pinning não grava TOFU');
});

test('TOFU: registra no 1º uso, aceita a mesma chave e RECUSA chave trocada', () => {
    const file = tmpFile();
    const first = osDisk.checkHostKey(K1, { host: 'db', port: 22, pinned: [], file });
    assert.equal(first.ok, true);
    assert.equal(first.firstUse, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['db:22'].fingerprint, K1_FP);

    const again = osDisk.checkHostKey(K1, { host: 'db', port: 22, pinned: [], file });
    assert.equal(again.ok, true);
    assert.equal(again.firstUse, undefined);

    const mitm = osDisk.checkHostKey(K2, { host: 'db', port: 22, pinned: [], file });
    assert.equal(mitm.ok, false, 'chave diferente da registrada deve ser recusada');
    assert.deepEqual(mitm.expected, [K1_FP]);
    // A recusa não sobrescreve o registro.
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['db:22'].fingerprint, K1_FP);

    // Outro host/porta tem registro próprio.
    assert.equal(osDisk.checkHostKey(K2, { host: 'db', port: 2222, pinned: [], file }).firstUse, true);
});

test('mensagem de erro de chave recusada é acionável e não confunde com senha errada', () => {
    const err = new Error('Host denied (verification failed)');
    err.diag = { hostKey: { ok: false, fingerprint: K2_FP, keyType: 'ssh-ed25519', expected: [K1_FP], source: 'x' } };
    const msg = osDisk.mapSshError(err);
    assert.match(msg, /não confere/);
    assert.match(msg, /man-in-the-middle/);
    assert.doesNotMatch(msg, /Verifique usuário\/senha/);
});

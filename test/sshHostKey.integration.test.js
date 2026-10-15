/**
 * Integração: um servidor SSH local (ssh2.Server em 127.0.0.1) prova que
 *  - com a chave do servidor DIFERENTE da fixada, a conexão é recusada ANTES de
 *    qualquer tentativa de autenticação (a senha nunca sai do painel);
 *  - com a chave certa, autentica e executa normalmente.
 */
const test = require('node:test');
const assert = require('node:assert');
const { Server, utils } = require('ssh2');

const { config } = require('../src/config');
const osDisk = require('../src/osDisk');

const K1_FP = 'SHA256:hAG/6i3rTA0/ORR2uSPo9Dw3xy/Pd9qaOKYt6qYzn8I'; // chave que NÃO é a do servidor

test('chave trocada: recusa sem enviar senha; chave certa: conecta e executa', async (t) => {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const realFp = osDisk.sshFingerprint(utils.parseKey(hostKey.public).getPublicSSH());
    const authAttempts = [];

    const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
        client.on('authentication', (ctx) => {
            authAttempts.push(ctx.method);
            if (ctx.method === 'password' && ctx.username === 'audit' && ctx.password === 'Synthetic-Pass-1') return ctx.accept();
            return ctx.reject(['password']);
        });
        client.on('ready', () => {
            client.on('session', (accept) => {
                accept().on('exec', (acceptExec) => {
                    const stream = acceptExec();
                    stream.write('hi\n');
                    stream.exit(0);
                    stream.end();
                });
            });
        });
        client.on('error', () => { /* cliente desconectou */ });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));

    const saved = { ...config.ssh };
    t.after(() => {
        Object.assign(config.ssh, saved);
        osDisk.closeSsh();
        server.close();
    });
    Object.assign(config.ssh, {
        host: '127.0.0.1', port: server.address().port, user: 'audit',
        password: 'Synthetic-Pass-1', privateKeyPath: null,
    });

    // 1) fingerprint fixado é de OUTRA chave: man-in-the-middle simulado.
    config.ssh.hostFingerprint = K1_FP;
    const denied = await osDisk.execOnServer('echo hi', { stdin: '' }); // conexão própria (sem cache)
    assert.equal(denied.code, -1);
    assert.match(denied.stderr, /não confere/);
    assert.deepEqual(authAttempts, [], 'nenhuma autenticação (senha) pode chegar ao servidor não verificado');

    // 2) fingerprint correto: autentica e executa.
    config.ssh.hostFingerprint = realFp;
    const ok = await osDisk.execOnServer('echo hi', { stdin: '' });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'hi');
    assert.ok(authAttempts.includes('password'));
});

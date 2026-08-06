#!/usr/bin/env node
/**
 * Gera um hash de senha salgado (scrypt) para usar em AUTH_PASS_HASH /
 * AUTH_VIEWER_PASS_HASH no .env.
 *
 * Uso:  node bin/hash-password.js "minhaSenha"
 */
const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
    console.error('Uso: node bin/hash-password.js "<senha>"');
    process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 32).toString('hex');
const value = `scrypt$${salt.toString('hex')}$${hash}`;

console.log('\nAdicione ao seu .env:\n');
console.log(`AUTH_PASS_HASH=${value}\n`);

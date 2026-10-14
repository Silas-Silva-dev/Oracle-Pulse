'use strict';
// Conexão sqlplus/RMAN: o alias TNS vale SÓ no Windows; no Linux a conexão é local,
// rodando como o dono do Oracle. (Cliente Linux dava ORA-12154 por usar o @alias.)
process.env.DEMO_MODE = 'false';
process.env.DB_ORACLE_HOME = '/u01/app/oracle/product/19.0.0/dbhome_1';
process.env.DB_ORACLE_SID = 'orcl';
process.env.DB_SYS_PASSWORD = 'Sys#Senha1';
process.env.DB_TNS_ALIAS = 'master';   // definido (necessário no Windows do cliente)
process.env.DB_OS_USER = 'oracle';
process.env.SSH_HOST = 'db.exemplo.local';
process.env.SSH_USER = 'root';
process.env.SSH_PASSWORD = 'segredo';

const test = require('node:test');
const assert = require('node:assert/strict');
const ba = require('../src/backupAdmin');

test('sqlplus: @alias só no Windows; no Linux conecta local (sem ORA-12154)', () => {
    assert.match(ba.sqlplusInvocation('windows').connectLine, /@master AS SYSDBA$/);
    const linux = ba.sqlplusInvocation('linux').connectLine;
    assert.doesNotMatch(linux, /@/, 'Linux: sem alias');
    assert.match(linux, /CONNECT sys\/Sys#Senha1 AS SYSDBA$/);
    // serverOs ausente = trata como não-Windows (local): seguro por padrão.
    assert.doesNotMatch(ba.sqlplusInvocation().connectLine, /@/);
});

test('RMAN: @alias só no Windows; no Linux conecta local', () => {
    assert.match(ba.rmanInvocation('windows').connectLine, /CONNECT TARGET sys\/Sys#Senha1@master;$/);
    assert.match(ba.rmanInvocation('linux').connectLine, /CONNECT TARGET sys\/Sys#Senha1;$/);
    // o que de fato vai pela entrada padrão do rman
    assert.doesNotMatch(ba.buildRmanRun(['LIST BACKUP SUMMARY;'], 'linux').stdin, /@master/);
    assert.match(ba.buildRmanRun(['LIST BACKUP SUMMARY;'], 'windows').stdin, /@master/);
});

test('Linux: o comando roda como o dono do Oracle (su - oracle), não como o usuário do SSH (root)', () => {
    const { command } = ba.buildServerCommand('sqlplus', '-S /nolog', 'linux');
    assert.match(command, /^su - oracle -c '/);
    assert.match(command, /export ORACLE_SID=orcl/);
});

test('troca de archivelog e backups herdam a regra (Linux sem alias)', () => {
    assert.doesNotMatch(ba.buildArchivelogRun(true, 'linux').stdin, /@master/);
    assert.match(ba.buildArchivelogRun(true, 'windows').stdin, /@master/);
});

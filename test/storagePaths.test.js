/**
 * Regras de datafiles em vários diretórios/volumes (Linux, Windows, ASM).
 * Rodar:  npm test        (Node 21+; o painel em si roda em Node 16+)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const APP = process.env.OP_APP_DIR ? path.resolve(process.env.OP_APP_DIR) : path.resolve(__dirname, '..');
const sp = require(path.join(APP, 'src', 'storagePaths.js'));

// Cenário do cliente: DADOS cresceu de /u01 para /u02 e hoje está em /u03.
function linuxRows() {
    const rows = [];
    let id = 0;
    const add = (ts, file, change, size = 32767) => rows.push({ TABLESPACE_NAME: ts, FILE_NAME: file, FILE_ID: ++id, SIZE_MB: size, CREATION_CHANGE: change });
    add('SYSTEM', '/u01/oracle/oradata/ORCL/system01.dbf', 9);
    add('SYSAUX', '/u01/oracle/oradata/ORCL/sysaux01.dbf', 10);
    for (let i = 1; i <= 63; i++) {
        const dir = i <= 40 ? '/u01/oracle/oradata/ORCL/' : i <= 55 ? '/u02/oracle/oradata/ORCL/' : '/u03/oracle/oradata/ORCL/';
        add('DADOS', `${dir}dados${String(i).padStart(2, '0')}.dbf`, 1000 + i * 10);
    }
    return rows;
}

function windowsRows() {
    return [
        { TABLESPACE_NAME: 'SYSTEM', FILE_NAME: 'D:\\ORACLE\\ORADATA\\ORCL\\SYSTEM01.DBF', FILE_ID: 1, SIZE_MB: 1024, CREATION_CHANGE: 9 },
        { TABLESPACE_NAME: 'DADOS', FILE_NAME: 'D:\\ORACLE\\ORADATA\\ORCL\\DADOS01.DBF', FILE_ID: 2, SIZE_MB: 32767, CREATION_CHANGE: 100 },
        { TABLESPACE_NAME: 'DADOS', FILE_NAME: 'E:\\ORADATA\\ORCL\\DADOS02.DBF', FILE_ID: 3, SIZE_MB: 32767, CREATION_CHANGE: 200 },
        { TABLESPACE_NAME: 'DADOS', FILE_NAME: 'F:\\ORADATA\\ORCL\\DADOS03.DBF', FILE_ID: 4, SIZE_MB: 32767, CREATION_CHANGE: 300 },
        { TABLESPACE_NAME: 'DADOS', FILE_NAME: 'F:\\ORADATA\\ORCL\\DISCO2\\DADOS04.DBF', FILE_ID: 5, SIZE_MB: 32767, CREATION_CHANGE: 400 },
    ];
}

test('estilo do caminho e SO do servidor', () => {
    assert.equal(sp.pathStyle('/u03/oracle/oradata/ORCL/dados63.dbf'), 'posix');
    assert.equal(sp.pathStyle('D:\\ORACLE\\ORADATA\\DADOS01.DBF'), 'windows');
    assert.equal(sp.pathStyle('d:/oracle/dados.dbf'), 'windows');
    assert.equal(sp.pathStyle('+DATA/ORCL/DATAFILE/dados.123.456'), 'asm');
    assert.equal(sp.pathStyle('\\\\srv\\share\\x.dbf'), 'unc');
    assert.equal(sp.osFromPath('/u01/x.dbf'), 'linux');
    assert.equal(sp.osFromPath('E:\\x.dbf'), 'windows');
    assert.equal(sp.osFromPath('+DATA/x'), null, 'ASM não revela o SO');
});

test('diretório, nome e normalização', () => {
    assert.equal(sp.dirOf('/u03/oracle/oradata/ORCL/dados63.dbf'), '/u03/oracle/oradata/ORCL/');
    assert.equal(sp.dirOf('E:\\ORADATA\\DADOS02.DBF'), 'E:\\ORADATA\\');
    assert.equal(sp.baseName('E:\\ORADATA\\DADOS02.DBF'), 'DADOS02.DBF');
    assert.equal(sp.normalizeDir('/u04//oradata/ORCL'), '/u04/oradata/ORCL/');
    assert.equal(sp.normalizeDir('e:/oradata/orcl'), 'e:\\oradata\\orcl\\');
    assert.equal(sp.dirKey('e:\\oradata\\orcl'), sp.dirKey('E:\\ORADATA\\ORCL\\'), 'Windows não diferencia maiúsculas');
    assert.notEqual(sp.dirKey('/u01/Oradata/'), sp.dirKey('/u01/oradata/'), 'Linux diferencia maiúsculas');
});

test('Linux: diretório ATUAL do tablespace é o do datafile mais recente (/u03), não o primeiro (/u01)', () => {
    const layout = sp.buildStorageLayout(linuxRows(), [{ TABLESPACE_NAME: 'TEMP', FILE_NAME: '/u01/oracle/oradata/ORCL/temp01.dbf', SIZE_MB: 8192 }]);
    const dados = layout.tablespaces.find((t) => t.name === 'DADOS');
    assert.equal(dados.currentDir, '/u03/oracle/oradata/ORCL/');
    assert.equal(dados.latestFile, '/u03/oracle/oradata/ORCL/dados63.dbf');
    assert.equal(dados.suggestedName, 'dados64.dbf');
    assert.equal(dados.files, 63);
    assert.deepEqual(dados.dirs, ['/u01/oracle/oradata/ORCL/', '/u02/oracle/oradata/ORCL/', '/u03/oracle/oradata/ORCL/']);
    assert.equal(layout.serverStyle, 'posix');
    assert.equal(layout.currentDir, '/u03/oracle/oradata/ORCL/');
    const u01 = layout.dirs.find((d) => d.dir === '/u01/oracle/oradata/ORCL/');
    assert.deepEqual(u01.kinds, ['data', 'temp']);
    assert.equal(JSON.stringify(layout).includes('fileKeys'), false, 'conjunto interno fora do JSON');
});

test('sem v$datafile (CREATION_CHANGE ausente) usa o FILE_ID como ordem de criação', () => {
    const rows = linuxRows().map(({ CREATION_CHANGE, ...r }) => r);
    const layout = sp.buildStorageLayout(rows, []);
    assert.equal(layout.tablespaces.find((t) => t.name === 'DADOS').currentDir, '/u03/oracle/oradata/ORCL/');
});

test('sugestão de nome segue a sequência e evita nomes existentes', () => {
    const keys = new Set([sp.fileKey('/u03/x/dados64.dbf')]);
    assert.equal(sp.suggestNextFileName('/u03/x/dados63.dbf', 'DADOS', '/u03/x/', null), 'dados64.dbf');
    assert.equal(sp.suggestNextFileName('/u03/x/dados63.dbf', 'DADOS', '/u03/x/', keys), 'dados65.dbf');
    assert.equal(sp.suggestNextFileName('E:\\D\\DADOS_09.DBF', 'DADOS', 'E:\\D\\', null), 'DADOS_10.DBF');
    assert.equal(sp.suggestNextFileName('E:\\D\\DADOS099.DBF', 'DADOS', 'E:\\D\\', null), 'DADOS100.DBF');
    assert.equal(sp.suggestNextFileName('/u01/users.dbf', 'USERS', '/u01/', null), 'users02.dbf');
    assert.equal(sp.suggestNextFileName('/u01/o1_mf_dados_kx9z8q_.dbf', 'DADOS', '/u01/', null), 'dados02.dbf');
    const winKeys = new Set([sp.fileKey('F:\\ORADATA\\DADOS05.DBF')]);
    assert.equal(sp.suggestNextFileName('F:\\ORADATA\\dados04.dbf', 'DADOS', 'f:\\oradata\\', winKeys), 'dados06.dbf', 'Windows compara sem maiúsculas');
});

test('validação do nome do arquivo e do "Outro diretório"', () => {
    assert.equal(sp.validateFileName('dados64.dbf'), 'dados64.dbf');
    assert.equal(sp.validateFileName('DADOS64.DBF'), 'DADOS64.DBF');
    for (const bad of ['', '../x.dbf', 'a/b.dbf', 'x.txt', "x'.dbf", 'x;.dbf', 'a b.dbf']) {
        assert.throws(() => sp.validateFileName(bad), sp.PathValidationError, bad);
    }
    assert.equal(sp.validateCustomDir('/u04/oradata/ORCL', 'posix'), '/u04/oradata/ORCL/');
    assert.equal(sp.validateCustomDir('g:/oradata/orcl', 'windows'), 'g:\\oradata\\orcl\\');
    assert.equal(sp.validateCustomDir('+data2', 'posix'), '+DATA2/');
    for (const [dir, style] of [
        ['u04/oradata', 'posix'], ['/u04/../etc', 'posix'], ["/u04/x'; drop", 'posix'], ['E:\\ORADATA', 'posix'],
        ['/u04/oradata', 'windows'], ['\\\\srv\\share', 'windows'], ['E:\\ORA|DATA', 'windows'], ['+DATA/ORCL/DATAFILE', 'posix'],
    ]) {
        assert.throws(() => sp.validateCustomDir(dir, style), sp.PathValidationError, `${dir} (${style})`);
    }
});

test('df por diretório: ponto de montagem exato e diretórios inexistentes', () => {
    const out = [
        '@@OPDF@@/u01/oracle/oradata/ORCL/',
        '/dev/mapper/vg-u01  229638144 171966468  57671676      75% /u01',
        '@@OPDF@@/u02/oracle/oradata/ORCL/',
        '/dev/sdc1  524288000 484474880  39813120      93% /u02',
        '@@OPDF@@/u03/oracle/oradata/ORCL/',
        '/dev/sdd1  1048576000 608174080  440401920      59% /u03',
        '@@OPDF@@/u04/naoexiste/',
        '@@OPDF@@/u01data/x/',
        '/dev/sde1  1000 500  500  50% /u01data',
    ].join('\n');
    const r = sp.parseDfByDir(out);
    assert.equal(r.dirMount[sp.dirKey('/u01/oracle/oradata/ORCL/')], '/u01');
    assert.equal(r.dirMount[sp.dirKey('/u03/oracle/oradata/ORCL/')], '/u03');
    assert.equal(r.dirMount[sp.dirKey('/u01data/x/')], '/u01data');
    assert.deepEqual(r.missing, ['/u04/naoexiste/']);
    assert.equal(r.mounts.length, 4);
    // Cabeçalho localizado, ponto de montagem e sistema de arquivos com espaço
    const local = sp.parseDfLines([
        'Sist. Arq.  1K-blocos  Usado Disponível Uso% Montado em',
        '/dev/sdb1 100 40 60 40% /mnt/meu disco',
        '//nas/oracle backup  2000 500 1500 25% /mnt/nas backup',
    ].join('\n'));
    assert.deepEqual(local.map((m) => m.mount), ['/mnt/meu disco', '/mnt/nas backup']);
    assert.equal(local[1].filesystem, '//nas/oracle backup');
    assert.equal(local[1].freeBytes, 1500 * 1024);
});

test('Windows: Win32_Volume com letras e pasta montada; associação pelo prefixo mais longo', () => {
    const json = JSON.stringify([
        { Name: 'C:\\', Capacity: 256e9, FreeSpace: 100e9 },
        { Name: 'D:\\', Capacity: 500e9, FreeSpace: 50e9 },
        { Name: 'F:\\', Capacity: 1000e9, FreeSpace: 600e9 },
        { Name: 'F:\\ORADATA\\ORCL\\DISCO2\\', Capacity: 2000e9, FreeSpace: 1500e9 },
        { Name: '\\\\?\\Volume{abc}\\', Capacity: 100, FreeSpace: 50 },
        { Name: 'Z:\\', Capacity: null, FreeSpace: null },
    ]);
    const vols = sp.parseWinVolumes(json);
    assert.deepEqual(vols.map((v) => v.mount), ['C:\\', 'D:\\', 'F:\\', 'F:\\ORADATA\\ORCL\\DISCO2\\']);
    assert.equal(sp.findMount('f:\\oradata\\orcl\\disco2\\', vols).mount, 'F:\\ORADATA\\ORCL\\DISCO2\\');
    assert.equal(sp.findMount('F:\\ORADATA\\ORCL\\', vols).mount, 'F:\\');
    assert.equal(sp.findMount('E:\\ORADATA\\', vols), null);
    assert.equal(sp.parseWinVolumes(JSON.stringify({ Name: 'D:\\', Capacity: 10, FreeSpace: 5 })).length, 1, 'objeto único (1 volume)');
    assert.deepEqual(sp.parseWinVolumes('lixo'), []);
});

function linuxUsage() {
    const G = 1024 ** 3;
    return {
        mounts: [
            { mount: '/u01', totalBytes: 219 * G, freeBytes: 55 * G },
            { mount: '/u02', totalBytes: 500 * G, freeBytes: 38 * G },
            { mount: '/u03', totalBytes: 1000 * G, freeBytes: 420 * G },
        ],
        dirMount: { '/u01/oracle/oradata/ORCL/': '/u01', '/u02/oracle/oradata/ORCL/': '/u02', '/u03/oracle/oradata/ORCL/': '/u03' },
        missing: [],
        errors: [],
    };
}

test('resumo de volumes: um por montagem, com tablespaces e destino atual', () => {
    const layout = sp.buildStorageLayout(linuxRows(), []);
    const { volumes, warnings } = sp.summarizeVolumes(layout, linuxUsage());
    assert.deepEqual(volumes.map((v) => v.mount), ['/u01', '/u02', '/u03']);
    assert.deepEqual(volumes.find((v) => v.mount === '/u03').currentFor, ['DADOS']);
    assert.deepEqual(volumes.find((v) => v.mount === '/u01').currentFor, ['SYSAUX', 'SYSTEM']);
    assert.equal(volumes.find((v) => v.mount === '/u01').usedPct, 75);
    assert.equal(volumes.find((v) => v.mount === '/u02').freeMb, 38 * 1024);
    assert.deepEqual(warnings, []);
    const withMissing = sp.summarizeVolumes(layout, { ...linuxUsage(), missing: ['/u09/x/'], errors: ['df falhou'] });
    assert.deepEqual(withMissing.warnings, ['df falhou', 'Diretório não encontrado no servidor: /u09/x/']);
});

test('Adicionar datafile (Linux): padrão vai para /u03 com o próximo nome', () => {
    const layout = sp.buildStorageLayout(linuxRows(), []);
    const { volumes } = sp.summarizeVolumes(layout, linuxUsage());
    const plan = sp.planAddDatafile({ tablespace: 'DADOS', sizeMb: 5000 }, { layout, volumes });
    assert.equal(plan.fullPath, '/u03/oracle/oradata/ORCL/dados64.dbf');
    assert.equal(plan.sql, `ALTER TABLESPACE "DADOS" ADD DATAFILE '/u03/oracle/oradata/ORCL/dados64.dbf' SIZE 5000M AUTOEXTEND ON NEXT 100M MAXSIZE UNLIMITED`);
    assert.equal(plan.custom, false);
    assert.equal(plan.volume.mount, '/u03');

    // Escolha explícita de outro diretório conhecido
    const p2 = sp.planAddDatafile({ tablespace: 'DADOS', directory: '/u02/oracle/oradata/ORCL', fileName: 'dados64.dbf', sizeMb: 1000 }, { layout, volumes });
    assert.equal(p2.fullPath, '/u02/oracle/oradata/ORCL/dados64.dbf');
    // Formato antigo da API (caminho completo em fileName)
    const p3 = sp.planAddDatafile({ tablespace: 'DADOS', fileName: '/u03/oracle/oradata/ORCL/dados70.dbf', sizeMb: 1000 }, { layout, volumes });
    assert.equal(p3.fullPath, '/u03/oracle/oradata/ORCL/dados70.dbf');
    // Diretório novo (disco /u04 recém-montado)
    const p4 = sp.planAddDatafile({ tablespace: 'DADOS', directory: '/u04/oradata/ORCL', fileName: 'dados64.dbf', sizeMb: 1000 }, { layout, volumes });
    assert.equal(p4.custom, true);
    assert.equal(p4.fullPath, '/u04/oradata/ORCL/dados64.dbf');

    assert.throws(() => sp.planAddDatafile({ tablespace: 'DADOS', fileName: 'dados63.dbf', sizeMb: 10 }, { layout, volumes }), /Já existe/);
    assert.throws(() => sp.planAddDatafile({ tablespace: 'DADOS', directory: '/u02/oracle/oradata/ORCL/', fileName: 'x.dbf', sizeMb: 40000 }, { layout, volumes }), /Espaço insuficiente no volume \/u02/);
    assert.throws(() => sp.planAddDatafile({ tablespace: 'DADOS', directory: 'E:\\ORADATA', fileName: 'x.dbf', sizeMb: 10 }, { layout, volumes }), /Linux/);
    assert.throws(() => sp.planAddDatafile({ tablespace: 'NAOEXISTE', sizeMb: 10 }, { layout, volumes }), sp.PathValidationError);
});

test('Adicionar datafile (Windows): diretório atual F:\\...\\DISCO2, maiúsculas ignoradas', () => {
    const layout = sp.buildStorageLayout(windowsRows(), []);
    assert.equal(layout.serverStyle, 'windows');
    const dados = layout.tablespaces.find((t) => t.name === 'DADOS');
    assert.equal(dados.currentDir, 'F:\\ORADATA\\ORCL\\DISCO2\\');
    assert.equal(dados.suggestedName, 'DADOS05.DBF');
    const G = 1024 ** 3;
    const usage = {
        mounts: [
            { mount: 'D:\\', totalBytes: 500 * G, freeBytes: 50 * G },
            { mount: 'E:\\', totalBytes: 500 * G, freeBytes: 5 * G },
            { mount: 'F:\\', totalBytes: 1000 * G, freeBytes: 600 * G },
            { mount: 'F:\\ORADATA\\ORCL\\DISCO2\\', totalBytes: 2000 * G, freeBytes: 1500 * G },
        ],
        dirMount: {
            'D:\\ORACLE\\ORADATA\\ORCL\\': 'D:\\', 'E:\\ORADATA\\ORCL\\': 'E:\\', 'F:\\ORADATA\\ORCL\\': 'F:\\',
            'F:\\ORADATA\\ORCL\\DISCO2\\': 'F:\\ORADATA\\ORCL\\DISCO2\\',
        },
        missing: [],
        errors: [],
    };
    const { volumes } = sp.summarizeVolumes(layout, usage);
    assert.deepEqual(volumes.find((v) => v.mount === 'F:\\ORADATA\\ORCL\\DISCO2\\').currentFor, ['DADOS']);

    const plan = sp.planAddDatafile({ tablespace: 'DADOS', sizeMb: 2000 }, { layout, volumes });
    assert.equal(plan.fullPath, 'F:\\ORADATA\\ORCL\\DISCO2\\DADOS05.DBF');
    const lower = sp.planAddDatafile({ tablespace: 'DADOS', directory: 'e:\\oradata\\orcl', fileName: 'DADOS05.DBF', sizeMb: 100 }, { layout, volumes });
    assert.equal(lower.custom, false, 'mesmo diretório escrito em minúsculas');
    assert.equal(lower.fullPath, 'E:\\ORADATA\\ORCL\\DADOS05.DBF', 'usa a grafia do banco');
    assert.throws(() => sp.planAddDatafile({ tablespace: 'DADOS', directory: 'E:\\ORADATA\\ORCL\\', fileName: 'x.dbf', sizeMb: 6000 }, { layout, volumes }), /Espaço insuficiente no volume E:/);
    assert.throws(() => sp.planAddDatafile({ tablespace: 'DADOS', directory: 'F:\\ORADATA\\ORCL\\DISCO2', fileName: 'dados04.dbf', sizeMb: 10 }, { layout, volumes }), /Já existe/);
    assert.throws(() => sp.planAddDatafile({ tablespace: 'DADOS', directory: '/u04/x', fileName: 'x.dbf', sizeMb: 10 }, { layout, volumes }), /Windows/);
});

test('ASM: destino é o disk group e o nome fica com o Oracle (OMF)', () => {
    const layout = sp.buildStorageLayout([
        { TABLESPACE_NAME: 'DADOS', FILE_NAME: '+DATA/ORCL/DATAFILE/dados.256.111', FILE_ID: 1, SIZE_MB: 100, CREATION_CHANGE: 1 },
        { TABLESPACE_NAME: 'DADOS', FILE_NAME: '+DATA2/ORCL/DATAFILE/dados.300.222', FILE_ID: 2, SIZE_MB: 100, CREATION_CHANGE: 2 },
    ], []);
    assert.equal(layout.serverStyle, 'asm');
    const dados = layout.tablespaces.find((t) => t.name === 'DADOS');
    assert.equal(dados.currentDir, '+DATA2/ORCL/DATAFILE/');
    assert.equal(dados.suggestedName, '');
    const plan = sp.planAddDatafile({ tablespace: 'DADOS', sizeMb: 100 }, { layout, volumes: [] });
    assert.equal(plan.fullPath, '+DATA2');
    assert.match(plan.sql, /ADD DATAFILE '\+DATA2' SIZE 100M/);
    const p2 = sp.planAddDatafile({ tablespace: 'DADOS', directory: '+data3', sizeMb: 100 }, { layout, volumes: [] });
    assert.equal(p2.custom, true);
    assert.equal(p2.fullPath, '+DATA3');
});

test('resize: crescimento precisa caber no volume do arquivo', () => {
    const layout = sp.buildStorageLayout(linuxRows(), []);
    const { volumes } = sp.summarizeVolumes(layout, linuxUsage());
    const f = '/u02/oracle/oradata/ORCL/dados50.dbf';
    assert.equal(sp.checkResizeSpace(f, 1000, 30000, volumes).mount, '/u02');
    assert.equal(sp.checkResizeSpace(f, 32767, 1000, volumes), null, 'reduzir não precisa de espaço');
    assert.throws(() => sp.checkResizeSpace(f, 1000, 1000 + 40 * 1024, volumes), /Espaço insuficiente no volume \/u02/);
});

/**
 * OSDISK.JS - Leitura de espaço em disco do servidor de banco.
 * Suporta:
 *  - Banco local (Windows via PowerShell Get-CimInstance; Linux via df -kP)
 *  - Banco remoto via SSH (senha ou chave privada), Windows ou Linux
 * Substitui o uso do 'wmic' (deprecado) por PowerShell.
 *
 * Autenticação SSH: o handler keyboard-interactive automático do node-ssh só
 * responde quando o prompt PAM contém a palavra "password". Em servidores Linux
 * com locale pt_BR o prompt vem como "Senha:" (ou vazio), o handler nunca
 * responde e o SSH falha com "All configured authentication methods failed"
 * mesmo com a senha correta. Por isso fornecemos nosso próprio handler.
 */
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { config } = require('./config');
const { runQuery } = require('./db');
const logger = require('./logger');

const GB = 1024 ** 3;
const KB_TO_GB = 1024 ** 2; // valores de df vêm em KB

/** Escapa um argumento para shell POSIX (sh). */
const shellEscape = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Parseia a saída de `df -kP` e escolhe o mount point mais específico. */
function parseDf(stdout, dbPath) {
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    let best = null;
    let maxLen = -1;
    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length >= 6) {
            const mount = parts[5];
            // Match por fronteira de segmento: '/u01' não deve casar com '/u01data',
            // e '/' (raiz) casa qualquer caminho.
            const isMatch =
                dbPath === mount ||
                mount === '/' ||
                dbPath.startsWith(mount.endsWith('/') ? mount : mount + '/');
            if (isMatch && mount.length > maxLen) {
                maxLen = mount.length;
                best = parts;
            }
        }
    }
    if (!best) return null;

    const totalKb = parseInt(best[1], 10);
    const freeKb = parseInt(best[3], 10);
    if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb)) return null;

    return {
        totalGB: Math.round(totalKb / KB_TO_GB),
        freeGB: Math.round(freeKb / KB_TO_GB),
        path: best[5] || dbPath,
    };
}

/**
 * Codifica um script PowerShell em -EncodedCommand (base64 UTF-16LE).
 * Torna o comando OPACO ao shell padrão do servidor: o OpenSSH no Windows pode
 * ter cmd.exe OU PowerShell como DefaultShell. Com -Command "...", aspas e $
 * dentro do script seriam reinterpretados pelo PowerShell (quebrando a leitura);
 * em base64 só há letras/dígitos/+/=, que nenhum dos dois shells corrompe.
 */
function psEncoded(script) {
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
}

/**
 * O PowerShell, ao FALHAR via -EncodedCommand, escreve os erros no stderr como
 * CLIXML ("#< CLIXML ... <S S="Error">...</S> ..."). Isto extrai o texto
 * legível (decodificando _x000D_/_x000A_ e entidades XML), para a mensagem de
 * erro mostrada ao usuário não ficar poluída.
 */
function cleanPsClixml(text) {
    const s = String(text || '');
    if (!s.includes('CLIXML')) return s;
    const out = [];
    const re = /<S\s+S="[^"]*">([\s\S]*?)<\/S>/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        out.push(m[1]
            .replace(/_x000D_/gi, '')
            .replace(/_x000A_/gi, '\n')
            .replace(/_x([0-9A-Fa-f]{4})_/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
    }
    const cleaned = out.join('').replace(/\n{3,}/g, '\n\n').trim();
    return cleaned || s.replace(/#<\s*CLIXML[\s\S]*$/i, '').trim();
}

/** Letra de drive (ex.: "D:") de um caminho Windows, ou null se for UNC/ASM. */
function driveLetter(dbPath) {
    const d = String(dbPath).substring(0, 2);
    return /^[A-Za-z]:$/.test(d) ? d : null;
}

/** Monta o comando PowerShell para ler um drive do Windows (saída JSON). */
function winDiskCommand(drive) {
    const id = drive.replace(/'/g, ''); // ex.: "D:"
    return psEncoded(
        "$ProgressPreference='SilentlyContinue';" +
        `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${id}'" | Select-Object FreeSpace,Size | ConvertTo-Json -Compress`,
    );
}

function parseWinJson(stdout) {
    try {
        const obj = JSON.parse(stdout.trim());
        const free = Number(obj.FreeSpace);
        const total = Number(obj.Size);
        if (!Number.isFinite(free) || !Number.isFinite(total) || total === 0) return null;
        return { freeGB: Math.round(free / GB), totalGB: Math.round(total / GB) };
    } catch {
        return null;
    }
}

// ==========================================================================
// Leitura de memória (RAM + swap) do servidor — Linux e Windows
// ==========================================================================

/** Comando PowerShell que retorna RAM física e uso de page file (swap) em JSON. */
function winMemCommand() {
    return psEncoded([
        "$ProgressPreference='SilentlyContinue'",
        '$o=Get-CimInstance Win32_OperatingSystem',
        '$p=@(Get-CimInstance Win32_PageFileUsage)',
        '$pa=([int](($p|Measure-Object AllocatedBaseSize -Sum).Sum))',
        '$pu=([int](($p|Measure-Object CurrentUsage -Sum).Sum))',
        '[pscustomobject]@{TotalKB=$o.TotalVisibleMemorySize;FreeKB=$o.FreePhysicalMemory;PageAllocMB=$pa;PageUsedMB=$pu}|ConvertTo-Json -Compress',
    ].join(';'));
}

/** Parseia /proc/meminfo (Linux). Retorna { totalMB, freeMB, usedMB, usedPct, swap }. */
function parseMeminfo(out) {
    const get = (k) => {
        const m = out.match(new RegExp('^' + k + ':\\s+(\\d+)\\s*kB', 'm'));
        return m ? parseInt(m[1], 10) : null;
    };
    const totalKb = get('MemTotal');
    // MemAvailable é o indicador correto de "livre" (existe no kernel >= 3.14).
    // Fallback para kernels antigos: MemFree + Buffers + Cached.
    let availKb = get('MemAvailable');
    if (availKb == null) {
        const free = get('MemFree') || 0;
        const buffers = get('Buffers') || 0;
        const cached = get('Cached') || 0;
        availKb = free + buffers + cached;
    }
    if (!Number.isFinite(totalKb) || totalKb <= 0) return null;

    const totalMB = Math.round(totalKb / 1024);
    const freeMB = Math.round(availKb / 1024);
    const usedMB = totalMB - freeMB;
    const usedPct = Math.round((usedMB / totalMB) * 100);

    let swap = null;
    const swapTotalKb = get('SwapTotal');
    const swapFreeKb = get('SwapFree');
    if (swapTotalKb != null && swapFreeKb != null) {
        const stMB = Math.round(swapTotalKb / 1024);
        const suMB = Math.round((swapTotalKb - swapFreeKb) / 1024);
        swap = { totalMB: stMB, usedMB: suMB, usedPct: stMB > 0 ? Math.round((suMB / stMB) * 100) : 0 };
    }
    return { totalMB, freeMB, usedMB, usedPct, swap };
}

/** Parseia a saída JSON do winMemCommand (Windows). */
function parseWinMem(stdout) {
    try {
        const o = JSON.parse(stdout.trim());
        const totalMB = Math.round(Number(o.TotalKB) / 1024);
        const freeMB = Math.round(Number(o.FreeKB) / 1024);
        if (!Number.isFinite(totalMB) || totalMB <= 0 || !Number.isFinite(freeMB)) return null;
        const usedMB = totalMB - freeMB;
        const usedPct = Math.round((usedMB / totalMB) * 100);

        let swap = null;
        const pageAlloc = Number(o.PageAllocMB);
        const pageUsed = Number(o.PageUsedMB);
        if (Number.isFinite(pageAlloc) && pageAlloc > 0) {
            swap = { totalMB: pageAlloc, usedMB: Number.isFinite(pageUsed) ? pageUsed : 0, usedPct: Math.round(((Number.isFinite(pageUsed) ? pageUsed : 0) / pageAlloc) * 100) };
        }
        return { totalMB, freeMB, usedMB, usedPct, swap };
    } catch {
        return null;
    }
}

/**
 * Abre a conexão SSH com autenticação robusta:
 *  - Funciona com o método SSH 'password' nativo E com keyboard-interactive (PAM)
 *  - Independe do idioma/texto do prompt ("Password:", "Senha:", vazio)
 *  - Salvaguarda anti-MFA: responde a senha apenas no PRIMEIRO campo oculto;
 *    demais prompts (ex.: 2º fator/OTP) recebem string vazia
 *  - Não habilita autenticação por senha vazia inadvertidamente
 */
async function connectSsh() {
    const { NodeSSH } = require('node-ssh');
    const ssh = new NodeSSH();
    const debug = String(process.env.SSH_DEBUG).toLowerCase() === 'true';

    // Coleta de diagnóstico: ajuda a descobrir a causa exata da falha de auth
    // (sem nunca registrar a senha).
    const diag = {
        username: config.ssh.user,
        method: null,            // 'key' | 'password' | 'none'
        passwordLen: 0,
        passwordEdgeWhitespace: false,
        methodsOffered: [],      // métodos de auth que o servidor anunciou
        kbPrompts: [],           // prompts do keyboard-interactive (texto + echo)
        kbInvoked: false,
    };

    const opts = {
        host: config.ssh.host,
        username: config.ssh.user,
        port: config.ssh.port,
        readyTimeout: 20000, // falha rápido em vez de pendurar
    };

    // Captura linhas de debug do ssh2 relevantes para autenticação (sempre,
    // baratas; logadas apenas em falha ou quando SSH_DEBUG=true).
    opts.debug = (msg) => {
        const m = String(msg);
        const offered = m.match(/Received USERAUTH_FAILURE \(([^)]+)\)/i);
        if (offered) diag.methodsOffered = offered[1].split(',').map((s) => s.trim());
        if (debug) logger.debug(`[ssh2] ${m}`);
    };

    const keyConfigured = !!config.ssh.privateKeyPath;
    const keyExists = keyConfigured && fs.existsSync(config.ssh.privateKeyPath);

    if (keyConfigured && !keyExists) {
        logger.warn(`Chave SSH não encontrada em ${config.ssh.privateKeyPath}; tentando autenticação por senha.`);
    }

    if (keyExists) {
        diag.method = 'key';
        opts.privateKeyPath = config.ssh.privateKeyPath;
        if (config.ssh.password) opts.passphrase = config.ssh.password; // chave protegida por passphrase
    } else {
        const password = (config.ssh.password || '').toString();
        diag.passwordLen = password.length;
        diag.passwordEdgeWhitespace = /^\s|\s$|\r|\n/.test(password);

        if (password.length > 0) {
            diag.method = 'password';
            opts.password = password; // 1) método SSH 'password' nativo
            opts.tryKeyboard = true;  // 2) habilita keyboard-interactive (PAM)

            // Handler PRÓPRIO: contorna o bug do node-ssh respondendo ao desafio
            // independentemente do texto/idioma do prompt.
            opts.onKeyboardInteractive = (name, instructions, lang, prompts, finish) => {
                diag.kbInvoked = true;
                diag.kbPrompts = prompts.map((p) => ({ prompt: p.prompt, echo: p.echo }));
                let passwordUsed = false;
                const responses = prompts.map((p) => {
                    if (p && p.echo === false && !passwordUsed) {
                        passwordUsed = true;
                        return password; // único campo oculto = senha PAM
                    }
                    return ''; // visíveis e 2º fator: vazio (não injeta a senha em OTP)
                });
                finish(responses); // SEMPRE chama finish (nunca pendura a auth)
            };
        } else {
            diag.method = 'none';
            // Sem chave válida e sem senha: nada para autenticar.
            opts.password = '';
        }
    }

    try {
        await ssh.connect(opts);
        return ssh;
    } catch (err) {
        err.diag = diag; // anexa o diagnóstico para getOsDisk registrar
        throw err;
    }
}

/**
 * Registra um diagnóstico claro e acionável da falha de SSH no log do servidor,
 * sem nunca expor a senha. Mostra usuário, método, métodos oferecidos pelo
 * servidor e os prompts recebidos — o suficiente para identificar a causa.
 */
function logSshDiagnostics(err) {
    const d = err.diag || {};
    logger.error('========== DIAGNÓSTICO SSH (leitura de disco) ==========');
    logger.error(`Erro: ${err.message}${err.level ? ` (level=${err.level})` : ''}`);
    logger.error(`Host: ${config.ssh.host}:${config.ssh.port}  |  Usuário: "${d.username}"`);
    logger.error(`Método tentado: ${d.method}`);

    if (d.method === 'password') {
        logger.error(`Senha: comprimento=${d.passwordLen}` +
            (d.passwordEdgeWhitespace ? '  ⚠️ contém espaço/quebra de linha nas bordas (verifique aspas no .env)' : ''));
        logger.error('⚠️ Confira se o comprimento acima bate com a senha real. O .env trunca a senha no caractere "#" ' +
            'e em espaços quando ela NÃO está entre aspas. Se a senha tem # ou espaço, use: SSH_PASSWORD="suaSenha#aqui".');
        if (d.kbInvoked) {
            logger.error('Servidor usou keyboard-interactive (PAM). Prompts recebidos: ' +
                JSON.stringify(d.kbPrompts));
            logger.error('→ Como o handler respondeu e ainda falhou, a SENHA ou o USUÁRIO estão incorretos, ' +
                'ou a conta está bloqueada/expirada.');
        } else {
            logger.error('Servidor NÃO solicitou keyboard-interactive.');
            if (d.methodsOffered.length) {
                logger.error(`Métodos de auth aceitos pelo servidor: ${d.methodsOffered.join(', ')}`);
                if (!d.methodsOffered.includes('password') && !d.methodsOffered.includes('keyboard-interactive')) {
                    logger.error('→ O servidor NÃO aceita senha. Configure SSH_PRIVATE_KEY_PATH no .env com uma chave privada.');
                } else {
                    logger.error('→ O servidor aceita senha, mas ela foi recusada: SENHA/USUÁRIO incorretos ou conta bloqueada.');
                }
            } else {
                logger.error('→ Provável: servidor só aceita chave pública (configure SSH_PRIVATE_KEY_PATH) ou senha/usuário incorretos.');
            }
        }
    } else if (d.method === 'key') {
        logger.error('→ Autenticação por chave falhou: confira o caminho da chave, a passphrase e se a chave pública está autorizada no servidor.');
    } else {
        logger.error('→ Nenhuma credencial utilizável: defina SSH_PASSWORD ou SSH_PRIVATE_KEY_PATH no .env.');
    }
    logger.error('Dica: rode com SSH_DEBUG=true no .env para ver o handshake completo do ssh2.');
    logger.error('=======================================================');
}

/** Traduz erros de SSH em mensagens acionáveis para o usuário. */
function mapSshError(err) {
    const raw = (err && err.message) || '';
    if (err?.level === 'client-authentication' || /authentication methods failed/i.test(raw)) {
        return 'Falha de autenticação SSH. Verifique usuário/senha e se o servidor permite login por senha ' +
            '(PasswordAuthentication / KbdInteractiveAuthentication). Se o servidor exige chave, configure ' +
            'SSH_PRIVATE_KEY_PATH no .env. Confirme também que a conta não está bloqueada ou expirada.';
    }
    if (/ECONNREFUSED|ETIMEDOUT|timed out|getaddrinfo|EHOSTUNREACH|ENOTFOUND/i.test(raw)) {
        return 'Servidor SSH inacessível: verifique host, porta e firewall.';
    }
    return 'Falha SSH: ' + raw;
}

/**
 * Retorna { path, totalGB, freeGB, usedPct } em caso de sucesso,
 * ou { error } com mensagem acionável em caso de falha.
 */
async function getOsDisk() {
    if (config.demoMode) {
        return { path: 'C:', totalGB: 500, freeGB: 120, usedPct: 76 };
    }

    const basePathRes = await runQuery('defaultDataPath');
    const dbPath = basePathRes[0]?.PATH || basePathRes[0]?.path || '';
    if (!dbPath) return { error: 'Não foi possível determinar o caminho dos datafiles.' };

    const isRemoteLinux = dbPath.startsWith('/');
    let totalGB = 0;
    let freeGB = 0;
    let finalPath = dbPath;

    if (config.ssh.host) {
        let ssh;
        try {
            ssh = await connectSsh();
            if (isRemoteLinux) {
                const result = await ssh.execCommand(`df -kP ${shellEscape(dbPath)}`);
                if (result.code !== 0 || !result.stdout.trim()) {
                    return { error: 'Comando df falhou no servidor: ' + (result.stderr || 'sem saída').trim() };
                }
                const parsed = parseDf(result.stdout, dbPath);
                if (!parsed) return { error: 'Não foi possível localizar o ponto de montagem para ' + dbPath };
                ({ totalGB, freeGB, path: finalPath } = parsed);
            } else {
                const drive = driveLetter(dbPath);
                if (!drive) {
                    return { error: `Caminho de datafile não suportado para leitura de disco: '${dbPath}'. ` +
                        `Apenas drives com letra (ex.: D:) são suportados; UNC (\\\\servidor\\share) e ASM (+DATA) não.` };
                }
                finalPath = drive;
                const result = await ssh.execCommand(winDiskCommand(drive));
                if (result.code !== 0 || !result.stdout.trim()) {
                    return { error: 'Leitura de disco remoto falhou: ' + (result.stderr || 'sem saída').trim() };
                }
                const parsed = parseWinJson(result.stdout);
                if (!parsed) return { error: 'Saída inesperada ao ler o disco remoto.' };
                ({ freeGB, totalGB } = parsed);
            }
        } catch (sshErr) {
            logSshDiagnostics(sshErr);
            return { error: mapSshError(sshErr) };
        } finally {
            if (ssh) ssh.dispose();
        }
    } else {
        const isWin = os.platform() === 'win32';
        if (isWin) {
            if (dbPath.startsWith('/')) {
                return { error: 'O Banco está no Linux, mas o painel roda no Windows. Configure o acesso SSH no .env para ler o disco remotamente.' };
            }
            const drive = driveLetter(dbPath);
            if (!drive) {
                return { error: `Caminho de datafile não suportado para leitura de disco: '${dbPath}'. ` +
                    `Apenas drives com letra (ex.: D:) são suportados; UNC (\\\\servidor\\share) e ASM (+DATA) não.` };
            }
            finalPath = drive;
            const output = execSync(winDiskCommand(drive), { encoding: 'utf8', windowsHide: true });
            const parsed = parseWinJson(output);
            if (!parsed) return { error: 'Não foi possível ler o disco local (' + drive + ').' };
            ({ freeGB, totalGB } = parsed);
        } else {
            const output = execSync(`df -kP ${shellEscape(dbPath)}`, { encoding: 'utf8', windowsHide: true });
            const parsed = parseDf(output, dbPath);
            if (!parsed) return { error: 'Não foi possível localizar o ponto de montagem para ' + dbPath };
            ({ totalGB, freeGB, path: finalPath } = parsed);
        }
    }

    const usedPct = totalGB > 0 ? Math.round(((totalGB - freeGB) / totalGB) * 100) : 0;
    return { path: finalPath, totalGB, freeGB, usedPct };
}

/**
 * Lê a memória física (RAM) e o swap/page file do servidor de banco.
 * Funciona com banco local (Windows/Linux) e remoto via SSH (Windows/Linux).
 * Retorna { totalMB, freeMB, usedMB, usedPct, swap } ou { error }.
 */
async function getOsMemory() {
    if (config.demoMode) {
        return { totalMB: 16384, freeMB: 5200, usedMB: 11184, usedPct: 68, swap: { totalMB: 8192, usedMB: 410, usedPct: 5 } };
    }

    // Determina o SO do servidor da mesma forma que o disco: caminho dos datafiles.
    const basePathRes = await runQuery('defaultDataPath');
    const dbPath = basePathRes[0]?.PATH || basePathRes[0]?.path || '';
    const serverIsLinux = dbPath ? dbPath.startsWith('/') : os.platform() !== 'win32';

    if (config.ssh.host) {
        let ssh;
        try {
            ssh = await connectSsh();
            if (serverIsLinux) {
                const result = await ssh.execCommand('cat /proc/meminfo');
                if (result.code !== 0 || !result.stdout.trim()) {
                    return { error: 'Falha ao ler memória (/proc/meminfo): ' + (result.stderr || 'sem saída').trim() };
                }
                const parsed = parseMeminfo(result.stdout);
                return parsed || { error: 'Não foi possível interpretar /proc/meminfo.' };
            }
            const result = await ssh.execCommand(winMemCommand());
            if (result.code !== 0 || !result.stdout.trim()) {
                return { error: 'Leitura de memória remota falhou: ' + (result.stderr || 'sem saída').trim() };
            }
            const parsed = parseWinMem(result.stdout);
            return parsed || { error: 'Saída inesperada ao ler a memória remota.' };
        } catch (sshErr) {
            logSshDiagnostics(sshErr);
            return { error: mapSshError(sshErr) };
        } finally {
            if (ssh) ssh.dispose();
        }
    }

    // Banco local (mesma máquina do painel)
    if (os.platform() === 'win32') {
        if (dbPath.startsWith('/')) {
            return { error: 'O Banco está no Linux, mas o painel roda no Windows. Configure o acesso SSH no .env.' };
        }
        const output = execSync(winMemCommand(), { encoding: 'utf8', windowsHide: true });
        return parseWinMem(output) || { error: 'Não foi possível ler a memória local (Windows).' };
    }
    const output = execSync('cat /proc/meminfo', { encoding: 'utf8' });
    return parseMeminfo(output) || { error: 'Não foi possível ler /proc/meminfo local.' };
}

/**
 * Detecta o SO do servidor de banco: 'linux' ou 'windows'.
 * Usa o caminho dos datafiles (remoto) ou a plataforma local.
 */
async function detectServerOs() {
    try {
        const r = await runQuery('defaultDataPath');
        const p = r[0]?.PATH || r[0]?.path || '';
        if (p) return p.startsWith('/') ? 'linux' : 'windows';
    } catch { /* ignore */ }
    // Caminho dos datafiles indisponível (banco só montado, erro, etc.):
    // prova o SO do servidor remoto em vez de assumir Linux — senão um banco
    // WINDOWS receberia comandos Linux (export/su/$ORACLE_HOME) e falharia.
    if (config.ssh.host) {
        try {
            const probe = await execOnServer('cmd /c echo %OS%');
            if (/Windows_NT/i.test((probe.stdout || '') + (probe.stderr || ''))) return 'windows';
        } catch { /* ignore */ }
        return 'linux'; // último recurso: mantém o comportamento Linux já testado
    }
    return os.platform() === 'win32' ? 'windows' : 'linux';
}

/**
 * Executa um comando no servidor de banco (via SSH se configurado, senão local).
 * Retorna { code, stdout, stderr }. Não lança — erros viram code != 0.
 *
 * @param {string} command  comando de SO a executar
 * @param {object} [opts]
 * @param {string} [opts.stdin]  texto enviado à entrada padrão do processo
 *        (usado para passar o script RMAN/sqlplus — incluindo a linha CONNECT
 *        com a senha — SEM expor a senha na linha de comando/`ps`).
 */
async function execOnServer(command, opts = {}) {
    const stdin = opts.stdin;
    if (config.ssh.host) {
        // Em SSH as variáveis de ambiente são setadas no próprio comando (opts.env
        // não se aplica ao canal remoto).
        let ssh;
        try {
            ssh = await connectSsh();
            const execOpts = stdin != null ? { stdin } : {};
            const r = await ssh.execCommand(command, execOpts);
            return { code: r.code, stdout: cleanPsClixml(r.stdout || ''), stderr: cleanPsClixml(r.stderr || '') };
        } catch (err) {
            logSshDiagnostics(err);
            return { code: -1, stdout: '', stderr: mapSshError(err) };
        } finally {
            if (ssh) ssh.dispose();
        }
    }
    try {
        const execOpts = { encoding: 'utf8', windowsHide: true };
        if (stdin != null) execOpts.input = stdin;
        // Execução LOCAL: herda o ambiente do painel; opts.env acrescenta/ajusta
        // (ex.: ORACLE_HOME + PATH para achar rman/sqlplus no caso Windows local).
        if (opts.env) execOpts.env = { ...process.env, ...opts.env };
        const stdout = execSync(command, execOpts);
        return { code: 0, stdout: cleanPsClixml(stdout), stderr: '' };
    } catch (err) {
        return { code: err.status || 1, stdout: cleanPsClixml((err.stdout || '').toString()), stderr: cleanPsClixml((err.stderr || '').toString()) || err.message };
    }
}

module.exports = {
    getOsDisk, getOsMemory, detectServerOs, execOnServer, psEncoded, cleanPsClixml,
    // expostos para teste/diagnóstico (builders puros):
    winDiskCommand, winMemCommand, driveLetter,
};

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
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { config } = require('./config');
const { runQuery } = require('./db');
const logger = require('./logger');
const sp = require('./storagePaths');

/** Escapa um argumento para shell POSIX (sh). */
const shellEscape = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

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

/**
 * Comando PowerShell que lista os volumes do Windows (JSON Name/Capacity/
 * FreeSpace). Win32_Volume cobre letras de unidade (D:\) e também volumes
 * montados em pasta (D:\oradata\disco2\); se não houver acesso a ele, cai para
 * Win32_LogicalDisk (só letras).
 */
function winVolumesCommand() {
    return psEncoded([
        "$ProgressPreference='SilentlyContinue'",
        "$v=@(Get-CimInstance Win32_Volume -ErrorAction SilentlyContinue | Where-Object { $_.Name -and $_.Capacity } | Select-Object Name,Capacity,FreeSpace)",
        "if ($v.Count -eq 0) { $v=@(Get-CimInstance Win32_LogicalDisk | Where-Object { $_.Size } | Select-Object @{n='Name';e={$_.DeviceID+'\\'}},@{n='Capacity';e={$_.Size}},FreeSpace) }",
        'ConvertTo-Json -InputObject $v -Compress',
    ].join(';'));
}

/** Comando sh que roda `df -kP` em cada diretório, marcando o início de cada bloco. */
function dfByDirCommand(dirs) {
    const list = dirs.map(shellEscape).join(' ');
    return `for p in ${list}; do echo "@@OPDF@@$p"; LC_ALL=C df -kP "$p" 2>/dev/null | tail -n +2; done`;
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

// ==========================================================================
// Verificação da chave do servidor SSH (anti man-in-the-middle)
// Sem ela, quem se colocar no caminho da rede (ARP/DNS spoofing) se passa pelo
// servidor e recebe a senha do SSH e a senha do SYS (que vai pelo stdin).
// ==========================================================================

/** Fingerprint no formato do OpenSSH (ssh-keygen -lf): "SHA256:<base64 sem '='>". */
function sshFingerprint(keyBlob) {
    return 'SHA256:' + crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '');
}

/** Tipo da chave, lido do próprio blob (ex.: "ssh-ed25519"); '' se ilegível. */
function sshKeyType(keyBlob) {
    try {
        const len = keyBlob.readUInt32BE(0);
        return len > 0 && len < 64 ? keyBlob.toString('ascii', 4, 4 + len) : '';
    } catch {
        return '';
    }
}

/** SSH_HOST_FINGERPRINT (separados por vírgula/espaço), normalizados para "SHA256:...". */
function pinnedFingerprints(raw = config.ssh.hostFingerprint) {
    return String(raw || '').split(/[\s,;]+/).filter(Boolean)
        .map((f) => 'SHA256:' + f.replace(/^SHA256:/i, '').replace(/=+$/, ''));
}

const KNOWN_HOSTS_FILE = () => path.join(config.paths.logs, 'ssh-known-hosts.json');

function readKnownHosts(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

/**
 * A chave apresentada pelo servidor é confiável?
 *  - com SSH_HOST_FINGERPRINT: só os fingerprints configurados (pinning);
 *  - sem ele, TOFU: a chave da 1ª conexão é registrada (logs/ssh-known-hosts.json)
 *    e, dali em diante, qualquer chave diferente é RECUSADA. Troca legítima (servidor
 *    reinstalado): apague a entrada do arquivo ou defina SSH_HOST_FINGERPRINT.
 * @returns {{ ok: boolean, fingerprint: string, keyType: string, expected: string[], source: string, firstUse?: boolean }}
 */
function checkHostKey(keyBlob, { host = config.ssh.host, port = config.ssh.port, pinned = pinnedFingerprints(), file = KNOWN_HOSTS_FILE() } = {}) {
    const fingerprint = sshFingerprint(keyBlob);
    const keyType = sshKeyType(keyBlob);
    if (pinned.length) {
        return { ok: pinned.includes(fingerprint), fingerprint, keyType, expected: pinned, source: 'SSH_HOST_FINGERPRINT' };
    }
    const id = `${host}:${port}`;
    const known = readKnownHosts(file);
    const entry = known[id];
    if (entry && entry.fingerprint) {
        return { ok: entry.fingerprint === fingerprint, fingerprint, keyType, expected: [entry.fingerprint], source: file };
    }
    known[id] = { fingerprint, keyType, firstSeen: new Date().toISOString() };
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(known, null, 2));
        fs.renameSync(tmp, file);
    } catch (err) {
        logger.warn(`SSH: não foi possível registrar a chave do servidor em ${file}: ${err.message}`);
    }
    return { ok: true, fingerprint, keyType, expected: [], source: file, firstUse: true };
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
        hostKey: null,           // resultado da verificação da chave do servidor
    };

    const opts = {
        host: config.ssh.host,
        username: config.ssh.user,
        port: config.ssh.port,
        readyTimeout: 20000, // falha rápido em vez de pendurar
        keepaliveInterval: 20000, // detecta conexão morta (a compartilhada fica aberta)
        keepaliveCountMax: 3,
        // Confere a chave do servidor ANTES de enviar qualquer credencial.
        hostVerifier: (keyBlob) => {
            const v = checkHostKey(keyBlob);
            diag.hostKey = v;
            if (v.firstUse) {
                logger.warn(`SSH: chave do servidor ${config.ssh.host}:${config.ssh.port} registrada no primeiro uso ` +
                    `(${v.keyType} ${v.fingerprint}). Confira com "ssh-keygen -lf" no servidor e fixe-a no .env: SSH_HOST_FINGERPRINT=${v.fingerprint}`);
            }
            return v.ok;
        },
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
/** Falha de rede (porta fechada, sem resposta, host inexistente): nem chegou a autenticar. */
function isSshNetworkError(err) {
    const raw = (err && err.message) || '';
    return err?.level === 'client-socket' || err?.level === 'client-timeout' ||
        /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|getaddrinfo|Timed out while waiting for handshake/i.test(raw);
}

const SSH_WINDOWS_HINT = 'Se o servidor do banco é Windows: ative o OpenSSH Server nele (porta 22 liberada no firewall) ' +
    'ou instale o Oracle Pulse no próprio servidor do banco, que lê disco e memória sem SSH.';

/** A conexão foi recusada porque a chave do servidor não confere? */
function isHostKeyRejected(err) {
    return !!(err && err.diag && err.diag.hostKey && !err.diag.hostKey.ok);
}

function logSshDiagnostics(err) {
    const d = err.diag || {};
    logger.error('========== DIAGNÓSTICO SSH ==========');
    logger.error(`Erro: ${err.message}${err.level ? ` (level=${err.level})` : ''}`);
    logger.error(`Host: ${config.ssh.host}:${config.ssh.port}  |  Usuário: "${d.username}"`);
    if (isHostKeyRejected(err)) {
        logger.error(`→ CHAVE DO SERVIDOR NÃO CONFERE: recebida ${d.hostKey.keyType} ${d.hostKey.fingerprint}; ` +
            `esperada ${d.hostKey.expected.join(' ou ')} (${d.hostKey.source}). Conexão recusada SEM enviar senha.`);
        logger.error('→ Pode ser um ataque man-in-the-middle. Se o servidor foi reinstalado ou trocou de chave, confira o ' +
            'fingerprint no próprio servidor (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub) e atualize SSH_HOST_FINGERPRINT ' +
            '(ou apague a entrada em logs/ssh-known-hosts.json).');
        logger.error('=======================================================');
        return;
    }
    if (isSshNetworkError(err)) {
        // Sem conexão não houve autenticação: dicas de senha/chave só confundiriam.
        if (/ECONNREFUSED/i.test(err.message)) {
            logger.error(`→ A porta ${config.ssh.port} recusou a conexão: não há servidor SSH escutando nela (ou o firewall rejeita).`);
        } else if (/ENOTFOUND|getaddrinfo/i.test(err.message)) {
            logger.error('→ O nome do servidor não foi encontrado (DNS): confira SSH_HOST ou use o IP.');
        } else {
            logger.error(`→ Sem resposta do SSH na porta ${config.ssh.port}: serviço SSH parado, firewall/VPN bloqueando a porta ou host inacessível.`);
        }
        logger.error(`→ ${SSH_WINDOWS_HINT}`);
        logger.error('=======================================================');
        return;
    }
    logger.error(`Método tentado: ${d.method}`);

    if (d.method === 'password') {
        // O comprimento da senha ajuda quem tenta adivinhá-la e este log é legível por
        // outros usuários da máquina: só aparece com SSH_DEBUG=true (diagnóstico pontual).
        const sshDebug = String(process.env.SSH_DEBUG).toLowerCase() === 'true';
        logger.error(`Senha: ${sshDebug ? `comprimento=${d.passwordLen}` : 'configurada (comprimento oculto; SSH_DEBUG=true mostra)'}` +
            (d.passwordEdgeWhitespace ? '  ⚠️ contém espaço/quebra de linha nas bordas (verifique aspas no .env)' : ''));
        logger.error('⚠️ O .env trunca a senha no caractere "#" e em espaços quando ela NÃO está entre aspas. ' +
            'Se a senha tem # ou espaço, use: SSH_PASSWORD="suaSenha#aqui".');
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
    if (isHostKeyRejected(err)) {
        return `A chave do servidor SSH ${config.ssh.host}:${config.ssh.port} não confere com a registrada ` +
            '(possível ataque man-in-the-middle ou servidor reinstalado): a conexão foi recusada sem enviar senha. ' +
            'Veja o diagnóstico no log do painel antes de aceitar a nova chave.';
    }
    if (err?.level === 'client-authentication' || /authentication methods failed/i.test(raw)) {
        return 'Falha de autenticação SSH. Verifique usuário/senha e se o servidor permite login por senha ' +
            '(PasswordAuthentication / KbdInteractiveAuthentication). Se o servidor exige chave, configure ' +
            'SSH_PRIVATE_KEY_PATH no .env. Confirme também que a conta não está bloqueada ou expirada.';
    }
    if (isSshNetworkError(err) || /timed out/i.test(raw)) {
        const where = `${config.ssh.host}:${config.ssh.port}`;
        const why = /ECONNREFUSED/i.test(raw) ? 'recusou a conexão (nenhum servidor SSH escutando)'
            : /ENOTFOUND|getaddrinfo/i.test(raw) ? 'não foi encontrado (nome/DNS)'
                : 'não respondeu (SSH parado, firewall ou VPN bloqueando a porta)';
        return `Servidor SSH ${where} ${why}. ${SSH_WINDOWS_HINT}`;
    }
    return 'Falha SSH: ' + raw;
}

/**
 * Lê o uso dos volumes que contêm os diretórios informados, no servidor de
 * banco (via SSH, ou local quando o painel roda na mesma máquina do banco).
 *  - Linux:   `df -kP` em CADA diretório (o df resolve o ponto de montagem
 *             exato; diretórios inexistentes voltam em `missing`).
 *  - Windows: Win32_Volume (letras de unidade e volumes montados em pasta),
 *             associado pelo prefixo mais longo, sem diferenciar maiúsculas.
 * ASM (+DATA) não passa por aqui (é lido do banco, em src/storage.js).
 * Não lança: problemas viram mensagens em `errors`.
 * @param {string[]} dirs  diretórios (com separador final)
 * @returns {Promise<{ mounts: object[], dirMount: object, missing: string[], errors: string[] }>}
 */
async function readDiskUsage(dirs) {
    const usage = { mounts: [], dirMount: {}, missing: [], errors: [] };
    const byStyle = (st) => (dirs || []).filter((d) => sp.pathStyle(d) === st);
    const posix = byStyle('posix');
    const win = byStyle('windows');
    const unc = byStyle('unc');
    if (unc.length) usage.errors.push(`Caminhos de rede não são lidos (sem letra de unidade): ${unc.join(', ')}`);

    const panelWin = os.platform() === 'win32';
    const used = new Map();

    if (posix.length) {
        if (!config.ssh.host && panelWin) {
            usage.errors.push('O banco está no Linux, mas o painel roda no Windows. Configure o acesso SSH no .env para ler os discos do servidor.');
        } else {
            const r = await execOnServer(dfByDirCommand(posix));
            const parsed = sp.parseDfByDir(r.stdout);
            if (!parsed.mounts.length && r.code !== 0) {
                usage.errors.push('Leitura de disco (df) falhou: ' + String(r.stderr || 'sem saída').trim().slice(0, 300));
            } else {
                parsed.mounts.forEach((m) => used.set(m.mount, m));
                Object.assign(usage.dirMount, parsed.dirMount);
                usage.missing.push(...parsed.missing);
            }
        }
    }

    if (win.length) {
        if (!config.ssh.host && !panelWin) {
            usage.errors.push('O banco está no Windows, mas o painel roda no Linux. Configure o acesso SSH no .env para ler os discos do servidor.');
        } else {
            const r = await execOnServer(winVolumesCommand());
            const vols = sp.parseWinVolumes(r.stdout);
            if (!vols.length) {
                usage.errors.push('Leitura dos volumes do Windows falhou: ' + String(r.stderr || r.stdout || 'sem saída').trim().slice(0, 300));
            } else {
                for (const d of win) {
                    const m = sp.findMount(d, vols);
                    if (m) {
                        used.set(m.mount, m);
                        usage.dirMount[sp.dirKey(d)] = m.mount;
                    } else {
                        usage.missing.push(d);
                    }
                }
            }
        }
    }

    usage.mounts = [...used.values()];
    return usage;
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

    // SO do servidor pelo caminho dos datafiles (ASM não revela: aí sonda o servidor).
    const serverIsLinux = (await detectServerOs()) === 'linux'; // guardado por 10 min

    if (config.ssh.host) {
        // Pela conexão SSH compartilhada (execOnServer): sem um login novo a cada leitura.
        if (serverIsLinux) {
            const result = await execOnServer('cat /proc/meminfo');
            if (result.code !== 0 || !result.stdout.trim()) {
                return { error: result.code === -1 ? result.stderr : 'Falha ao ler memória (/proc/meminfo): ' + (result.stderr || 'sem saída').trim() };
            }
            const parsed = parseMeminfo(result.stdout);
            return parsed || { error: 'Não foi possível interpretar /proc/meminfo.' };
        }
        const result = await execOnServer(winMemCommand());
        if (result.code !== 0 || !result.stdout.trim()) {
            return { error: result.code === -1 ? result.stderr : 'Leitura de memória remota falhou: ' + (result.stderr || 'sem saída').trim() };
        }
        const parsed = parseWinMem(result.stdout);
        return parsed || { error: 'Saída inesperada ao ler a memória remota.' };
    }

    // Banco local (mesma máquina do painel)
    if (os.platform() === 'win32') {
        if (serverIsLinux) {
            return { error: 'O Banco está no Linux, mas o painel roda no Windows. Configure o acesso SSH no .env.' };
        }
        const r = await execLocal(winMemCommand());
        if (r.code !== 0 || !r.stdout.trim()) {
            return { error: 'Leitura de memória local (Windows) falhou: ' + String(r.stderr || 'sem saída').trim().slice(0, 300) };
        }
        return parseWinMem(r.stdout) || { error: 'Não foi possível ler a memória local (Windows).' };
    }
    const r = await execLocal('cat /proc/meminfo');
    if (r.code !== 0 || !r.stdout.trim()) {
        return { error: 'Falha ao ler /proc/meminfo local: ' + String(r.stderr || 'sem saída').trim().slice(0, 300) };
    }
    return parseMeminfo(r.stdout) || { error: 'Não foi possível ler /proc/meminfo local.' };
}

/**
 * Detecta o SO do servidor de banco: 'linux' ou 'windows'.
 * Usa o caminho dos datafiles (remoto) ou a plataforma local. O resultado
 * confirmado fica guardado por 10 min: o SO do servidor não muda, e várias telas
 * perguntam isso a cada carga.
 */
const OS_CACHE_MS = 10 * 60000;
let serverOsCache = null; // { value, at }

async function detectServerOs() {
    if (serverOsCache && Date.now() - serverOsCache.at < OS_CACHE_MS) return serverOsCache.value;
    const remember = (value) => { serverOsCache = { value, at: Date.now() }; return value; };
    try {
        const r = await runQuery('defaultDataPath');
        const fromPath = sp.osFromPath(r[0]?.PATH || r[0]?.path || '');
        if (fromPath) return remember(fromPath);
    } catch { /* ignore */ }
    // Caminho dos datafiles indisponível (banco só montado, ASM, erro, etc.):
    // prova o SO do servidor remoto em vez de assumir Linux — senão um banco
    // WINDOWS receberia comandos Linux (export/su/$ORACLE_HOME) e falharia.
    if (config.ssh.host) {
        try {
            const probe = await execOnServer('cmd /c echo %OS%');
            const out = (probe.stdout || '') + (probe.stderr || '');
            if (/Windows_NT/i.test(out)) return remember('windows');
            if (probe.code !== -1 && out) return remember('linux'); // respondeu, e não é Windows
        } catch { /* ignore */ }
        return 'linux'; // último recurso (não guardado): mantém o comportamento Linux já testado
    }
    return remember(os.platform() === 'win32' ? 'windows' : 'linux');
}

// ==========================================================================
// SSH compartilhado: abrir uma conexão por comando custava 0,5–2 s (handshake,
// PAM, registro de login no servidor) a cada leitura de disco/memória. Comandos
// curtos usam uma conexão persistente (fechada após 2 min sem uso); comandos
// longos ou com saída ao vivo (RMAN, recuperação) seguem com conexão própria.
// ==========================================================================
const SSH_IDLE_MS = 120000;
const SSH_MAX_CHANNELS = 6;     // abaixo do MaxSessions padrão do sshd (10)
let shared = null;              // { ssh, active, lastUse }
let sharedConnecting = null;
let idleTimer = null;

// Depois de uma falha de conexão, as leituras falham na hora por 60 s (com o mesmo
// motivo) em vez de cada uma esperar o timeout de 20 s — e sem repetir tentativas
// de senha que poderiam bloquear a conta no servidor.
const SSH_RETRY_AFTER_MS = 60000;
let sshDown = null; // { until, err }

async function getSharedSsh() {
    if (shared && shared.ssh.isConnected()) return shared;
    shared = null;
    if (sshDown && Date.now() < sshDown.until) throw sshDown.err;
    if (!sharedConnecting) {
        sharedConnecting = connectSsh()
            .catch((err) => {
                logSshDiagnostics(err); // uma vez por falha, não uma por leitura
                err.logged = true;
                sshDown = { until: Date.now() + SSH_RETRY_AFTER_MS, err };
                throw err;
            })
            .then((ssh) => {
                sshDown = null;
                const entry = { ssh, active: 0, lastUse: Date.now() };
                const drop = () => { if (shared === entry) shared = null; };
                ssh.connection.on('close', drop);
                ssh.connection.on('end', drop);
                ssh.connection.on('error', drop);
                shared = entry;
                armSshIdle();
                return entry;
            })
            .finally(() => { sharedConnecting = null; });
    }
    return sharedConnecting;
}

function armSshIdle() {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
        if (!shared) { clearInterval(idleTimer); idleTimer = null; return; }
        if (shared.active === 0 && Date.now() - shared.lastUse > SSH_IDLE_MS) closeSsh();
    }, 30000);
    if (idleTimer.unref) idleTimer.unref();
}

/** Fecha a conexão compartilhada (inatividade ou desligamento do painel). */
function closeSsh() {
    const entry = shared;
    shared = null;
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    if (entry) { try { entry.ssh.dispose(); } catch { /* ignore */ } }
}

// Falhou antes de o comando começar (conexão fechada / canal recusado): repetir é seguro.
const RETRYABLE_SSH = /Not connected|Channel open failure|exec request failed/i;

/** Comando curto pela conexão compartilhada; null = use uma conexão própria. */
async function execShared(command) {
    let entry;
    try {
        entry = await getSharedSsh();
    } catch (err) {
        if (!err.logged) logSshDiagnostics(err);
        return { code: -1, stdout: '', stderr: mapSshError(err) };
    }
    if (entry.active >= SSH_MAX_CHANNELS) return null;
    entry.active++;
    try {
        const r = await entry.ssh.execCommand(command);
        return { code: r.code, stdout: cleanPsClixml(r.stdout || ''), stderr: cleanPsClixml(r.stderr || '') };
    } catch (err) {
        if (shared === entry) closeSsh();
        if (RETRYABLE_SSH.test(err.message || '')) return null;
        return { code: -1, stdout: '', stderr: mapSshError(err) };
    } finally {
        entry.active--;
        entry.lastUse = Date.now();
    }
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
    const onOutput = typeof opts.onOutput === 'function' ? opts.onOutput : null;
    if (config.ssh.host) {
        // Leituras curtas (sem script na entrada nem saída ao vivo) reaproveitam a
        // conexão compartilhada; scripts sqlplus/RMAN usam conexão própria.
        if (stdin == null && !onOutput && !(opts.timeoutMs > 120000)) {
            const r = await execShared(command);
            if (r) return r;
        }
        // Em SSH as variáveis de ambiente são setadas no próprio comando (opts.env
        // não se aplica ao canal remoto).
        let ssh;
        try {
            ssh = await connectSsh();
            const execOpts = stdin != null ? { stdin } : {};
            if (onOutput) {
                execOpts.onStdout = (chunk) => safeEmit(onOutput, chunk, false);
                execOpts.onStderr = (chunk) => safeEmit(onOutput, chunk, true);
            }
            const r = await ssh.execCommand(command, execOpts);
            return { code: r.code, stdout: cleanPsClixml(r.stdout || ''), stderr: cleanPsClixml(r.stderr || '') };
        } catch (err) {
            logSshDiagnostics(err);
            return { code: -1, stdout: '', stderr: mapSshError(err) };
        } finally {
            if (ssh) ssh.dispose();
        }
    }
    // Execução LOCAL: herda o ambiente do painel; opts.env acrescenta/ajusta.
    // Assíncrona (spawn): um RMAN de horas não pode travar o painel inteiro,
    // como acontecia com execSync.
    return execLocal(command, { stdin, env: opts.env, onOutput, timeoutMs: opts.timeoutMs });
}

function safeEmit(fn, chunk, isErr) {
    try { fn(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk), isErr); } catch { /* o consumidor não derruba a execução */ }
}

/**
 * Executa um comando no shell local (cmd.exe no Windows, /bin/sh no Linux — o
 * mesmo shell que o execSync usava), sem bloquear o event loop.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function execLocal(command, { stdin, env, onOutput, timeoutMs } = {}) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
        let child;
        try {
            child = spawn(command, { shell: true, windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
        } catch (err) {
            finish({ code: 1, stdout: '', stderr: err.message });
            return;
        }
        const MAX = 16 * 1024 * 1024; // teto de memória por stream
        const out = [];
        const errs = [];
        let outLen = 0;
        let errLen = 0;
        child.stdout.on('data', (c) => {
            if (outLen < MAX) { out.push(c); outLen += c.length; }
            if (onOutput) safeEmit(onOutput, c, false);
        });
        child.stderr.on('data', (c) => {
            if (errLen < MAX) { errs.push(c); errLen += c.length; }
            if (onOutput) safeEmit(onOutput, c, true);
        });
        let timer = null;
        if (timeoutMs) {
            timer = setTimeout(() => {
                try {
                    // No Windows o kill() só derruba o cmd.exe; o taskkill /T leva a árvore toda.
                    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
                    else child.kill();
                } catch { /* já terminou */ }
            }, timeoutMs);
        }
        child.on('error', (err) => {
            if (timer) clearTimeout(timer);
            finish({ code: 1, stdout: cleanPsClixml(Buffer.concat(out).toString('utf8')), stderr: err.message });
        });
        child.on('close', (code, signal) => {
            if (timer) clearTimeout(timer);
            const stdout = cleanPsClixml(Buffer.concat(out).toString('utf8'));
            let stderr = cleanPsClixml(Buffer.concat(errs).toString('utf8'));
            const exit = code == null ? 1 : code;
            if (exit !== 0 && !stderr.trim()) stderr = signal ? `processo encerrado (${signal})` : `código de saída ${exit}`;
            finish({ code: exit, stdout, stderr });
        });
        child.stdin.on('error', () => { /* processo saiu antes de ler tudo */ });
        if (stdin != null) child.stdin.end(stdin);
        else child.stdin.end();
    });
}

module.exports = {
    readDiskUsage, getOsMemory, detectServerOs, execOnServer, closeSsh, psEncoded, cleanPsClixml,
    // expostos para teste/diagnóstico (builders puros):
    winVolumesCommand, dfByDirCommand, winMemCommand,
    sshFingerprint, sshKeyType, pinnedFingerprints, checkHostKey, mapSshError,
};

/**
 * Terminal do servidor (DBA-only, auditado). Executa comandos de SO, sqlplus
 * (AS SYSDBA) ou RMAN no servidor do banco, reutilizando os canais já usados
 * pela tela Recuperação e pelos backups. Ver src/serverTerminal.js.
 */
const express = require('express');
const { config } = require('../config');
const { requireDba } = require('../auth');
const { createRateLimiter } = require('../security');
const audit = require('../audit');
const terminal = require('../serverTerminal');

const router = express.Router();

// Evita rajadas (ex.: script em loop). Generoso: uso interativo normal passa.
const limiter = createRateLimiter({ windowMs: 60 * 1000, max: 40, message: 'Muitos comandos em sequência. Aguarde alguns segundos.' });

/** O que a tela precisa saber para habilitar os modos e mostrar avisos. */
router.get('/server/terminal/info', requireDba, async (req, res) => {
    const os = require('../osDisk');
    let serverOs = null;
    try { serverOs = config.demoMode ? 'linux' : await os.detectServerOs(); } catch { /* desconhecido */ }
    const automation = config.demoMode || terminal.automationReady(serverOs || 'linux');
    const osReachable = config.demoMode || !!config.ssh.host || serverOs === (process.platform === 'win32' ? 'windows' : 'linux');
    res.json({
        success: true,
        data: {
            serverOs: config.demoMode ? 'linux' : serverOs,
            demo: config.demoMode,
            remote: !!config.ssh.host,
            sshHost: config.ssh.host || null,
            automation,          // sqlplus/RMAN disponíveis
            osReachable,         // modo SO disponível
            passwordAuth: config.oracleServer.usesPasswordAuth,
            shells: {
                os: terminal.shellLabel('os', serverOs || 'linux'),
                sqlplus: terminal.shellLabel('sqlplus', serverOs || 'linux'),
                rman: terminal.shellLabel('rman', serverOs || 'linux'),
            },
        },
    });
});

router.post('/server/terminal/exec', requireDba, limiter, async (req, res) => {
    const ip = audit.ipOf(req);
    const mode = String((req.body && req.body.mode) || 'os');
    const command = (req.body && req.body.command != null) ? String(req.body.command) : '';
    try {
        const result = await terminal.run({ mode, command, timeoutMs: req.body && req.body.timeoutMs });
        audit.record({
            action: 'terminal-servidor',
            user: req.session.user, role: req.session.role, ip,
            success: result.ok,
            detail: `[${mode}] ${terminal.firstLine(command)}${result.ok ? '' : ` (código ${result.code})`}`,
        });
        res.json({ success: true, data: result });
    } catch (err) {
        const status = err.status || 500;
        audit.record({
            action: 'terminal-servidor',
            user: req.session.user, role: req.session.role, ip,
            success: false, detail: `[${mode}] ERRO: ${err.message} | ${terminal.firstLine(command)}`,
        });
        res.status(status).json({ success: false, error: err.message });
    }
});

module.exports = router;

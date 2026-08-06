/**
 * Terminal SQL (DBA-only, auditado): executa scripts SQL/PLSQL ad-hoc no banco
 * usando a conexão da aplicação (DB_USER) e devolve os resultados estruturados.
 *
 * Segurança:
 *  - Restrito a DBA (requireDba).
 *  - Toda execução é registrada na auditoria (com a 1ª linha do comando).
 *  - Senhas em comandos de criação de usuário são mascaradas no log de auditoria.
 *  - Resultados de SELECT são limitados a 1000 linhas (no db.executeScript).
 */
const express = require('express');
const { executeScript } = require('../db');
const { requireDba } = require('../auth');
const audit = require('../audit');

const router = express.Router();

const MAX_SQL_CHARS = 100000; // ~100 KB de script

/** Mascara senhas óbvias antes de gravar na auditoria (IDENTIFIED BY xxx). */
function scrubSqlForAudit(sql) {
    return String(sql)
        .replace(/identified\s+by\s+("[^"]+"|\S+)/gi, 'IDENTIFIED BY ***')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

router.post('/sql/execute', requireDba, async (req, res) => {
    const ip = audit.ipOf(req);
    const sqlText = (req.body && req.body.sql != null) ? String(req.body.sql) : '';

    if (!sqlText.trim()) {
        return res.status(400).json({ success: false, error: 'Informe um comando SQL para executar.' });
    }
    if (sqlText.length > MAX_SQL_CHARS) {
        return res.status(400).json({ success: false, error: `Script muito grande (máx. ${MAX_SQL_CHARS} caracteres).` });
    }

    try {
        const results = await executeScript(sqlText);
        const hadError = results.some((r) => r.type === 'error');
        audit.record({
            action: 'sql-terminal',
            user: req.session.user, role: req.session.role, ip,
            success: !hadError,
            detail: scrubSqlForAudit(sqlText) + (results.length > 1 ? ` (+${results.length - 1} comando[s])` : ''),
        });
        res.json({ success: true, results });
    } catch (err) {
        audit.record({
            action: 'sql-terminal',
            user: req.session.user, role: req.session.role, ip,
            success: false, detail: `ERRO: ${err.message} | ${scrubSqlForAudit(sqlText)}`,
        });
        res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;

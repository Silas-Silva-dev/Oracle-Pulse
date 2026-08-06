/**
 * QUERIES.JS - Dicionário de Consultas SQL do Oracle Pulse
 * Consultas de performance (V$), dicionário de dados (DBA_) e monitoramento
 * de backup/archivelog. Identificadores nunca são interpolados a partir de
 * entrada do usuário; valores variáveis usam bind variables (:nome).
 */

const queries = {
    // Status básico da instância
    instanceStatus: `
        SELECT
            instance_name,
            host_name,
            version,
            status,
            TO_CHAR(startup_time, 'DD/MM/YYYY HH24:MI:SS') as startup_time,
            TO_CHAR(SYSDATE, 'DD/MM/YYYY HH24:MI:SS') as current_time,
            ROUND((SYSDATE - startup_time) * 24 * 60, 2) as uptime_minutes
        FROM v$instance
    `,

    // Resumo de sessões (Ativas vs Inativas)
    sessionSummary: `
        SELECT
            status,
            count(*) as count
        FROM v$session
        WHERE username IS NOT NULL
        GROUP BY status
    `,

    // Uso de Memória (SGA + PGA Global)
    memoryUsage: `
        SELECT
            ROUND(pga_used / 1024 / 1024, 2) as pga_mb,
            ROUND(sga_used / 1024 / 1024, 2) as sga_mb,
            ROUND((pga_used + sga_used) / 1024 / 1024, 2) as total_used_mb,
            ROUND(total_limit / 1024 / 1024, 2) as total_config_mb,
            ROUND((pga_used + sga_used) / total_limit * 100, 2) as used_pct
        FROM (
            SELECT
                (SELECT SUM(value) FROM v$sga) as sga_used,
                (SELECT value FROM v$pgastat WHERE name = 'total PGA allocated') as pga_used,
                (SELECT SUM(bytes) FROM v$sgainfo WHERE name = 'Maximum SGA Size') +
                (SELECT value FROM v$pgastat WHERE name = 'aggregate PGA target parameter') as total_limit
            FROM dual
        )
    `,

    // Consumo de Memória por Sessão
    sessionMemoryUsage: `
        SELECT * FROM (
            SELECT
                s.sid,
                s.serial#,
                NVL(s.username, s.program) as username,
                s.program,
                ROUND(SUM(CASE WHEN sn.name = 'session pga memory' THEN st.value ELSE 0 END) / 1024 / 1024, 2) as pga_mb,
                ROUND(SUM(CASE WHEN sn.name = 'session uga memory' THEN st.value ELSE 0 END) / 1024 / 1024, 2) as sga_mb
            FROM v$session s
            JOIN v$sesstat st ON s.sid = st.sid
            JOIN v$statname sn ON st.statistic# = sn.statistic#
            WHERE sn.name IN ('session pga memory', 'session uga memory')
            GROUP BY s.sid, s.serial#, NVL(s.username, s.program), s.program
            ORDER BY pga_mb DESC
        ) WHERE ROWNUM <= 10
    `,

    // Comandos SQL em Tempo Real e Sessões Presas
    sqlCommands: `
        SELECT
            NVL(SUM(CASE WHEN blocking_session IS NOT NULL THEN 1 ELSE 0 END), 0) as blocked_sessions,
            NVL(SUM(CASE WHEN UPPER(sql_text) LIKE 'SELECT%' AND UPPER(sql_text) NOT LIKE '%WITH%' THEN 1 ELSE 0 END), 0) as selects,
            NVL(SUM(CASE WHEN UPPER(sql_text) LIKE 'INSERT%' AND UPPER(sql_text) NOT LIKE '%SELECT%' THEN 1 ELSE 0 END), 0) as inserts,
            NVL(SUM(CASE WHEN UPPER(sql_text) LIKE 'UPDATE%' AND UPPER(sql_text) NOT LIKE '%SELECT%' THEN 1 ELSE 0 END), 0) as updates,
            NVL(SUM(CASE WHEN UPPER(sql_text) LIKE 'DELETE%' AND UPPER(sql_text) NOT LIKE '%SELECT%' THEN 1 ELSE 0 END), 0) as deletes,
            NVL(SUM(CASE WHEN UPPER(sql_text) LIKE 'INSERT%SELECT%' THEN 1 ELSE 0 END), 0) as insert_with_select,
            NVL(SUM(CASE WHEN UPPER(sql_text) LIKE 'UPDATE%SELECT%' THEN 1 ELSE 0 END), 0) as update_with_select,
            NVL(SUM(CASE WHEN UPPER(sql_text) LIKE 'DELETE%SELECT%' THEN 1 ELSE 0 END), 0) as delete_with_select,
            NVL(SUM(CASE WHEN UPPER(sql_text) LIKE 'WITH%' THEN 1 ELSE 0 END), 0) as cte,
            NVL(SUM(CASE WHEN UPPER(sql_text) LIKE 'MERGE%' THEN 1 ELSE 0 END), 0) as merge,
            NVL(SUM(CASE WHEN sql_text IS NOT NULL
                      AND UPPER(sql_text) NOT LIKE 'SELECT%'
                      AND UPPER(sql_text) NOT LIKE 'INSERT%'
                      AND UPPER(sql_text) NOT LIKE 'UPDATE%'
                      AND UPPER(sql_text) NOT LIKE 'DELETE%'
                      AND UPPER(sql_text) NOT LIKE 'WITH%'
                      AND UPPER(sql_text) NOT LIKE 'MERGE%' THEN 1 ELSE 0 END), 0) as others
        FROM v$session s
        LEFT JOIN v$sql q ON s.sql_id = q.sql_id
        WHERE s.blocking_session IS NOT NULL OR s.sid IN (SELECT blocking_session FROM v$session WHERE blocking_session IS NOT NULL)
    `,

    tablespaceUsage: `
        SELECT
            tablespace_name,
            total_mb,
            free_mb,
            used_mb,
            ROUND((used_mb / total_mb) * 100, 2) as used_pct,
            max_mb
        FROM (
            SELECT
                a.tablespace_name,
                ROUND(a.bytes_alloc / 1024 / 1024, 2) total_mb,
                ROUND(nvl(b.bytes_free, 0) / 1024 / 1024, 2) free_mb,
                ROUND((a.bytes_alloc - nvl(b.bytes_free, 0)) / 1024 / 1024, 2) used_mb,
                ROUND(a.maxbytes / 1024 / 1024, 2) max_mb
            FROM  (
                SELECT  f.tablespace_name,
                        SUM(f.bytes) bytes_alloc,
                        SUM(decode(f.autoextensible, 'YES', f.maxbytes, 'NO', f.bytes)) maxbytes
                FROM dba_data_files f
                GROUP BY tablespace_name
            ) a,
            (
                SELECT  f.tablespace_name,
                        SUM(f.bytes) bytes_free
                FROM dba_free_space f
                GROUP BY tablespace_name
            ) b
            WHERE a.tablespace_name = b.tablespace_name (+)
            UNION ALL
            SELECT
                h.tablespace_name,
                ROUND(SUM(h.bytes_free + h.bytes_used) / 1048576, 2) total_mb,
                ROUND(SUM((h.bytes_free + h.bytes_used) - nvl(p.bytes_used, 0)) / 1048576, 2) free_mb,
                ROUND(SUM(nvl(p.bytes_used, 0))/ 1048576, 2) used_mb,
                ROUND(SUM(f.maxbytes) / 1048576, 2) max_mb
            FROM sys.v_$TEMP_SPACE_HEADER h, sys.v_$Temp_extent_pool p, dba_temp_files f
            WHERE p.file_id(+) = h.file_id
            AND p.tablespace_name(+) = h.tablespace_name
            AND f.file_id = h.file_id
            AND f.tablespace_name = h.tablespace_name
            GROUP BY h.tablespace_name
        )
        ORDER BY used_pct DESC
    `,

    // Performance: Top SQL por CPU
    topSql: `
        SELECT * FROM (
            SELECT
                sql_id,
                cpu_time / 1000000 as cpu_seconds,
                elapsed_time / 1000000 as elapsed_seconds,
                executions,
                SUBSTR(sql_text, 1, 100) as sql_snippet
            FROM v$sql
            ORDER BY cpu_time DESC
        ) WHERE ROWNUM <= 5
    `,

    // Top SQL por tempo decorrido (elapsed) - complementa a visão de CPU
    topSqlByElapsed: `
        SELECT * FROM (
            SELECT
                sql_id,
                ROUND(elapsed_time / 1000000, 2) as elapsed_seconds,
                ROUND(cpu_time / 1000000, 2) as cpu_seconds,
                executions,
                buffer_gets,
                SUBSTR(sql_text, 1, 100) as sql_snippet
            FROM v$sql
            WHERE executions > 0
            ORDER BY elapsed_time DESC
        ) WHERE ROWNUM <= 10
    `,

    // Wait Events
    waitEvents: `
        SELECT * FROM (
            SELECT
                event,
                total_waits,
                time_waited_micro / 1000000 as time_waited_seconds
            FROM v$system_event
            WHERE wait_class != 'Idle'
            ORDER BY time_waited_micro DESC
        ) WHERE ROWNUM <= 10
    `,

    // Detalha sessões envolvidas em bloqueios (Locks)
    sessionDetails: `
        SELECT
            s1.sid,
            s1.serial# as serial,
            NVL(s1.username, 'N/A') as victim,
            s1.program,
            s1.blocking_session as blocker_sid,
            NVL(s2.username, 'SYS/Internal') as blocker_user,
            CASE WHEN s1.blocking_session IS NULL THEN 'VILÃO (RAIZ)' ELSE 'VÍTIMA' END as role
        FROM v$session s1
        LEFT JOIN v$session s2 ON s1.blocking_session = s2.sid
        WHERE s1.blocking_session IS NOT NULL
           OR s1.sid IN (SELECT blocking_session FROM v$session WHERE blocking_session IS NOT NULL)
        ORDER BY s1.blocking_session NULLS FIRST
    `,

    // Sessões ativas de longa duração (possíveis queries presas)
    longRunningSessions: `
        SELECT * FROM (
            SELECT
                s.sid,
                s.serial# as serial,
                NVL(s.username, s.program) as username,
                s.program,
                s.status,
                s.sql_id,
                s.last_call_et as seconds_running,
                NVL(s.event, '-') as event
            FROM v$session s
            WHERE s.status = 'ACTIVE'
              AND s.username IS NOT NULL
              AND s.type = 'USER'
              AND s.last_call_et > 60
            ORDER BY s.last_call_et DESC
        ) WHERE ROWNUM <= 15
    `,

    // SQL Completo por SQL_ID
    fullSqlText: `
        SELECT sql_fulltext
        FROM v$sql
        WHERE sql_id = :sqlId AND ROWNUM = 1
    `,

    // Plano de execução por SQL_ID (do cursor em cache)
    sqlPlan: `
        SELECT plan_table_output
        FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(:sqlId, NULL, 'TYPICAL'))
    `,

    // Categorias de Espera (Wait Classes)
    waitClasses: `
        SELECT wait_class as label, SUM(time_waited) as value
        FROM v$system_wait_class
        WHERE wait_class <> 'Idle'
        GROUP BY wait_class
        ORDER BY value DESC
    `,

    // Métricas de Sistema em Tempo Real
    systemMetrics: `
        SELECT metric_name as label, value
        FROM v$sysmetric
        WHERE metric_name IN ('Database Wait Time Ratio', 'Database CPU Time Ratio', 'Response Time Per Txn')
        AND group_id = 2
    `,

    // Listagem de Datafiles por Tablespace
    datafilesList: `
        SELECT
            tablespace_name,
            file_name,
            ROUND(bytes / 1024 / 1024, 2) as size_mb,
            autoextensible,
            ROUND(maxbytes / 1024 / 1024, 2) as max_size_mb
        FROM dba_data_files
        ORDER BY tablespace_name, file_name
    `,

    // Buscar caminho padrão do banco (BASE PATH)
    defaultDataPath: `
        SELECT SUBSTR(file_name, 1, GREATEST(INSTR(file_name, '\\', -1), INSTR(file_name, '/', -1))) as path
        FROM dba_data_files
        WHERE ROWNUM = 1
    `,

    // ===================== MONITORAMENTO DE BACKUP / RECUPERAÇÃO =====================

    // Modo archivelog e nome do banco
    archivelogMode: `
        SELECT name, log_mode, open_mode, database_role
        FROM v$database
    `,

    // Últimos jobs de backup RMAN (session_key permite buscar o log em v$rman_output)
    rmanBackups: `
        SELECT * FROM (
            SELECT
                session_key,
                input_type,
                status,
                TO_CHAR(start_time, 'DD/MM/YYYY HH24:MI') as start_time,
                TO_CHAR(end_time, 'DD/MM/YYYY HH24:MI') as end_time,
                ROUND(elapsed_seconds / 60, 1) as elapsed_minutes,
                output_bytes_display
            FROM v$rman_backup_job_details
            ORDER BY start_time DESC
        ) WHERE ROWNUM <= 10
    `,

    // Log (saída) de uma sessão RMAN específica — v$rman_output é volátil
    // (guarda apenas a saída de sessões recentes na instância atual).
    rmanOutputBySession: `
        SELECT output
        FROM v$rman_output
        WHERE session_key = :sessionKey
        ORDER BY recid
    `,

    // Geração de redo (proxy para volume de archive logs) e uptime
    redoStats: `
        SELECT
            (SELECT value FROM v$sysstat WHERE name = 'redo size') as redo_bytes,
            GREATEST(ROUND((SYSDATE - (SELECT startup_time FROM v$instance)) * 86400), 1) as uptime_sec
        FROM dual
    `,

    // Tamanho total do banco (datafiles)
    dbSize: `
        SELECT ROUND(SUM(bytes) / 1024 / 1024 / 1024, 2) as db_size_gb
        FROM dba_data_files
    `,

    // Parâmetros da Recovery Area (destino e tamanho máximo configurado)
    recoveryParams: `
        SELECT name, value
        FROM v$parameter
        WHERE name IN ('db_recovery_file_dest', 'db_recovery_file_dest_size')
        ORDER BY name
    `,

    // Configuração persistente do RMAN (inclui RETENTION POLICY)
    rmanConfig: `
        SELECT name, value
        FROM v$rman_configuration
        ORDER BY name
    `,

    // Uso da Flash Recovery Area (FRA)
    fraUsage: `
        SELECT
            name,
            ROUND(space_limit / 1024 / 1024, 2) as limit_mb,
            ROUND(space_used / 1024 / 1024, 2) as used_mb,
            ROUND(DECODE(space_limit, 0, 0, (space_used - space_reclaimable) / space_limit * 100), 2) as used_pct
        FROM v$recovery_file_dest
    `,

    // ===================== OTIMIZAÇÃO DE MEMÓRIA (ADVISORS) =====================

    // Parâmetros atuais de memória (em MB). Permite saber o modo (AMM/ASMM/MANUAL).
    memoryParams: `
        SELECT name, ROUND(TO_NUMBER(value) / 1024 / 1024) as value_mb
        FROM v$parameter
        WHERE name IN ('sga_target', 'sga_max_size', 'pga_aggregate_target',
                       'pga_aggregate_limit', 'memory_target', 'memory_max_target')
        ORDER BY name
    `,

    // Conselheiro de PGA: qual PGA_AGGREGATE_TARGET reduz over-allocation
    pgaAdvice: `
        SELECT
            ROUND(pga_target_for_estimate / 1024 / 1024) as target_mb,
            pga_target_factor as factor,
            ROUND(estd_pga_cache_hit_percentage, 1) as cache_hit_pct,
            estd_overalloc_count as overalloc
        FROM v$pga_target_advice
        ORDER BY pga_target_for_estimate
    `,

    // Conselheiro de SGA: estimativa de DB time / leituras físicas por tamanho de SGA
    sgaAdvice: `
        SELECT
            sga_size as size_mb,
            sga_size_factor as factor,
            ROUND(estd_db_time) as estd_db_time,
            ROUND(estd_db_time_factor, 4) as db_time_factor,
            estd_physical_reads as physical_reads
        FROM v$sga_target_advice
        ORDER BY sga_size
    `,

    // Conselheiro de MEMORY_TARGET (quando AMM está ativo)
    memoryAdvice: `
        SELECT
            memory_size as size_mb,
            memory_size_factor as factor,
            ROUND(estd_db_time) as estd_db_time,
            ROUND(estd_db_time_factor, 4) as db_time_factor
        FROM v$memory_target_advice
        ORDER BY memory_size
    `,
};

module.exports = queries;

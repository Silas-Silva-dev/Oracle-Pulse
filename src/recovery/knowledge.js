/**
 * KNOWLEDGE.JS - Base de conhecimento dos erros Oracle ligados a falhas,
 * corrupção e recuperação. Cada entrada explica o erro em linguagem direta,
 * lista causas e ações e aponta os procedimentos (playbooks) que resolvem.
 *
 * ORA-00600/ORA-07445 são genéricos: o que importa é o PRIMEIRO argumento
 * (ex.: [kcratr_scan_lastbwr]), mapeado em ORA600_ARGS.
 */

const CATEGORIES = {
    internal: 'Erro interno',
    corruption: 'Corrupção de dados',
    media: 'Recuperação de mídia',
    redo: 'Redo log',
    controlfile: 'Controlfile',
    archive: 'Archive / FRA',
    instance: 'Instância',
    connectivity: 'Conexão',
    space: 'Espaço',
    memory: 'Memória',
    undo: 'Undo',
    session: 'Sessões',
    recovery: 'Durante a recuperação',
    dictionary: 'Dicionário de dados',
    protection: 'Proteção',
};

/** Ação que leva a outra tela do painel (em vez de um playbook). */
const STORAGE_LINK = { section: 'storage', label: 'Abrir Storage (adicionar datafile/espaço)' };

const ERRORS = {
    // ------------------------------------------------------------------ internos
    'ORA-00600': {
        title: 'Erro interno do Oracle',
        category: 'internal', severity: 'critical',
        meaning: 'O código do Oracle encontrou uma condição inesperada e abortou a operação. O primeiro argumento entre colchetes identifica onde: é ele que define o tratamento.',
        causes: ['Corrupção de bloco, de undo ou de controlfile', 'Queda de energia/storage durante escrita', 'Bug do Oracle (verificar patches)'],
        actions: ['Veja o primeiro argumento (ex.: [kcratr_scan_lastbwr]) — o painel reconhece os mais comuns', 'Leia o arquivo de trace citado no alert log ("Errors in file ...")', 'Se o argumento não for conhecido, abra chamado na Oracle (My Oracle Support: ORA-600 Lookup Tool)'],
        playbooks: [],
    },
    'ORA-07445': {
        title: 'Exceção de SO dentro do Oracle (core dump)',
        category: 'internal', severity: 'high',
        meaning: 'Um processo do Oracle recebeu um sinal do sistema operacional (SIGSEGV, SIGBUS...) e gerou dump. Normalmente é bug, às vezes memória ou objeto corrompido.',
        causes: ['Bug do Oracle', 'Memória física com defeito', 'Objeto/bloco corrompido lido pela sessão'],
        actions: ['Identifique a função no primeiro argumento e o SQL no trace do incidente', 'Aplique o último Release Update (RU) do Oracle', 'Se repetir sempre no mesmo objeto, valide-o (ANALYZE ... VALIDATE STRUCTURE / RMAN VALIDATE)'],
        playbooks: ['block-recover'],
    },

    // ------------------------------------------------------------------ conexão / sessão
    'ORA-03113': {
        title: 'Fim de arquivo no canal de comunicação',
        category: 'connectivity', severity: 'high',
        meaning: 'A sessão perdeu o processo servidor do outro lado: ou o processo morreu (instância caiu, erro interno, processo morto), ou a rede cortou a conexão. É um SINTOMA — a causa está no alert log e no estado da instância.',
        causes: ['Instância caiu (ORA-00600/07445, falta de memória, processo de background morto)', 'Na abertura (STARTUP): archiver travado por FRA cheia, erro de recuperação ou ORA-00600 ao abrir', 'Firewall/rede encerrando conexões ociosas', 'Sessão encerrada por KILL SESSION ou por limite de recursos'],
        actions: ['Confira se a instância está aberta (o diagnóstico abaixo mostra)', 'Procure no alert log o erro registrado no mesmo horário', 'Se aconteceu no STARTUP: verifique FRA/archiver e erros de recuperação', 'Conexões ociosas caindo: configure SQLNET.EXPIRE_TIME no sqlnet.ora do servidor'],
        playbooks: ['startup', 'fra-free', 'crash-recovery'],
        correlate: true,
    },
    'ORA-03114': {
        title: 'Não conectado ao Oracle',
        category: 'connectivity', severity: 'medium',
        meaning: 'A conexão já tinha caído antes deste comando (normalmente depois de um ORA-03113).',
        causes: ['Mesmas causas do ORA-03113'],
        actions: ['Reconecte e investigue o ORA-03113/causa original no alert log'],
        playbooks: ['startup'],
        correlate: true,
    },
    'ORA-03135': {
        title: 'Conexão perdeu contato',
        category: 'connectivity', severity: 'medium',
        meaning: 'O cliente parou de receber resposta do servidor (rede, firewall, timeout ou processo encerrado).',
        causes: ['Firewall/NAT derrubando conexões ociosas', 'Instância caiu', 'Timeout de rede (SQLNET.RECV_TIMEOUT)'],
        actions: ['Verifique o estado da instância e o alert log', 'Ajuste SQLNET.EXPIRE_TIME (keepalive) no servidor'],
        playbooks: [],
        correlate: true,
    },
    'ORA-01092': {
        title: 'Instância encerrada — desconexão forçada',
        category: 'instance', severity: 'critical',
        meaning: 'A instância terminou enquanto a sessão estava conectada — muito comum durante o ALTER DATABASE OPEN quando há um erro grave na abertura (undo, dicionário, recuperação).',
        causes: ['Erro ao abrir: ORA-00600 [4194/4193] no undo, ORA-00704 (bootstrap), ORA-01578 em bloco do SYSTEM/UNDO', 'Processo de background morto'],
        actions: ['Leia no alert log os erros imediatamente ANTERIORES a este', 'Siga o procedimento indicado para o erro de origem'],
        playbooks: ['startup', 'crash-recovery'],
        correlate: true,
    },
    'ORA-01034': {
        title: 'Oracle não disponível (instância parada)',
        category: 'instance', severity: 'critical',
        meaning: 'Não há instância em execução para este SID/serviço.',
        causes: ['Banco foi desligado ou caiu', 'Servidor reiniciou sem iniciar o Oracle automaticamente', 'ORACLE_SID errado na conexão local'],
        actions: ['Inicie a instância (STARTUP) — o painel faz isso', 'Se não subir, o erro da abertura aparecerá e o painel indicará o próximo passo', 'Configure o início automático (Windows: ORA_<SID>_AUTOSTART; Linux: dbstart/systemd)'],
        playbooks: ['startup'],
    },
    'ORA-27101': {
        title: 'Área de memória compartilhada não existe',
        category: 'instance', severity: 'critical',
        meaning: 'Acompanha o ORA-01034: a SGA não existe porque a instância não está no ar (ou o ORACLE_SID está errado).',
        causes: ['Instância parada', 'ORACLE_SID/ORACLE_HOME diferentes dos da instância'],
        actions: ['Inicie a instância', 'Confira ORACLE_SID e ORACLE_HOME do ambiente'],
        playbooks: ['startup'],
    },
    'ORA-01033': {
        title: 'Oracle iniciando ou desligando',
        category: 'instance', severity: 'high',
        meaning: 'A instância existe mas o banco não está aberto (NOMOUNT ou MOUNT). Usuários comuns não conseguem entrar até o OPEN terminar.',
        causes: ['Abertura em andamento', 'O OPEN falhou e o banco ficou montado (erro de recuperação, arquivo ausente, archiver travado)', 'Banco deixado em MOUNT para manutenção'],
        actions: ['Veja o estado atual e o último erro do alert log', 'Abra o banco (ALTER DATABASE OPEN) ou siga o procedimento do erro que impede a abertura'],
        playbooks: ['startup', 'crash-recovery', 'datafile-recover'],
        correlate: true,
    },
    'ORA-01507': {
        title: 'Banco de dados não montado',
        category: 'instance', severity: 'high',
        meaning: 'A instância está em NOMOUNT: o controlfile ainda não foi lido.',
        causes: ['STARTUP NOMOUNT manual', 'Falha ao ler o controlfile (ver ORA-00205)'],
        actions: ['Monte e abra o banco', 'Se falhar com ORA-00205, restaure o controlfile'],
        playbooks: ['startup', 'controlfile-restore'],
    },
    'ORA-01109': {
        title: 'Banco de dados não aberto',
        category: 'instance', severity: 'high',
        meaning: 'O banco está montado (MOUNT) mas não aberto.',
        causes: ['Abertura não concluída', 'Manutenção em MOUNT'],
        actions: ['Abra o banco; se o OPEN falhar, siga o erro retornado'],
        playbooks: ['startup'],
    },
    'ORA-12514': {
        title: 'Listener não conhece o serviço',
        category: 'connectivity', severity: 'high',
        meaning: 'O listener está no ar, mas nenhuma instância registrou esse SERVICE_NAME.',
        causes: ['Instância parada', 'Instância acabou de subir e ainda não registrou (até 60 s)', 'SERVICE_NAME errado na conexão', 'LOCAL_LISTENER apontando para outro endereço'],
        actions: ['Verifique se a instância está aberta', 'Force o registro: ALTER SYSTEM REGISTER', 'Confira "lsnrctl status" e o DB_SERVICE do painel'],
        playbooks: ['startup'],
    },
    'ORA-12505': {
        title: 'Listener não conhece o SID',
        category: 'connectivity', severity: 'high',
        meaning: 'O listener não tem a instância (SID) informada na conexão.',
        causes: ['Instância parada', 'SID errado na string de conexão'],
        actions: ['Inicie a instância ou corrija o SID/SERVICE_NAME'],
        playbooks: ['startup'],
    },
    'ORA-12541': {
        title: 'Listener não está no ar',
        category: 'connectivity', severity: 'critical',
        meaning: 'Nada escuta na porta do listener (padrão 1521) no servidor.',
        causes: ['Listener parado (servidor reiniciou)', 'Porta/host errados', 'Firewall bloqueando (às vezes aparece como timeout)'],
        actions: ['Inicie o listener (lsnrctl start) — o painel faz isso', 'Configure o listener para iniciar com o SO'],
        playbooks: ['listener-start'],
    },
    'ORA-12528': {
        title: 'Instância bloqueando novas conexões',
        category: 'instance', severity: 'high',
        meaning: 'A instância está registrada como BLOCKED no listener (NOMOUNT, abrindo, ou em modo restrito).',
        causes: ['Banco em NOMOUNT/MOUNT', 'Abertura em andamento'],
        actions: ['Conclua a abertura do banco'],
        playbooks: ['startup'],
    },
    'ORA-12560': {
        title: 'Erro do adaptador de protocolo (Windows: serviço parado)',
        category: 'connectivity', severity: 'high',
        meaning: 'No Windows quase sempre significa que o serviço OracleService<SID> está parado ou que o ORACLE_SID do ambiente não corresponde a uma instância.',
        causes: ['Serviço OracleService<SID> parado', 'ORACLE_SID não definido/errado', 'Listener parado (conexão por alias)'],
        actions: ['Inicie o serviço OracleService<SID> e a instância', 'Confira ORACLE_SID'],
        playbooks: ['startup', 'listener-start'],
    },
    'ORA-12170': {
        title: 'Tempo de conexão esgotado',
        category: 'connectivity', severity: 'high',
        meaning: 'O cliente não conseguiu alcançar o listener a tempo.',
        causes: ['Servidor desligado ou inacessível', 'Firewall bloqueando a porta 1521', 'DNS resolvendo para o IP errado'],
        actions: ['Teste a rede (ping/porta 1521)', 'Use o IP em DB_HOST se o nome resolver errado', 'Libere a porta no firewall do servidor'],
        playbooks: [],
    },
    'ORA-12546': {
        title: 'TNS: permissão negada',
        category: 'connectivity', severity: 'high',
        meaning: 'O banco recusou a origem ou o método da conexão (não é senha).',
        causes: ['tcp.validnode_checking no sqlnet.ora restringindo IPs', 'Conexão local (BEQ) não autorizada no Windows'],
        actions: ['Confira INVITED_NODES no sqlnet.ora', 'Use o alias TNS que funciona manualmente (DB_TNS_ALIAS)'],
        playbooks: [],
    },
    'ORA-01017': {
        title: 'Usuário ou senha inválidos',
        category: 'connectivity', severity: 'high',
        meaning: 'As credenciais não conferem.',
        causes: ['Senha alterada', 'Usuário errado no .env', 'Para SYS: arquivo de senhas (orapw) desatualizado'],
        actions: ['Confira DB_USER/DB_PASSWORD (ou DB_SYS_PASSWORD) no .env', 'Para SYS remoto: recrie o arquivo de senhas com orapwd'],
        playbooks: [],
    },
    'ORA-28000': {
        title: 'Conta bloqueada',
        category: 'connectivity', severity: 'high',
        meaning: 'A conta foi bloqueada (tentativas erradas ou bloqueio manual).',
        causes: ['Senha errada em alguma aplicação estourou FAILED_LOGIN_ATTEMPTS', 'Bloqueio manual'],
        actions: ['Desbloqueie como SYSDBA: ALTER USER <usuario> ACCOUNT UNLOCK', 'Corrija a aplicação que usa a senha antiga, senão bloqueia de novo'],
        playbooks: ['unlock-account'],
    },
    'ORA-28001': {
        title: 'Senha expirada',
        category: 'connectivity', severity: 'high',
        meaning: 'A senha passou do PASSWORD_LIFE_TIME do perfil.',
        causes: ['Perfil DEFAULT com expiração de senha (180 dias)'],
        actions: ['Defina uma nova senha: ALTER USER <usuario> IDENTIFIED BY <nova>', 'Para contas de serviço, use um perfil sem expiração'],
        playbooks: [],
    },
    'ORA-00020': {
        title: 'Limite de processos atingido',
        category: 'session', severity: 'high',
        meaning: 'O número de processos chegou ao parâmetro PROCESSES; ninguém novo consegue conectar.',
        causes: ['Pool de conexões de aplicação sem limite', 'Sessões presas/ociosas acumuladas'],
        actions: ['Encerre sessões ociosas (tela Sessões)', 'Aumente PROCESSES (exige reinício): ALTER SYSTEM SET processes=N SCOPE=SPFILE'],
        playbooks: [],
    },
    'ORA-00018': {
        title: 'Limite de sessões atingido',
        category: 'session', severity: 'high',
        meaning: 'O número de sessões chegou ao parâmetro SESSIONS.',
        causes: ['Excesso de conexões da aplicação'],
        actions: ['Encerre sessões ociosas', 'Aumente SESSIONS/PROCESSES (exige reinício)'],
        playbooks: [],
    },
    'ORA-12012': {
        title: 'Job agendado falhou',
        category: 'session', severity: 'low',
        meaning: 'Um job do DBMS_SCHEDULER/DBMS_JOB terminou com erro; o motivo real vem na linha seguinte do alert log.',
        causes: ['Erro do próprio código do job', 'DB link/rede indisponível', 'Objeto inválido ou sem privilégio'],
        actions: ['Veja o erro seguinte e o trace citado', 'Consulte DBA_SCHEDULER_JOB_RUN_DETAILS para o histórico do job'],
        playbooks: [],
    },
    'ORA-00060': {
        title: 'Deadlock detectado',
        category: 'session', severity: 'low',
        meaning: 'Duas sessões esperavam uma pela outra; o Oracle desfez o comando de uma delas. Não é falha do banco — é lógica de aplicação.',
        causes: ['Aplicações atualizando as mesmas linhas em ordens diferentes', 'Chave estrangeira sem índice'],
        actions: ['Veja o trace citado no alert log (grafo do deadlock)', 'Indexe as chaves estrangeiras envolvidas'],
        playbooks: [],
    },

    // ------------------------------------------------------------------ instância / processos / memória
    'ORA-00704': {
        title: 'Falha no bootstrap',
        category: 'corruption', severity: 'critical',
        meaning: 'O Oracle não conseguiu carregar o dicionário de dados na abertura — tablespace SYSTEM danificada ou inconsistente.',
        causes: ['Corrupção no SYSTEM', 'Recuperação incompleta inconsistente', 'Versão/upgrade inconsistente'],
        actions: ['Restaure o datafile do SYSTEM do backup e recupere', 'Em último caso, restaure o banco inteiro'],
        playbooks: ['datafile-restore', 'restore-database'],
    },
    'ORA-00470': {
        title: 'Processo LGWR terminou',
        category: 'instance', severity: 'critical',
        meaning: 'O processo que grava o redo morreu e derrubou a instância.',
        causes: ['Erro de I/O nos redo logs', 'Disco cheio/indisponível', 'Processo morto pelo SO (falta de memória)'],
        actions: ['Veja o erro anterior no alert log (I/O, redo)', 'Verifique os discos dos redo logs', 'Inicie a instância depois de corrigir a causa'],
        playbooks: ['startup', 'redo-member'],
    },
    'ORA-00471': {
        title: 'Processo DBWR terminou',
        category: 'instance', severity: 'critical',
        meaning: 'O processo que grava os datafiles morreu e derrubou a instância.',
        causes: ['Erro de I/O em datafile', 'Disco indisponível', 'Processo morto pelo SO'],
        actions: ['Veja o erro anterior no alert log', 'Verifique os discos dos datafiles', 'Inicie a instância (a recuperação de instância é automática)'],
        playbooks: ['startup'],
    },
    'ORA-00474': {
        title: 'Processo SMON terminou',
        category: 'instance', severity: 'critical',
        meaning: 'O SMON morreu (muitas vezes durante a recuperação de transações, por undo corrompido).',
        causes: ['Undo corrompido', 'ORA-00600 durante a recuperação de transações'],
        actions: ['Veja o ORA-00600 anterior no alert log', 'Se for undo, recrie o UNDO'],
        playbooks: ['startup', 'undo-recreate'],
    },
    'ORA-00494': {
        title: 'Enqueue retido por tempo demais — instância derrubada',
        category: 'instance', severity: 'critical',
        meaning: 'Um processo segurou um recurso crítico (normalmente CF, do controlfile) por muito tempo e o Oracle encerrou a instância para se proteger.',
        causes: ['Storage lento/travado', 'Servidor sem CPU/memória (swap intenso)'],
        actions: ['Verifique o storage e a carga do servidor no horário', 'Inicie a instância'],
        playbooks: ['startup'],
    },
    'ORA-00845': {
        title: 'MEMORY_TARGET não suportado neste sistema',
        category: 'memory', severity: 'critical',
        meaning: 'No Linux, o /dev/shm é menor que o MEMORY_TARGET; a instância não sobe.',
        causes: ['/dev/shm com tamanho padrão (metade da RAM) menor que MEMORY_TARGET'],
        actions: ['Aumente o /dev/shm: mount -o remount,size=<N>G /dev/shm e grave no /etc/fstab', 'Ou troque AMM por SGA_TARGET/PGA_AGGREGATE_TARGET'],
        playbooks: [],
    },
    'ORA-27102': {
        title: 'Sem memória para a SGA',
        category: 'memory', severity: 'critical',
        meaning: 'O SO recusou alocar a SGA.',
        causes: ['Parâmetros de kernel (shmmax/shmall) baixos', 'RAM insuficiente', 'Limites (ulimit/memlock)'],
        actions: ['Reduza SGA/MEMORY_TARGET num pfile e inicie', 'Ajuste kernel.shmmax/shmall'],
        playbooks: [],
    },
    'ORA-04031': {
        title: 'Sem memória compartilhada (shared pool)',
        category: 'memory', severity: 'high',
        meaning: 'O shared pool não tem um bloco contíguo livre do tamanho pedido (fragmentação ou pool pequeno).',
        causes: ['SQL sem bind variables enchendo o shared pool', 'SGA pequena', 'Vazamento de memória (bug)'],
        actions: ['Alívio imediato: ALTER SYSTEM FLUSH SHARED_POOL', 'Aumente SHARED_POOL_SIZE/SGA_TARGET (tela Memória)', 'Use bind variables nas aplicações'],
        playbooks: ['flush-shared-pool'],
    },
    'ORA-04030': {
        title: 'Sem memória de processo (PGA)',
        category: 'memory', severity: 'high',
        meaning: 'Um processo não conseguiu alocar memória privada no SO.',
        causes: ['Operação grande de ordenação/hash', 'Limites do SO (ulimit)', 'RAM esgotada'],
        actions: ['Revise PGA_AGGREGATE_LIMIT/TARGET (tela Memória)', 'Verifique a RAM livre do servidor'],
        playbooks: [],
    },
    'ORA-27300': {
        title: 'Falha numa operação do sistema operacional',
        category: 'instance', severity: 'high',
        meaning: 'Uma chamada ao SO falhou (fork, semáforo, memória). Vem acompanhado de ORA-27301/27302 com o detalhe.',
        causes: ['Limites do SO (processos, semáforos, arquivos abertos)', 'Falta de memória/swap'],
        actions: ['Leia o ORA-27301/27302 seguinte', 'Ajuste limites do SO (limits.conf, kernel.sem)'],
        playbooks: [],
    },

    // ------------------------------------------------------------------ mídia / datafiles
    'ORA-01113': {
        title: 'Datafile precisa de recuperação de mídia',
        category: 'media', severity: 'critical',
        meaning: 'O cabeçalho do datafile está atrás do controlfile: faltam alterações (redo) que precisam ser aplicadas antes de abrir/usar o arquivo.',
        causes: ['Queda de energia/abort com arquivo em backup mode', 'Arquivo restaurado de backup', 'Arquivo ficou offline e perdeu alterações'],
        actions: ['Aplique o redo: RECOVER DATAFILE (um arquivo) ou RECOVER DATABASE (vários) e depois coloque online/abra'],
        playbooks: ['datafile-recover', 'crash-recovery'],
    },
    'ORA-01110': {
        title: 'Identificação do datafile',
        category: 'media', severity: 'info',
        meaning: 'Mensagem complementar: indica QUAL arquivo (número e caminho) o erro anterior afeta.',
        causes: [],
        actions: ['Trate o erro que vem junto (ORA-01113, ORA-01157, ORA-01578...)'],
        playbooks: [],
    },
    'ORA-01157': {
        title: 'Datafile não encontrado ou bloqueado',
        category: 'media', severity: 'critical',
        meaning: 'O processo DBWR não conseguiu abrir o arquivo: ele não existe no caminho registrado, está sem permissão, ou o disco não está montado.',
        causes: ['Disco/volume não montado (ex.: /u02 após reboot)', 'Arquivo apagado ou movido', 'Permissão errada', 'Tempfile não recriado após restore/clone'],
        actions: ['Confirme se o volume está montado e o arquivo existe', 'Arquivo realmente perdido: restaure do backup e recupere', 'Se for TEMPFILE: basta recriá-lo'],
        playbooks: ['datafile-restore', 'temp-recreate'],
    },
    'ORA-01116': {
        title: 'Erro ao abrir arquivo do banco',
        category: 'media', severity: 'critical',
        meaning: 'O Oracle não conseguiu abrir o arquivo (o ORA-27041/27037 seguinte traz o erro do SO).',
        causes: ['Arquivo ausente', 'Permissão', 'Disco desmontado'],
        actions: ['Verifique o arquivo no SO', 'Restaure se estiver perdido'],
        playbooks: ['datafile-restore'],
    },
    'ORA-27041': {
        title: 'Não foi possível abrir o arquivo (SO)',
        category: 'media', severity: 'high',
        meaning: 'Erro de SO ao abrir um arquivo do banco (complementa ORA-01116/ORA-01157).',
        causes: ['Arquivo inexistente', 'Permissão'],
        actions: ['Verifique o caminho e as permissões'],
        playbooks: ['datafile-restore'],
    },
    'ORA-27037': {
        title: 'Não foi possível obter o status do arquivo (SO)',
        category: 'media', severity: 'high',
        meaning: 'O arquivo não existe no caminho esperado (ou o diretório é inacessível).',
        causes: ['Arquivo/diretório inexistente', 'Volume desmontado'],
        actions: ['Verifique o caminho; restaure se necessário'],
        playbooks: ['datafile-restore'],
    },
    'ORA-01187': {
        title: 'Arquivo falhou na verificação',
        category: 'media', severity: 'high',
        meaning: 'Comum em TEMPFILES após restore/clonagem: o arquivo registrado não corresponde ao que existe em disco.',
        causes: ['Tempfile ausente/antigo após restore ou clone'],
        actions: ['Recrie o tempfile (adicionar novo e remover o inválido)'],
        playbooks: ['temp-recreate'],
    },
    'ORA-00376': {
        title: 'Arquivo não pode ser lido agora (offline)',
        category: 'media', severity: 'high',
        meaning: 'O datafile está OFFLINE (normalmente porque precisou de recuperação); objetos nele ficam inacessíveis.',
        causes: ['Arquivo colocado offline após erro de I/O', 'Arquivo aguardando RECOVER'],
        actions: ['Recupere e coloque o datafile online'],
        playbooks: ['datafile-recover'],
    },
    'ORA-01194': {
        title: 'Arquivo precisa de mais recuperação para ficar consistente',
        category: 'recovery', severity: 'critical',
        meaning: 'O datafile ainda está "fuzzy": falta aplicar redo até o ponto em que ele fica consistente. O OPEN RESETLOGS não é permitido assim.',
        causes: ['Recuperação incompleta parou cedo demais', 'Redo necessário foi perdido (log online corrompido)'],
        actions: ['Aplique os archives/redo que faltam', 'Se o redo foi perdido: restaure um backup mais antigo e recupere até um ponto consistente'],
        playbooks: ['restore-database', 'incomplete-recovery'],
    },
    'ORA-01547': {
        title: 'RECOVER concluiu, mas o OPEN RESETLOGS falharia',
        category: 'recovery', severity: 'high',
        meaning: 'Aviso: a recuperação aplicou o redo disponível, mas algum arquivo ainda não está consistente (veja o erro seguinte, normalmente ORA-01194).',
        causes: ['Redo insuficiente para tornar os arquivos consistentes'],
        actions: ['Siga o erro seguinte (ORA-01194/ORA-01152)'],
        playbooks: ['restore-database'],
    },
    'ORA-01152': {
        title: 'Arquivo não foi restaurado de um backup antigo o bastante',
        category: 'recovery', severity: 'high',
        meaning: 'A recuperação com controlfile de backup não alcança um ponto consistente com o arquivo restaurado.',
        causes: ['Controlfile mais antigo que os datafiles', 'Redo faltando'],
        actions: ['Aplique mais redo (inclusive os logs online) ou restaure de um backup consistente'],
        playbooks: ['incomplete-recovery', 'restore-database'],
    },
    'ORA-01190': {
        title: 'Arquivo de antes do último RESETLOGS',
        category: 'recovery', severity: 'high',
        meaning: 'Um datafile ou controlfile pertence a uma encarnação anterior do banco.',
        causes: ['Arquivo restaurado de backup anterior ao RESETLOGS'],
        actions: ['Restaure o arquivo de um backup da encarnação atual'],
        playbooks: ['datafile-restore'],
    },
    'ORA-01122': {
        title: 'Datafile falhou na verificação',
        category: 'media', severity: 'critical',
        meaning: 'O arquivo não confere com o controlfile (o erro seguinte diz o motivo: ORA-01200, ORA-01207...).',
        causes: ['Arquivo truncado', 'Controlfile antigo', 'Arquivo de outro banco'],
        actions: ['Siga o erro seguinte'],
        playbooks: ['datafile-restore', 'incomplete-recovery'],
    },
    'ORA-01200': {
        title: 'Datafile menor que o esperado (truncado)',
        category: 'media', severity: 'critical',
        meaning: 'O tamanho físico do arquivo é menor que o registrado: ele foi truncado (disco cheio durante extensão, cópia incompleta).',
        causes: ['Disco encheu durante AUTOEXTEND', 'Cópia/restauração incompleta'],
        actions: ['Restaure o arquivo do backup e recupere'],
        playbooks: ['datafile-restore'],
    },
    'ORA-01207': {
        title: 'Datafile mais novo que o controlfile',
        category: 'controlfile', severity: 'critical',
        meaning: 'O controlfile em uso é antigo (de backup ou cópia defasada) em relação aos datafiles.',
        causes: ['Controlfile restaurado de backup', 'Cópia de controlfile desatualizada'],
        actions: ['Recupere usando controlfile de backup (RECOVER ... USING BACKUP CONTROLFILE) e abra com RESETLOGS', 'Ou recrie o controlfile a partir do trace'],
        playbooks: ['incomplete-recovery', 'controlfile-restore'],
    },
    'ORA-01589': {
        title: 'É preciso abrir com RESETLOGS ou NORESETLOGS',
        category: 'recovery', severity: 'high',
        meaning: 'Depois de uma recuperação incompleta (ou com controlfile de backup) o banco precisa ser aberto com RESETLOGS.',
        causes: ['Recuperação incompleta concluída', 'Controlfile restaurado'],
        actions: ['ALTER DATABASE OPEN RESETLOGS e, em seguida, backup completo'],
        playbooks: ['open-resetlogs'],
    },
    'ORA-01139': {
        title: 'RESETLOGS só é válido após recuperação incompleta',
        category: 'recovery', severity: 'low',
        meaning: 'Não houve recuperação incompleta: abra o banco normalmente.',
        causes: ['OPEN RESETLOGS desnecessário'],
        actions: ['ALTER DATABASE OPEN'],
        playbooks: ['startup'],
    },
    'ORA-00308': {
        title: 'Archive log não encontrado',
        category: 'recovery', severity: 'high',
        meaning: 'A recuperação precisa de um archive log que não está no disco.',
        causes: ['Archive apagado sem backup', 'Archive só no backup (não restaurado)', 'Destino de archive diferente'],
        actions: ['Restaure o archive do backup (RMAN RESTORE ARCHIVELOG ...) e continue', 'Se ele não existe em lugar nenhum: recuperação incompleta até antes dele (perde as transações seguintes)'],
        playbooks: ['incomplete-recovery', 'restore-database'],
    },
    'ORA-00283': {
        title: 'Sessão de recuperação cancelada por erros',
        category: 'recovery', severity: 'high',
        meaning: 'A recuperação parou por causa do erro mostrado em seguida.',
        causes: ['Archive ausente, arquivo inconsistente ou corrompido'],
        actions: ['Trate o erro que vem logo depois'],
        playbooks: [],
    },
    'ORA-01124': {
        title: 'Datafile em uso — não pode ser recuperado',
        category: 'recovery', severity: 'medium',
        meaning: 'Para recuperar um datafile com o banco aberto ele precisa estar OFFLINE.',
        causes: ['Arquivo online durante RECOVER DATAFILE'],
        actions: ['Coloque o arquivo offline, recupere e coloque online (o procedimento do painel faz isso)'],
        playbooks: ['datafile-recover'],
    },
    'ORA-01145': {
        title: 'OFFLINE imediato não permitido sem ARCHIVELOG',
        category: 'recovery', severity: 'medium',
        meaning: 'Em NOARCHIVELOG não dá para colocar datafile offline com o banco aberto.',
        causes: ['Banco em NOARCHIVELOG'],
        actions: ['Faça a recuperação com o banco montado', 'Ative o ARCHIVELOG (tela Backup) para ter recuperação de mídia'],
        playbooks: ['crash-recovery'],
    },
    'ORA-00742': {
        title: 'Leitura do redo detectou gravação perdida (lost write)',
        category: 'redo', severity: 'critical',
        meaning: 'O conteúdo do redo log não corresponde ao esperado — típico de queda de energia com cache de escrita do storage sem bateria.',
        causes: ['Storage confirmou escrita que não aconteceu', 'Queda de energia'],
        actions: ['Recuperação incompleta até antes do log afetado e OPEN RESETLOGS', 'Envolva a Oracle (My Oracle Support) se dados críticos estiverem em jogo'],
        playbooks: ['incomplete-recovery'],
    },
    'ORA-10567': {
        title: 'Redo inconsistente com o bloco de dados',
        category: 'recovery', severity: 'critical',
        meaning: 'Durante a recuperação, o redo não "encaixa" num bloco (lost write). Acompanha ORA-00600 [3020].',
        causes: ['Gravação perdida no storage'],
        actions: ['Restaure o datafile afetado de um backup e recupere de novo'],
        playbooks: ['datafile-restore'],
    },
    'ORA-00264': {
        title: 'Nenhuma recuperação necessária',
        category: 'recovery', severity: 'info',
        meaning: 'Informativo: os arquivos já estão consistentes.',
        causes: [], actions: ['Abra o banco'], playbooks: ['startup'],
    },

    // ------------------------------------------------------------------ redo
    'ORA-00312': {
        title: 'Identificação do redo log online',
        category: 'redo', severity: 'info',
        meaning: 'Mensagem complementar: indica qual grupo/membro de redo log o erro anterior afeta.',
        causes: [], actions: ['Trate o erro que vem junto (ORA-00313, ORA-00321, ORA-00354...)'], playbooks: [],
    },
    'ORA-00313': {
        title: 'Falha ao abrir membros do grupo de redo',
        category: 'redo', severity: 'critical',
        meaning: 'O Oracle não conseguiu abrir um ou mais arquivos de um grupo de redo log online.',
        causes: ['Arquivo apagado/movido', 'Disco desmontado', 'Permissão'],
        actions: ['Se o grupo tem outro membro válido: recrie o membro perdido (sem impacto)', 'Se é o único membro de um grupo INATIVO: limpe o grupo (CLEAR LOGFILE)', 'Se é o grupo CORRENTE/ATIVO sem cópia: recuperação incompleta (perde as transações desse log)'],
        playbooks: ['redo-member', 'redo-clear', 'incomplete-recovery'],
    },
    'ORA-00321': {
        title: 'Não foi possível atualizar o cabeçalho do redo log',
        category: 'redo', severity: 'high',
        meaning: 'Falha de escrita no cabeçalho de um membro de redo.',
        causes: ['Disco com erro/cheio', 'Arquivo removido'],
        actions: ['Recrie o membro afetado', 'Verifique o disco'],
        playbooks: ['redo-member', 'redo-clear'],
    },
    'ORA-00353': {
        title: 'Corrupção no redo log',
        category: 'redo', severity: 'critical',
        meaning: 'Um bloco do redo log está corrompido.',
        causes: ['Falha de disco/storage', 'Queda de energia'],
        actions: ['Grupo INATIVO: CLEAR LOGFILE (e backup completo em seguida)', 'Grupo CORRENTE: recuperação incompleta'],
        playbooks: ['redo-clear', 'incomplete-recovery'],
    },
    'ORA-00354': {
        title: 'Cabeçalho de bloco de redo corrompido',
        category: 'redo', severity: 'critical',
        meaning: 'O redo log tem bloco com cabeçalho inválido.',
        causes: ['Falha de disco/storage', 'Queda de energia'],
        actions: ['Grupo INATIVO: CLEAR LOGFILE', 'Grupo CORRENTE: recuperação incompleta'],
        playbooks: ['redo-clear', 'incomplete-recovery'],
    },
    'ORA-00316': {
        title: 'Arquivo de redo com cabeçalho inválido',
        category: 'redo', severity: 'high',
        meaning: 'O arquivo no caminho do redo log não é um redo log válido.',
        causes: ['Arquivo sobrescrito', 'Caminho apontando para outro arquivo'],
        actions: ['Recrie o membro ou limpe o grupo'],
        playbooks: ['redo-member', 'redo-clear'],
    },
    'ORA-00314': {
        title: 'Sequência do redo log não confere',
        category: 'redo', severity: 'high',
        meaning: 'O membro de redo tem uma sequência diferente da esperada (arquivo antigo no lugar).',
        causes: ['Restauração de arquivo de redo antigo', 'Cópia de outra máquina'],
        actions: ['Recrie o membro se houver outro válido; senão, limpe o grupo/recuperação incompleta'],
        playbooks: ['redo-member', 'redo-clear', 'incomplete-recovery'],
    },
    'ORA-00327': {
        title: 'Redo log menor que o necessário',
        category: 'redo', severity: 'high',
        meaning: 'O arquivo de redo foi truncado.',
        causes: ['Disco cheio', 'Cópia incompleta'],
        actions: ['Recrie o membro ou limpe o grupo'],
        playbooks: ['redo-member', 'redo-clear'],
    },
    'ORA-00350': {
        title: 'Redo log precisa ser arquivado',
        category: 'redo', severity: 'medium',
        meaning: 'O grupo ainda não foi arquivado — não pode ser limpo/removido sem perder o archive.',
        causes: ['Archiver atrasado ou travado'],
        actions: ['Resolva o archiver (FRA) ou use CLEAR UNARCHIVED LOGFILE (e faça backup completo depois)'],
        playbooks: ['fra-free', 'redo-clear'],
    },

    // ------------------------------------------------------------------ archive / FRA
    'ORA-00257': {
        title: 'Archiver travado — somente conexões internas',
        category: 'archive', severity: 'critical',
        meaning: 'O ARCH não consegue gravar archive logs (quase sempre FRA ou disco cheio). Quando todos os grupos de redo enchem, o banco PARA de aceitar transações.',
        causes: ['FRA atingiu DB_RECOVERY_FILE_DEST_SIZE', 'Disco do destino de archive cheio', 'Sem rotina de backup/limpeza de archives'],
        actions: ['Libere espaço: aumente a FRA (imediato) ou apague archives já copiados', 'Configure a política de deleção e backup regular de archives (tela Backup)'],
        playbooks: ['fra-free'],
    },
    'ORA-16038': {
        title: 'Log não pode ser arquivado',
        category: 'archive', severity: 'critical',
        meaning: 'Um redo log não pôde ser arquivado (normalmente FRA cheia); acompanha ORA-19809/ORA-00312.',
        causes: ['FRA cheia', 'Destino de archive inválido'],
        actions: ['Libere a FRA'],
        playbooks: ['fra-free'],
    },
    'ORA-16014': {
        title: 'Log não arquivado — nenhum destino disponível',
        category: 'archive', severity: 'critical',
        meaning: 'Nenhum destino de archive aceitou o arquivo.',
        causes: ['FRA cheia', 'Destino com erro'],
        actions: ['Libere a FRA ou corrija o destino'],
        playbooks: ['fra-free'],
    },
    'ORA-19809': {
        title: 'Limite da FRA excedido',
        category: 'archive', severity: 'critical',
        meaning: 'A Fast Recovery Area atingiu o tamanho máximo configurado.',
        causes: ['Archives e backups acumulados', 'FRA subdimensionada'],
        actions: ['Aumente DB_RECOVERY_FILE_DEST_SIZE (se houver disco) ou apague obsoletos/archives já copiados'],
        playbooks: ['fra-free'],
    },
    'ORA-19815': {
        title: 'Aviso: FRA quase cheia',
        category: 'archive', severity: 'high',
        meaning: 'A FRA passou de 85%/97% do limite. Se encher, o banco para.',
        causes: ['Archives e backups acumulados'],
        actions: ['Libere espaço antes que encha'],
        playbooks: ['fra-free'],
    },
    'ORA-19804': {
        title: 'Não foi possível liberar espaço na FRA',
        category: 'archive', severity: 'critical',
        meaning: 'O Oracle tentou reciclar a FRA e não havia nada reaproveitável.',
        causes: ['Nenhum arquivo obsoleto/copiado na FRA'],
        actions: ['Aumente a FRA ou faça backup dos archives para outro destino'],
        playbooks: ['fra-free'],
    },
    'ORA-00255': {
        title: 'Erro ao arquivar log',
        category: 'archive', severity: 'high',
        meaning: 'Falha genérica do archiver (o erro seguinte diz o motivo).',
        causes: ['Destino cheio/inacessível'],
        actions: ['Veja o erro seguinte e o destino de archive'],
        playbooks: ['fra-free'],
    },
    'ORA-00270': {
        title: 'Erro ao criar o archive log',
        category: 'archive', severity: 'high',
        meaning: 'O archiver não conseguiu criar o arquivo no destino.',
        causes: ['Diretório inexistente', 'Permissão', 'Disco cheio'],
        actions: ['Confira o destino (LOG_ARCHIVE_DEST_n / FRA) e o espaço'],
        playbooks: ['fra-free'],
    },
    'ORA-19502': {
        title: 'Erro de escrita em arquivo',
        category: 'space', severity: 'high',
        meaning: 'Falha de escrita (o ORA-27072 seguinte traz o erro de I/O do SO).',
        causes: ['Disco cheio', 'Erro de I/O'],
        actions: ['Libere espaço no volume', 'Verifique o disco'],
        playbooks: ['fra-free'],
    },
    'ORA-27072': {
        title: 'Erro de I/O em arquivo',
        category: 'media', severity: 'high',
        meaning: 'O SO retornou erro de leitura/escrita.',
        causes: ['Disco cheio', 'Falha de hardware/storage'],
        actions: ['Verifique logs do SO e do storage', 'Libere espaço'],
        playbooks: [],
    },

    // ------------------------------------------------------------------ controlfile
    'ORA-00205': {
        title: 'Erro ao identificar o controlfile',
        category: 'controlfile', severity: 'critical',
        meaning: 'Na montagem, o Oracle não conseguiu abrir um ou mais controlfiles listados em CONTROL_FILES.',
        causes: ['Arquivo apagado/movido', 'Disco desmontado', 'Cópias divergentes'],
        actions: ['Se há outra cópia boa (multiplexada): copie-a sobre a ruim e abra', 'Sem cópia boa: restaure do autobackup e abra com RESETLOGS'],
        playbooks: ['controlfile-restore'],
    },
    'ORA-00202': {
        title: 'Identificação do controlfile',
        category: 'controlfile', severity: 'info',
        meaning: 'Mensagem complementar: indica qual controlfile o erro afeta.',
        causes: [], actions: ['Trate o erro que vem junto'], playbooks: [],
    },
    'ORA-00210': {
        title: 'Não foi possível abrir o controlfile',
        category: 'controlfile', severity: 'critical',
        meaning: 'O arquivo de controle especificado não abre.',
        causes: ['Arquivo ausente', 'Permissão'],
        actions: ['Restaure a partir da cópia boa ou do autobackup'],
        playbooks: ['controlfile-restore'],
    },
    'ORA-00214': {
        title: 'Cópias do controlfile inconsistentes',
        category: 'controlfile', severity: 'critical',
        meaning: 'As cópias multiplexadas do controlfile têm versões diferentes.',
        causes: ['Uma cópia foi restaurada/substituída', 'Falha de escrita numa das cópias'],
        actions: ['Copie a cópia mais recente sobre as outras'],
        playbooks: ['controlfile-restore'],
    },
    'ORA-00227': {
        title: 'Bloco corrompido no controlfile',
        category: 'controlfile', severity: 'critical',
        meaning: 'Um bloco do controlfile está corrompido.',
        causes: ['Falha de disco/storage'],
        actions: ['Use a cópia boa ou restaure do autobackup'],
        playbooks: ['controlfile-restore'],
    },

    // ------------------------------------------------------------------ corrupção de blocos / objetos
    'ORA-01578': {
        title: 'Bloco de dados corrompido',
        category: 'corruption', severity: 'critical',
        meaning: 'O Oracle leu um bloco cuja verificação de integridade falhou. Só os objetos que usam esse bloco são afetados — o restante do banco funciona.',
        causes: ['Falha de disco/controladora/storage', 'Queda de energia com cache de escrita sem bateria', 'Carga NOLOGGING seguida de restore'],
        actions: ['Identifique o objeto (o painel mostra) — se for ÍNDICE, basta reconstruí-lo', 'Com backup + ARCHIVELOG (Enterprise Edition): recupere só os blocos, sem parar o banco', 'Sem backup: DBMS_REPAIR marca/pula os blocos (perde as linhas desses blocos)', 'Investigue o storage (logs do SO)'],
        playbooks: ['block-recover', 'index-rebuild', 'datafile-restore'],
    },
    'ORA-01499': {
        title: 'Inconsistência entre tabela e índice',
        category: 'corruption', severity: 'high',
        meaning: 'O ANALYZE ... VALIDATE STRUCTURE encontrou linhas da tabela sem entrada no índice (ou o contrário).',
        causes: ['Índice corrompido', 'Bug'],
        actions: ['Reconstrua o índice (REBUILD ONLINE lê a tabela)'],
        playbooks: ['index-rebuild'],
    },
    'ORA-08102': {
        title: 'Chave de índice não encontrada',
        category: 'corruption', severity: 'high',
        meaning: 'O índice não tem a entrada esperada para a linha (índice inconsistente com a tabela).',
        causes: ['Índice corrompido'],
        actions: ['Reconstrua o índice'],
        playbooks: ['index-rebuild'],
    },
    'ORA-08103': {
        title: 'Objeto não existe mais',
        category: 'corruption', severity: 'medium',
        meaning: 'O segmento lido não pertence mais ao objeto: DROP/TRUNCATE concorrente ou corrupção do cabeçalho do segmento.',
        causes: ['TRUNCATE/DROP durante a leitura', 'Corrupção de bloco de cabeçalho'],
        actions: ['Se repetir sem DDL concorrente, valide o objeto e recupere os blocos'],
        playbooks: ['block-recover'],
    },
    'ORA-01410': {
        title: 'ROWID inválido',
        category: 'corruption', severity: 'medium',
        meaning: 'Um índice aponta para um ROWID que não existe na tabela.',
        causes: ['Índice corrompido/inconsistente'],
        actions: ['Reconstrua os índices da tabela'],
        playbooks: ['index-rebuild'],
    },
    'ORA-26040': {
        title: 'Bloco carregado com NOLOGGING',
        category: 'corruption', severity: 'high',
        meaning: 'O bloco foi gravado sem redo (NOLOGGING) e depois o arquivo foi restaurado: o conteúdo não pôde ser reconstruído.',
        causes: ['Carga direta/índice NOLOGGING antes do backup usado no restore'],
        actions: ['Recarregue os dados ou reconstrua o objeto afetado', 'Ative FORCE LOGGING para evitar que se repita'],
        playbooks: ['index-rebuild'],
    },

    // ------------------------------------------------------------------ undo / espaço
    'ORA-01555': {
        title: 'Snapshot muito antigo',
        category: 'undo', severity: 'low',
        meaning: 'Uma consulta longa precisou de dados de undo que já foram reaproveitados. Não é corrupção.',
        causes: ['UNDO_RETENTION baixo', 'Tablespace de undo pequena', 'Commit dentro de loop em cursor aberto'],
        actions: ['Aumente UNDO_RETENTION e o tamanho do undo', 'Revise a consulta/rotina'],
        playbooks: [],
    },
    'ORA-30036': {
        title: 'Undo sem espaço',
        category: 'undo', severity: 'high',
        meaning: 'A tablespace de undo não consegue crescer.',
        causes: ['Undo sem AUTOEXTEND ou disco cheio', 'Transação gigante'],
        actions: ['Adicione espaço à tablespace de undo'],
        playbooks: [], link: STORAGE_LINK,
    },
    'ORA-01552': {
        title: 'Rollback segment de sistema usado indevidamente',
        category: 'undo', severity: 'high',
        meaning: 'Sem tablespace de undo utilizável, o Oracle só tem o rollback segment SYSTEM.',
        causes: ['UNDO_TABLESPACE inexistente/offline', 'UNDO_MANAGEMENT=MANUAL'],
        actions: ['Crie uma nova tablespace de undo e aponte UNDO_TABLESPACE para ela'],
        playbooks: ['undo-recreate'],
    },
    'ORA-01652': {
        title: 'Não foi possível estender o segmento temporário',
        category: 'space', severity: 'medium',
        meaning: 'A tablespace TEMP (ou a do objeto em criação) não tem espaço para a operação.',
        causes: ['Ordenação/hash muito grande', 'TEMP pequena'],
        actions: ['Aumente a TEMP (adicione tempfile) ou revise o SQL'],
        playbooks: ['temp-recreate'], link: STORAGE_LINK,
    },
    'ORA-01653': {
        title: 'Tabela sem espaço para crescer',
        category: 'space', severity: 'high',
        meaning: 'A tablespace não tem espaço para um novo extent da tabela.',
        causes: ['Datafiles cheios e sem AUTOEXTEND', 'Disco cheio'],
        actions: ['Adicione um datafile (tela Storage) ou aumente um existente'],
        playbooks: [], link: STORAGE_LINK,
    },
    'ORA-01654': {
        title: 'Índice sem espaço para crescer',
        category: 'space', severity: 'high',
        meaning: 'A tablespace não tem espaço para um novo extent do índice.',
        causes: ['Datafiles cheios'],
        actions: ['Adicione um datafile (tela Storage)'],
        playbooks: [], link: STORAGE_LINK,
    },
    'ORA-01688': {
        title: 'Partição sem espaço para crescer',
        category: 'space', severity: 'high',
        meaning: 'A tablespace não tem espaço para a partição.',
        causes: ['Datafiles cheios'],
        actions: ['Adicione um datafile (tela Storage)'],
        playbooks: [], link: STORAGE_LINK,
    },
    'ORA-01691': {
        title: 'LOB sem espaço para crescer',
        category: 'space', severity: 'high',
        meaning: 'A tablespace não tem espaço para o segmento LOB.',
        causes: ['Datafiles cheios'],
        actions: ['Adicione um datafile (tela Storage)'],
        playbooks: [], link: STORAGE_LINK,
    },
};

/** Primeiro argumento do ORA-00600 → tratamento específico. */
const ORA600_ARGS = [
    {
        re: /^kcratr_(scan_lastbwr|nab_less_than_odr)$/i,
        title: 'Recuperação de instância falhou após queda',
        category: 'media', severity: 'critical',
        meaning: 'A recuperação automática da instância (crash recovery) não conseguiu concluir — clássico depois de queda de energia ou travamento do storage. Os arquivos estão bons; falta aplicar o redo como recuperação de MÍDIA.',
        causes: ['Queda de energia/reset do servidor', 'Storage com cache de escrita perdido'],
        actions: ['STARTUP MOUNT → RECOVER DATABASE → ALTER DATABASE OPEN (sem perda de dados quando os redo logs estão íntegros)'],
        playbooks: ['crash-recovery'],
    },
    {
        re: /^kccpb_sanity_check_2$/i,
        title: 'Controlfile inconsistente após queda',
        category: 'controlfile', severity: 'critical',
        meaning: 'A sequência registrada no controlfile não confere (gravação perdida na queda).',
        causes: ['Queda de energia durante escrita do controlfile'],
        actions: ['Use outra cópia multiplexada do controlfile, ou restaure do autobackup', 'Alternativa: recriar o controlfile a partir do trace (CREATE CONTROLFILE)'],
        playbooks: ['controlfile-restore'],
    },
    {
        re: /^(4194|4193|4137|4097|4000)$/,
        title: 'Corrupção no undo',
        category: 'undo', severity: 'critical',
        meaning: 'O undo não confere com o redo/bloco (corrupção em segmento de undo). Se o banco abrir, recriar a tablespace de undo resolve; se derruba a abertura, exige undo manual (com a Oracle).',
        causes: ['Queda de energia', 'Gravação perdida no storage'],
        actions: ['Com o banco aberto: crie um novo UNDO, aponte UNDO_TABLESPACE para ele e remova o antigo', 'Se impede a abertura: UNDO_MANAGEMENT=MANUAL temporário — procedimento assistido pela Oracle'],
        playbooks: ['undo-recreate'],
    },
    {
        re: /^(kdsgrp1|13013|6006|6033|12700|qertbFetchByRowID|kdifind:kcbz_objdchk|6101)$/i,
        title: 'Inconsistência entre tabela e índice',
        category: 'corruption', severity: 'high',
        meaning: 'Um índice aponta para linhas que não batem com a tabela (corrupção lógica de índice).',
        causes: ['Índice corrompido', 'Bug'],
        actions: ['Identifique o objeto no trace e reconstrua o índice (REBUILD ONLINE lê a tabela)', 'Valide a tabela: ANALYZE TABLE ... VALIDATE STRUCTURE CASCADE ONLINE'],
        playbooks: ['index-rebuild', 'block-recover'],
    },
    {
        re: /^(ktbair2|kddummy_blkchk|kcbz_check_objd_typ|25027|kdBlkCheckError|ktspscan_bmb)$/i,
        title: 'Bloco corrompido detectado',
        category: 'corruption', severity: 'high',
        meaning: 'Verificação interna encontrou um bloco inválido.',
        causes: ['Falha de storage', 'Queda de energia'],
        actions: ['Valide os datafiles (RMAN VALIDATE) e recupere os blocos'],
        playbooks: ['block-recover'],
    },
    {
        re: /^3020$/,
        title: 'Recuperação travada (redo não confere com o bloco)',
        category: 'recovery', severity: 'critical',
        meaning: 'Durante a recuperação o redo não pôde ser aplicado a um bloco (lost write).',
        causes: ['Gravação perdida no storage'],
        actions: ['Restaure o datafile afetado do backup e recupere novamente'],
        playbooks: ['datafile-restore'],
    },
    {
        re: /^(2662|2663)$/,
        title: 'SCN de bloco à frente do banco',
        category: 'recovery', severity: 'critical',
        meaning: 'Um bloco tem SCN maior que o do banco — típico após abertura forçada (_allow_resetlogs_corruption) ou recuperação inconsistente.',
        causes: ['Abertura forçada após recuperação incompleta', 'Arquivos de pontos diferentes no tempo'],
        actions: ['O caminho seguro é restaurar de backup consistente', 'Ajuste de SCN só com a Oracle (My Oracle Support)'],
        playbooks: ['restore-database'],
    },
    {
        re: /^(17182|17114|17113|kghfrempty|kghalo)$/i,
        title: 'Corrupção de memória (heap)',
        category: 'memory', severity: 'high',
        meaning: 'Estrutura de memória interna corrompida — não afeta os arquivos de dados.',
        causes: ['Bug do Oracle', 'Memória física com defeito'],
        actions: ['Reinicie a instância se a falha se repetir', 'Aplique o último Release Update'],
        playbooks: [],
    },
    {
        re: /^729$/,
        title: 'Vazamento de memória de sessão (UGA)',
        category: 'memory', severity: 'low',
        meaning: 'Detectado ao encerrar sessão — normalmente benigno.',
        causes: ['Bug conhecido'],
        actions: ['Aplique patches; não exige ação imediata'],
        playbooks: [],
    },
];

/** Códigos que aparecem durante uma recuperação NORMAL (não são erro). */
const BENIGN_RECOVERY = ['ORA-00279', 'ORA-00289', 'ORA-00280', 'ORA-00278'];

/**
 * Mensagens COMPLEMENTARES: só identificam o objeto ou trazem o erro do SO de
 * um erro principal registrado junto (ORA-01157 + ORA-01110 + ORA-27037...).
 * Não viram problema próprio — aparecem nas evidências do principal.
 */
const COMPANIONS = ['ORA-01110', 'ORA-00312', 'ORA-00202', 'ORA-27037', 'ORA-27041', 'ORA-27072', 'ORA-27301', 'ORA-27302', 'ORA-06512', 'ORA-00283'];

/** Frases (não códigos) que o usuário pode colar na consulta. */
const PHRASES = [
    {
        re: /recover\s+database\s+until\s+cancel/i,
        code: 'RECOVER UNTIL CANCEL',
        title: 'Recuperação incompleta (RECOVER DATABASE UNTIL CANCEL)',
        category: 'recovery', severity: 'high',
        meaning: 'Aplica os archive logs disponíveis um a um até você cancelar, e o banco é aberto com RESETLOGS. Usado quando um redo log (ou archive) foi perdido e não há como fazer a recuperação completa. As transações que estavam só no log perdido são PERDIDAS.',
        causes: ['Grupo de redo CORRENTE perdido/corrompido', 'Archive necessário inexistente', 'Controlfile restaurado de backup'],
        actions: ['Proteja antes o controlfile atual (cópia)', 'STARTUP MOUNT → RECOVER DATABASE UNTIL CANCEL [USING BACKUP CONTROLFILE] → AUTO → CANCEL → ALTER DATABASE OPEN RESETLOGS', 'Faça backup completo logo após o RESETLOGS'],
        playbooks: ['incomplete-recovery'],
    },
    {
        re: /open\s+resetlogs/i,
        code: 'OPEN RESETLOGS',
        title: 'Abertura com RESETLOGS',
        category: 'recovery', severity: 'high',
        meaning: 'Abre o banco iniciando uma nova encarnação (sequência de logs volta a 1). Necessário após recuperação incompleta ou com controlfile de backup. Backups anteriores continuam utilizáveis no RMAN, mas faça um backup completo em seguida.',
        causes: [], actions: ['ALTER DATABASE OPEN RESETLOGS', 'Backup completo logo depois'],
        playbooks: ['open-resetlogs'],
    },
    {
        re: /\brecover\s+(database|datafile)\b/i,
        code: 'RECOVER',
        title: 'Recuperação de mídia (RECOVER)',
        category: 'media', severity: 'medium',
        meaning: 'Aplica redo (archives e logs online) a datafiles atrasados para torná-los consistentes. Completa = sem perda de dados.',
        causes: [], actions: ['RECOVER DATABASE (banco montado) ou RECOVER DATAFILE n (arquivo offline)'],
        playbooks: ['crash-recovery', 'datafile-recover'],
    },
    {
        re: /corrup|corromp/i,
        code: 'CORRUPÇÃO',
        title: 'Suspeita de corrupção',
        category: 'corruption', severity: 'high',
        meaning: 'Para confirmar e localizar corrupção física/lógica, valide os datafiles com o RMAN (não para o banco). Blocos encontrados aparecem em V$DATABASE_BLOCK_CORRUPTION.',
        causes: [], actions: ['RMAN: BACKUP VALIDATE CHECK LOGICAL DATABASE', 'Depois: RECOVER CORRUPTION LIST (Enterprise) ou reconstrução do objeto'],
        playbooks: ['block-recover'],
    },
];

const RMAN_ERRORS = {
    'RMAN-06054': {
        title: 'Recuperação pediu um archive desconhecido',
        category: 'recovery', severity: 'high',
        meaning: 'O RMAN aplicou todo o redo que conhecia e precisa de um archive que não está catalogado nem no disco. Em recuperação com controlfile de backup, é o ponto normal de parada: abra com RESETLOGS.',
        causes: ['Fim do redo disponível', 'Archive perdido'],
        actions: ['Se o log pedido existe em outro lugar: CATALOG e continue', 'Senão: ALTER DATABASE OPEN RESETLOGS (perde o que estava depois)'],
        playbooks: ['open-resetlogs', 'incomplete-recovery'],
    },
    'RMAN-06023': {
        title: 'Nenhum backup encontrado para restaurar',
        category: 'recovery', severity: 'critical',
        meaning: 'O RMAN não encontrou backup (ou cópia) do arquivo pedido no catálogo/controlfile.',
        causes: ['Sem backup', 'Backups expirados/apagados', 'Controlfile sem o registro do backup'],
        actions: ['Catalogue os backups existentes (CATALOG START WITH ...)', 'Sem backup: não há restauração possível — avalie DBMS_REPAIR/exportar o que for legível'],
        playbooks: [],
    },
    'RMAN-06026': {
        title: 'Alguns alvos não encontrados — restore abortado',
        category: 'recovery', severity: 'critical',
        meaning: 'Faltam backups para parte do que foi pedido.',
        causes: ['Backups incompletos/expirados'],
        actions: ['Verifique com LIST BACKUP; catalogue peças fora do lugar'],
        playbooks: [],
    },
    'RMAN-06059': {
        title: 'Archive esperado não encontrado',
        category: 'archive', severity: 'high',
        meaning: 'O RMAN espera um archive que foi apagado fora dele.',
        causes: ['Archives apagados pelo SO'],
        actions: ['CROSSCHECK ARCHIVELOG ALL e DELETE EXPIRED ARCHIVELOG ALL; depois faça backup completo'],
        playbooks: ['fra-free'],
    },
    'RMAN-05009': {
        title: 'Recuperação de blocos exige Enterprise Edition',
        category: 'corruption', severity: 'medium',
        meaning: 'Block media recovery não está disponível na Standard Edition.',
        causes: ['Banco Standard Edition'],
        actions: ['Restaure e recupere o datafile inteiro, ou reconstrua o objeto afetado'],
        playbooks: ['datafile-restore', 'index-rebuild'],
    },
};

// ==========================================================================
// Consulta
// ==========================================================================

/** Normaliza "ORA-1578", "ora-01578", "TNS-12541" → "ORA-01578"/"ORA-12541". */
function normalizeCode(prefix, digits) {
    const p = String(prefix).toUpperCase();
    const n = String(parseInt(digits, 10));
    if (p === 'RMAN') return `RMAN-${n.padStart(5, '0')}`;
    return `ORA-${n.padStart(5, '0')}`;
}

/** Primeiro argumento de um ORA-00600/ORA-07445 (texto do alert log ou do problem key). */
function firstArg(text, code) {
    const num = code === 'ORA-07445' ? '7445' : '600';
    const re = new RegExp(`ORA[- ]0*${num}\\b[^\\[\\n]*\\[([^\\]\\n]*)\\]`, 'i');
    const m = re.exec(String(text || ''));
    return m ? m[1].trim() : null;
}

/**
 * Entrada da base para um código (e argumento, no caso de ORA-00600).
 * @returns {object|null} { code, arg, title, category, categoryLabel, severity, meaning, causes, actions, playbooks, link? }
 */
function lookup(code, arg = null) {
    const base = ERRORS[code] || RMAN_ERRORS[code];
    if (!base) return null;
    let entry = { ...base };
    if (code === 'ORA-00600' && arg) {
        const specific = ORA600_ARGS.find((a) => a.re.test(arg));
        if (specific) {
            const { re, ...rest } = specific;
            entry = { ...entry, ...rest, generic: false };
        } else {
            entry.generic = true;
        }
    }
    return {
        code, arg: arg || null,
        ...entry,
        categoryLabel: CATEGORIES[entry.category] || entry.category,
        playbooks: entry.playbooks || [],
        causes: entry.causes || [],
        actions: entry.actions || [],
    };
}

/**
 * Extrai todos os códigos (com argumento do 600/7445) e frases de um texto livre.
 * @returns {Array<{code, arg, known, entry}>}
 */
function analyzeText(text) {
    const s = String(text || '').slice(0, 20000);
    const found = new Map();
    const re = /\b(ORA|TNS|RMAN)[- ](\d{1,5})\b/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
        const code = normalizeCode(m[1], m[2]);
        let arg = null;
        if (code === 'ORA-00600' || code === 'ORA-07445') arg = firstArg(s.slice(m.index, m.index + 400), code);
        const key = `${code}|${arg || ''}`;
        if (!found.has(key)) found.set(key, { code, arg, entry: lookup(code, arg) });
    }
    for (const p of PHRASES) {
        if (p.re.test(s) && ![...found.values()].some((f) => f.code === p.code)) {
            const { re: _re, ...rest } = p;
            found.set(p.code, { code: p.code, arg: null, entry: { ...rest, categoryLabel: CATEGORIES[p.category], causes: p.causes || [], actions: p.actions || [], playbooks: p.playbooks || [] } });
            break; // a frase mais específica basta (a ordem de PHRASES vai da mais específica à mais geral)
        }
    }
    return [...found.values()].map((f) => ({ ...f, known: !!f.entry }));
}

function isBenignRecoveryCode(code) {
    return BENIGN_RECOVERY.includes(code);
}

module.exports = {
    CATEGORIES,
    ERRORS,
    ORA600_ARGS,
    RMAN_ERRORS,
    PHRASES,
    BENIGN_RECOVERY,
    COMPANIONS,
    normalizeCode,
    firstArg,
    lookup,
    analyzeText,
    isBenignRecoveryCode,
};

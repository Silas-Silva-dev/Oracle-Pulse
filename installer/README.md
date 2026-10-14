# Instalador Windows do Oracle Pulse

`OraclePulse-Setup-<versão>.exe` instala o Oracle Pulse num servidor Windows como **serviço do Windows**, sem precisar de Node.js, npm ou PM2 na máquina.

## Requisitos

- Windows 10 1607+ ou Windows Server 2016+ (64 bits).
- Executar como **Administrador**.
- Windows Server 2012 R2 **não é suportado**: o Node.js 24 incluído exige Windows 10 ou Server 2016.

## O que o instalador faz

1. Copia a aplicação e um **Node.js 24 LTS portátil** (`runtime\node.exe`) para a pasta escolhida (padrão: `C:\Program Files\OraclePulse`).
2. Pede os dados do `.env` nas telas do assistente:
   - **Banco de dados Oracle** (obrigatório): host, porta, service name, usuário e senha. Também é possível escolher o modo DEMO.
   - **Acesso ao painel** (obrigatório): porta HTTP, usuário e senha do DBA e, opcionalmente, uma conta somente leitura.
   - **SSH** (opcional): para ler disco e memória e executar RMAN quando o banco roda em outra máquina.
   - **Oracle Client e RMAN** (opcional): `ORACLE_CLIENT_PATH` (vazio = modo THIN), `ORACLE_HOME`, `ORACLE_SID`, senha do SYS, alias TNS e destino da FRA.
3. **Valida tudo antes de instalar**, com o mesmo código que grava o arquivo. Senhas com `#`, espaços, aspas ou `$` são gravadas de forma que o `dotenv` as leia exatamente iguais.
4. Grava o `.env`:
   - a senha do painel vai como hash scrypt, nunca em texto puro;
   - o arquivo fica com acesso restrito a **Administradores e SYSTEM**.
5. Registra o serviço **`OraclePulse`** (WinSW):
   - início automático (atrasado);
   - roda como LocalSystem;
   - reinicia sozinho em caso de falha (após 10 s, 30 s e 60 s).
6. Libera a porta no Firewall do Windows (tarefa opcional, marcada por padrão).
7. Inicia o serviço, confere se o painel responde e **testa a conexão com o Oracle**. Se o teste falhar, o instalador mostra o motivo e uma orientação, e o serviço continua tentando conectar.

## Atualizar ou reconfigurar

Execute o instalador de uma versão nova (ou o mesmo) por cima da instalação existente:

- **Manter a configuração atual** (padrão): o `.env` não é tocado. O serviço é parado, os arquivos são atualizados e o serviço é iniciado de novo.
- **Revisar e alterar a configuração**:
  - os campos vêm preenchidos com os valores atuais;
  - senhas deixadas em branco são mantidas;
  - é criada uma cópia `.env.bak-AAAAMMDD-HHMMSS` antes de gravar;
  - configurações extras que você tenha adicionado ao `.env` são preservadas.

## Senha de instalação (obrigatória)

A instalação é protegida por uma **senha que muda todo dia**, gerada pelo aplicativo
**"Oracle Pulse"** (`SenhaOraclePulse.exe`, na pasta `Arquivos`): um ícone na bandeja
do Windows; clique em **Oracle Pulse** e a senha do dia vai para a área de transferência.

- **Instalação normal:** o assistente pede a senha logo após a tela de boas-vindas.
- **Instalação silenciosa:** passe `/INSTALLPWD="senha-do-dia"` (ver abaixo).
- Vale a senha de **hoje** (aceita também ontem/amanhã, para fuso/virada de dia).
- Sem a senha certa, o instalador **não instala nada** e termina com código diferente de 0.

> A senha é um **controle de acesso à instalação** (evita instalações/cópias sem a
> senha do dia), não uma criptografia do produto. Para regerar o gerador ou mudar o
> segredo, veja `installer/generator/` (o mesmo algoritmo está no instalador e nos
> testes — `test/installPassword.test.js`).

## Instalação silenciosa (sem telas)

```bat
OraclePulse-Setup-2.0.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /INSTALLPWD="SENHA-DO-DIA" ^
  /LOG="C:\temp\oraclepulse-setup.log" ^
  /DBHOST=192.168.0.10 /DBSERVICE=orcl /DBUSER=monitor /DBPASSWORD="Senha#123" /AUTHPASSWORD="SenhaDoPainel"
```

| Parâmetro | Campo do `.env` | Padrão |
|---|---|---|
| `/INSTALLPWD=` | **senha do dia** (obrigatória) — gerada pelo app "Oracle Pulse" | |
| `/PORT=` | `PORT` | `3000` |
| `/DEMO=1` | `DEMO_MODE=true` | `0` |
| `/DBHOST=` `/DBPORT=` `/DBSERVICE=` | `DB_HOST`, `DB_PORT`, `DB_SERVICE` | porta `1521` |
| `/DBUSER=` `/DBPASSWORD=` | `DB_USER`, `DB_PASSWORD` | |
| `/AUTHUSER=` `/AUTHPASSWORD=` | `AUTH_USER`, `AUTH_PASS_HASH` (gera o hash) | usuário `DBA` |
| `/VIEWERUSER=` `/VIEWERPASSWORD=` | `AUTH_VIEWER_USER`, `AUTH_VIEWER_PASS_HASH` | |
| `/SSHHOST=` `/SSHPORT=` `/SSHUSER=` `/SSHPASSWORD=` `/SSHKEY=` | `SSH_*` | porta `22` |
| `/ORACLECLIENT=` | `ORACLE_CLIENT_PATH` | vazio (THIN) |
| `/ORACLEHOME=` `/ORACLESID=` `/OSUSER=` | `DB_ORACLE_HOME`, `DB_ORACLE_SID`, `DB_OS_USER` | |
| `/SYSUSER=` `/SYSPASSWORD=` `/TNSALIAS=` `/FRADEST=` | `DB_SYS_USER`, `DB_SYS_PASSWORD`, `DB_TNS_ALIAS`, `DB_FRA_DEST` | usuário `sys` |
| `/KEEPCONFIG=0` | revisar o `.env` existente com os parâmetros acima | `1` (manter) |
| `/TASKS="firewall"` ou `/TASKS=""` | liberar ou não a porta no firewall | liberar |
| `/SKIPDBTEST=1` | não testar a conexão com o Oracle ao final | testa |
| `/DIR="C:\OraclePulse"` | pasta de instalação | `C:\Program Files\OraclePulse` |

Valores com espaço vão entre aspas. Se algum dado obrigatório faltar ou for inválido, o instalador termina com código diferente de 0 **sem alterar nada**. O motivo fica no arquivo de `/LOG`.

## Onde ficam as coisas

| Item | Local |
|---|---|
| Configuração | `<pasta>\.env` (editar como Administrador e reiniciar o serviço) |
| Logs da aplicação | `<pasta>\logs\OraclePulse.out.log` e `OraclePulse.err.log` (rotação de 10 MB × 8) |
| Auditoria | `<pasta>\logs\audit.log` |
| Resultado da última instalação | `<pasta>\logs\install-status.txt` |
| Serviço | `OraclePulse` (`services.msc`, `net stop OraclePulse`, `net start OraclePulse`) |
| Atalhos | Menu Iniciar → Oracle Pulse (abrir o painel, pasta de logs, desinstalar) |
| Backups agendados | Agendador de Tarefas → pasta `\OraclePulse\` (rodam como SYSTEM com o `node.exe` do pacote; criados em Backup → Proteção automática da FRA) |
| Logs dos backups agendados | `<pasta>\logs\backup\` (guardados por 30 dias) |

> **RMAN com o banco nesta mesma máquina:** o serviço roda como LocalSystem e usa o PATH do sistema para achar `rman.exe` e `sqlplus.exe`.
> - Configure `DB_SYS_PASSWORD` e, se necessário, `DB_TNS_ALIAS`.
> - Se preferir que o serviço rode com a conta do DBA, altere em `services.msc` → OraclePulse → Fazer logon.

## Desinstalar

Use Painel de Controle → Programas, ou o atalho do Menu Iniciar:

- o serviço, a regra de firewall, as tarefas agendadas de backup (`\OraclePulse\`) e os arquivos do programa são removidos;
- o instalador pergunta se também deve remover o `.env` e os logs;
- na desinstalação silenciosa, eles são mantidos, a menos que se use `/REMOVEDATA=1`.

## Gerar o instalador (desenvolvimento)

```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1
```

O script:

1. Baixa, conferindo o SHA-256, o Node.js portátil e o WinSW. Se não houver Inno Setup 6.3+ na máquina, baixa também o Inno Setup portátil. Tudo fica em `installer\.cache`.
2. Monta `installer\build\app` com os arquivos do projeto que o git enxerga: os versionados e os novos ainda não versionados, com um aviso. O que o `.gitignore` exclui (`.env`, logs, `node_modules` locais) nunca entra no pacote.
3. Roda `npm ci --omit=dev` com o Node empacotado.
4. Executa os testes.
5. Gera `installer\dist\OraclePulse-Setup-<versão>.exe`. A versão vem do `package.json`.

## Publicar uma nova versão (Release) — atualização automática

A tela **Sobre** dos painéis instalados verifica e baixa atualizações a partir das
**Releases** do GitHub. Cada versão nova precisa de uma Release com:

- a **tag** `vX.Y.Z` (igual à versão do `package.json`);
- o **instalador** `OraclePulse-Setup-X.Y.Z.exe` anexado;
- nas **notas**, uma linha `SHA-256: <hash>` (o painel confere a integridade do download).

### Jeito simples — um comando

```powershell
# sobe a versão para 2.3.1, compila, cria a tag, publica a Release e anexa o .exe
powershell -ExecutionPolicy Bypass -File installer\release.ps1 -Version 2.3.1
```

O `release.ps1` faz tudo: muda a versão e faz commit, compila, calcula o SHA-256,
cria e envia a tag, e publica a Release com o instalador anexado e o SHA nas notas.
Para publicar a Release ele usa, nesta ordem:

1. **GitHub CLI (`gh`)** se estiver instalado e logado (`winget install GitHub.cli` e `gh auth login`) — nada mais é preciso; ou
2. **um token**: `$env:GITHUB_TOKEN = "ghp_..."` (Personal Access Token com permissão de escrita no repositório), ou `-Token`; ou
3. se não houver nenhum, ele para depois de criar a tag e mostra o passo manual (link + arquivo + SHA para colar).

Parâmetros úteis: `-SkipBuild` (usa o `.exe` já gerado), `-Draft` (rascunho), `-Notes "texto"`.

### Jeito manual (sem script)

1. `powershell -ExecutionPolicy Bypass -File installer\build.ps1` e anote o SHA-256 que ele imprime.
2. No GitHub: **Releases → Draft a new release**, tag `vX.Y.Z` (cria na hora).
3. Anexe `installer\dist\OraclePulse-Setup-X.Y.Z.exe` e cole `SHA-256: <hash>` nas notas.
4. **Publish release**. Pronto — os painéis passam a oferecer a atualização.

| Arquivo | Função |
|---|---|
| `release.ps1` | Publica uma Release no GitHub (tag + instalador + SHA-256) num comando — ver acima |
| `OraclePulse.iss` | Script do Inno Setup (telas, validação, serviço, firewall, desinstalação) |
| `support\configure-env.js` | Grava e valida o `.env`, gera o hash da senha e testa a conexão com o Oracle |
| `support\OraclePulse.xml` | Configuração do serviço WinSW |
| `support\brand\icon-defs.svg` | Fonte vetorial do ícone Oracle Pulse (três níveis de detalhe: 16–24 px, 32 px e 40 px ou mais) |
| `support\brand\make-logo-wide.ps1` | Gera `public\logo-wide.png` (logo recortado, fundo transparente, sem o ruído do `logo.png`) usado na barra lateral e no login |
| `support\brand\make-brand-assets.ps1` | Regenera `OraclePulse.ico`, `wizard-*.png`, `public\favicon.ico` e `public\favicon.png` a partir do SVG (usa o Edge em modo headless). Rode após mudar o desenho; não faz parte do build. |
| `tests\*.test.js` | Gerador do `.env` (inclui fuzz contra o parser do `dotenv`) e smoke test do app empacotado |
| `tests\wizard-screens.ps1` | Percorre o assistente e captura as telas (build `-Preview`, não instala nada) |
| `tests\e2e-install.ps1` | Ponta a ponta como Administrador: instala, atualiza, reconfigura, testa entrada inválida e desinstala |
| `tests\e2e-gui.ps1` | Instalação interativa real até a tela final, depois desinstala |

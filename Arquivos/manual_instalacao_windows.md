# Manual de Instalação - Oracle Pulse (Windows)

## Instalação automática (recomendado)

Execute `OraclePulse-Setup-<versão>.exe` como **Administrador**. O instalador:

- já inclui o Node.js;
- pede os dados obrigatórios do `.env` (banco Oracle e senha do painel);
- registra o serviço do Windows **OraclePulse** (início automático, sem PM2);
- libera a porta no firewall;
- testa a conexão com o Oracle ao final.

Para atualizar, execute a versão nova por cima: a configuração existente é mantida. Detalhes, instalação silenciosa e como gerar o instalador estão em [installer/README.md](../installer/README.md).

## Instalação manual

Este guia detalha o passo a passo para instalar e configurar o **Oracle Pulse**, sistema de monitoramento de banco de dados, em ambiente Windows. A aplicação é composta por um servidor Node.js (Express) que serve tanto a API de monitoramento quanto a interface estática.

## 1. Instalar o Node.js
1. Acesse o site oficial do Node.js: [https://nodejs.org/](https://nodejs.org/)
2. Baixe o instalador da versão **LTS** (Long Term Support).
3. Execute o instalador e mantenha as opções padrão (certifique-se de que a opção "Add to PATH" está marcada).
4. Para verificar, abra o **Prompt de Comando (cmd)** e digite:
   ```cmd
   node -v
   npm -v
   ```

## 2. Instalar o Oracle Instant Client (Opcional, para modo THICK)
O sistema utiliza a biblioteca `oracledb`. Por padrão ela tenta rodar em modo "Thin" (sem precisar de cliente instalado). No entanto, o sistema tenta carregar o cliente para recursos avançados.
1. Se necessário, baixe o **Oracle Instant Client (64-bit)** do site da Oracle.
2. Extraia para uma pasta (ex: `C:\oracle\instantclient_19_X`).
3. Você precisará apontar essa pasta na variável de ambiente no passo 5.

## 3. Preparar o Código-Fonte
1. Extraia os arquivos do **Oracle Pulse** para o diretório desejado (ex: `C:\oracle64\Oracle-Pulse`).
2. Abra o terminal e acesse a pasta:
   ```cmd
   cd C:\oracle64\Oracle-Pulse
   ```

## 4. Instalar Dependências do Projeto
No terminal, dentro da pasta do projeto, execute:
```cmd
npm install
```
Isso fará o download do `express`, `oracledb`, `dotenv` e demais bibliotecas.

## 5. Configurar as Variáveis de Ambiente
1. Abra o `.env` no bloco de notas e configure com os dados do seu banco:
   ```env
   # Configurações de Conexão Oracle
   DB_USER=admin
   DB_PASSWORD=sua_senha
   DB_HOST=localhost
   DB_PORT=1521
   DB_SERVICE=orcl

   # Caminho do Oracle Client (Se tiver instalado no passo 2)
   # ORACLE_CLIENT_PATH=C:\oracle64\product\19.0.0\client_1\bin

   # Autenticação do Painel
   AUTH_USER=DBA
   # Substitua a hash pelo hash SHA-256 da senha que deseja usar
   AUTH_PASS_HASH=hash_da_senha

   # Configurações do Servidor
   PORT=3001
   ```

## 6. Instalar o PM2
O PM2 vai garantir que o servidor fique rodando em segundo plano e reinicie caso ocorra um erro.
Instale-o globalmente pelo terminal (como Administrador no diretório do projeto):
```cmd
npm install -g pm2
```

## 7. Iniciar o Sistema com o PM2
Com as dependências instaladas e o `.env` configurado, você pode iniciar o servidor. Como ele já expõe a interface gráfica da pasta `public`, basta rodar o `server.js`:

```cmd
pm2 start server.js --name "Oracle-Pulse"
```
```cmd
npm install -g pm2-windows-startup
```
```cmd
pm2-startup install
```
Para garantir que a lista seja salva:
```cmd
pm2 save
```

*(Nota: Se preferir rodar manualmente para testar e ver os logs na tela, você pode apenas rodar `node server.js` em modo Administrador no diretório do projeto).*

### Comandos Úteis do PM2
- Ver os processos rodando: `pm2 list`
- Ver os logs de funcionamento e erros: `pm2 logs Oracle-Pulse`
- Reiniciar o sistema: `pm2 restart Oracle-Pulse`
- Parar o sistema: `pm2 stop Oracle-Pulse`

## 8. Acessar o Sistema
Acesse pelo navegador o endereço configurado na porta (padrão é 3001):
**http://<HOSTNAME-DO-SERVIDOR>:3001**

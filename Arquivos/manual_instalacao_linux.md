# Manual de Instalação - Oracle Pulse (Linux)

Este guia detalha a instalação do **Oracle Pulse** (sistema de monitoramento de banco de dados Node.js) em ambiente Linux.

## 1. Atualizar Pacotes e Instalar Dependências do Sistema
Abra o terminal e atualize seu sistema. Algumas bibliotecas como `libaio1` podem ser necessárias para o driver do Oracle (oracledb) caso você force o uso do modo "Thick".
```bash
sudo zypper refresh && sudo zypper update -y
sudo zypper install -y curl git libaio1
```

## 2. Instalar o Node.js
Como o SLES 12 SP5 possui uma versão mais antiga da biblioteca nativa C (glibc 2.22), o Node.js 20+ não irá rodar (exige glibc 2.28+). Portanto, instalaremos a **versão 16.20.2** (a última suportada para o seu Suse) usando os binários pré-compilados oficiais.

*Atenção: Limpe vestígios de instalações anteriores (evita o erro "Class extends value is not a constructor" no NPM):*
```bash
sudo rm -rf /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/lib/node_modules/

cd /tmp
curl -O https://nodejs.org/dist/v16.20.2/node-v16.20.2-linux-x64.tar.xz
sudo tar -xvf node-v16.20.2-linux-x64.tar.xz -C /usr/local --strip-components=1
```
Verifique as versões instaladas:
```bash
node -v
npm -v
```

## 3. Preparar o Código-Fonte
Faça o upload do sistema para o servidor. Por exemplo, em `/u01/oracle/Oracle-Pulse`.
```bash
cd /u01/oracle/Oracle-Pulse
```

## 4. Instalar Dependências do Projeto
Dentro da pasta contendo o arquivo `package.json`, instale as bibliotecas (`express`, `oracledb`, `dotenv`). Se houver lixo da instalação anterior, apague antes:
```bash
rm -rf node_modules package-lock.json
npm install
```

## 5. Configurar Variáveis de Ambiente
O sistema depende das credenciais de banco para operar. Edite o arquivo `.env`:
```bash
vi .env
```
Preencha os dados do banco Oracle:
```env
# Configurações de Conexão Oracle
   DB_USER=admin
   DB_PASSWORD=sua_senha
   DB_HOST=localhost
   DB_PORT=1521
   DB_SERVICE=orcl

   # Caminho do Oracle Client (Se tiver instalado no passo 2)
   # ORACLE_CLIENT_PATH=/u01/oracle/product/19.3/bin

   # Autenticação do Painel
   AUTH_USER=DBA
   # Substitua a hash pelo hash SHA-256 da senha que deseja usar
   AUTH_PASS_HASH=hash_da_senha

   # Configurações do Servidor
   PORT=3001
```


## 6. Instalar o PM2 Globalmente
O PM2 vai atuar como gerenciador do nosso processo Node.js, mantendo ele online e o reiniciando em caso de queda.
```bash
npm install -g pm2
```

## 7. Iniciar o Servidor
Diferente de sistemas React onde geramos uma pasta `dist`, o Oracle Pulse é servido diretamente pelo Node via arquivo `server.js` e carrega a interface da pasta `/public`.

Para rodar em segundo plano:
```bash
pm2 start server.js --name "Oracle-Pulse"
```

## 8. Configurar para Iniciar com o Sistema Operacional
Para que o PM2 suba a aplicação automaticamente se o servidor Linux for reiniciado, use o comando de startup:
```bash
pm2 startup
```
Após executar o comando gerado, salve a configuração:
```bash
pm2 save
```

### Comandos Úteis do PM2
- `pm2 status` ou `pm2 list`: lista o status do servidor.
- `pm2 logs Oracle-Pulse`: mostra a saída do terminal (comandos sendo executados, consultas realizadas e erros).
- `pm2 stop Oracle-Pulse`: para a aplicação.
- `pm2 restart Oracle-Pulse`: reinicia a aplicação.

## 9. Acessar o Sistema
Pronto. Com o servidor online, acesse via navegador pelo IP do servidor na porta definida:
**http://<HOSTNAME-DO-SERVIDOR>:3001**

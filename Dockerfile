# Imagem com Oracle Instant Client já incluído (modo thick do node-oracledb)
FROM ghcr.io/oracle/oraclelinux8-instantclient:21

WORKDIR /app

# Node.js 20 (Oracle Linux 8)
RUN dnf module reset -y nodejs && \
    dnf module enable -y nodejs:20 && \
    dnf install -y nodejs && \
    dnf clean all

# Dependências primeiro (melhor cache de build)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Código da aplicação
COPY . .

ENV NODE_ENV=production
# Em container, o Instant Client já está no PATH; deixe ORACLE_CLIENT_PATH vazio
ENV ORACLE_CLIENT_PATH=

EXPOSE 3000
CMD ["node", "server.js"]

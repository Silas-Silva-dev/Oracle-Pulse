<div align="center">

# ⚡ Oracle Pulse

### Real-time Oracle database monitoring and administration dashboard

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Oracle](https://img.shields.io/badge/Oracle-19c+-F80000?logo=oracle&logoColor=white)](https://www.oracle.com/database/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Docker](https://img.shields.io/badge/Docker-Supported-2496ED?logo=docker&logoColor=white)](https://www.docker.com)

</div>

---

## 📖 About the project

**Oracle Pulse** is a web-based monitoring and administration dashboard designed for **Oracle Database** environments (performance, active sessions, locks, SGA/PGA memory, tablespace/OS disk storage, backup/recovery, and security auditing). Developed by **Silas Silva**, it features **real-time metrics**, **interactive execution plans (`DBMS_XPLAN`)**, **remote OS disk inspection via SSH**, **threshold alert notifications**, **role-based access control (DBA & Viewer)**, **dark mode UI**, and a **built-in DEMO mode** for simulation without connecting to a live database.

---

## ✨ Features

- **📊 Real-time Dashboard** — active/blocked sessions, SQL command distribution, memory allocation, top SQL by CPU, wait events, and historical trend chart.
- **⚡ Performance Tuning** — CPU vs Wait ratio analysis, top SQL queries by CPU and elapsed time, `DBMS_XPLAN` execution plans, and table optimization.
- **💾 Storage & Disk Management** — tablespace usage monitoring, OS disk capacity tracking (local or remote via SSH), data file resizing, and adding new data files.
- **🔒 Session & Lock Management** — blocking lock tree analysis (victim vs blocker identification), long-running transaction tracking, and direct session termination (`kill session`).
- **🛡️ Backup, Recovery & Audit** — archivelog status inspection, RMAN backup history, FRA (Fast Recovery Area) utilization, and audit log trail for sensitive DBA actions.
- **🔔 Threshold Alerts** — automated monitoring and alert triggers for tablespace, disk, memory, and locking thresholds with optional webhook integration.
- **👥 Access Control Profiles** — role-based permissions separating `DBA` (full administrative rights) and `viewer` (read-only monitoring).
- **🧪 DEMO Mode & Customization** — mock data mode for demonstration without live Oracle connection, dark theme UI, and CSV data export.

---

## 🛠️ Technologies

| Layer | Stack |
|---|---|
| **Back-end** | Node.js (v18+), Express 4, CommonJS |
| **Database Integration** | `oracledb` (Oracle Instant Client Thick Mode), Oracle Database 19c+ |
| **Remote Administration** | `node-ssh` (SSH2 OS disk inspection), PowerShell / Bash `df` |
| **Front-end / UI** | HTML5, CSS3, JavaScript (Vanilla ES6+), Chart.js |
| **Security & Auditing** | Custom Token Authentication, Rate Limiting, Action Auditing Log |
| **Containerization** | Docker, Dockerfile |

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+ and npm
- Oracle Instant Client 64-bit (required for `oracledb` thick mode — on Windows set `ORACLE_CLIENT_PATH`)
- Oracle Database user with read permissions on `V$` and `DBA_` views (and DBA privileges for administrative actions)

### 1. Installation
```bash
npm install
```

### 2. Environment Variables
Create a `.env` file in the root directory (see `.env.example`):
```bash
cp .env.example .env
```
*(On Windows PowerShell, use `copy .env.example .env`)*

Configure your Oracle connection details, server port, and alert settings inside `.env`:
```env
PORT=3000
DEMO_MODE=false
DB_USER=system
DB_PASSWORD=your_password
DB_CONNECT_STRING=localhost:1521/ORCLCDB
ORACLE_CLIENT_PATH=C:\oracle\instantclient_19_19
AUTH_USER=dba_admin
AUTH_PASS_HASH=your_generated_hash
```

### 3. Admin Password Setup
Generate the password hash for your DBA login and paste it into `AUTH_PASS_HASH`:
```bash
npm run hash "YourStrongPassword"
```

### 4. Development & Production Environment
```bash
# Production mode
npm start

# Development mode (auto-reload with node --watch)
npm run dev

# Demo mode (simulated data, no database required)
npm run demo
```
Access `http://localhost:3000` (or the port specified in `PORT`).

---

## 🐳 Docker Deployment

Run Oracle Pulse inside a Docker container:

```bash
# Build the Docker image
docker build -t oracle-pulse .

# Run the container with environment variables file
docker run -p 3000:3000 --env-file .env oracle-pulse
```

---

## 📂 Project Structure

```
├── src/
│   ├── routes/              # Express API route modules (auth, dashboard, storage, memory...)
│   ├── alerts.js            # Threshold alert engine and webhook dispatcher
│   ├── audit.js             # Audit logging for sensitive administrative actions
│   ├── auth.js              # Token authentication, session state, and role access
│   ├── backupAdmin.js       # RMAN backup, archivelog, and FRA management
│   ├── cache.js             # In-memory metrics caching and trend history tracking
│   ├── config.js            # Environment configuration loading & validation
│   ├── dashboardService.js  # Dashboard aggregation, metrics summary & alerts
│   ├── db.js                # Oracle connection pool, queries execution & SQL sanitization
│   ├── logger.js            # Structured logging service
│   ├── mockData.js          # Mock data generator for DEMO mode
│   ├── osDisk.js            # Local and remote (SSH) OS disk space inspection
│   ├── queries.js           # Centralized Oracle SQL query dictionary
│   └── security.js          # Security headers (Helmet/CSP) and rate limiting
├── public/                  # Frontend static files (HTML, CSS, JavaScript, Chart.js)
├── bin/                     # CLI utilities (password hashing)
├── logs/                    # Audit logs and application logs output
├── server.js                # Application entrypoint (Express initialization & graceful shutdown)
├── Dockerfile               # Container build definition
└── .env.example             # Environment variable template
```

---

## 📜 Available Scripts

| Command | Description |
|---|---|
| `npm start` | Starts the production server |
| `npm run dev` | Runs the server in development mode with auto-reload (`node --watch`) |
| `npm run demo` | Launches the server in DEMO mode using mock data |
| `npm run hash <password>` | Generates a bcrypt password hash for authentication |

---

## 🔒 Security & Access Control

- **Role-Based Access Control (RBAC)**: Destructive actions (kill session, resize tablespace, add datafile, table optimization) are restricted exclusively to **DBA** users.
- **Audit Log Trail**: All administrative operations are logged with timestamp, user identity, IP address, and operation details in `logs/audit.log`.
- **SQL Injection Prevention**: Administrative DDL/DML actions enforce strict whitelist validation (validated SID/serial integers, tablespace names verified against database dictionary).
- **Authentication & Security**: Password hashes generated with constant-time comparison, rate-limited login endpoints, server-side token revocation, and default CSP/security headers.

> ℹ️ It is recommended to deploy Oracle Pulse behind a reverse proxy (e.g., Nginx, Traefik) configured with **HTTPS (TLS/SSL)**.

---

## 👨‍💻 Developer

Developed by **Silas Silva**.

---

<div align="center">

⭐ If this project helped you, consider giving it a star.

</div>

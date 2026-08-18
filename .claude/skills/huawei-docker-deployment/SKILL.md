---
name: huawei-docker-deployment
description: >-
  Guide for deploying and managing HuaweiDashboard via Docker Compose in monolith vs. modular profiles.
  Use this skill whenever setting up Docker for the first time, switching between --profile monolith and --profile modular, configuring shared IPC volumes, setting SERVICE_ROLE env variables, or troubleshooting container build/runtime issues.
---

# Huawei Docker Deployment & Profiles Guide

## Agent Execution Guidelines

When assisting with Docker deployments, follow this rule:
- **Default to Modular Mode (`--profile modular`)** for production or multi-service setups.
- **Use Monolith Mode (`--profile monolith`)** only for lightweight development, Raspberry Pi setups, or local testing.

---

## Deployment Profiles Overview

### 1. Monolith Profile (`--profile monolith`)

Single container executing collector, charger, and dashboard in one process space:

```bash
docker compose --profile monolith up -d --build
```

```
┌─────────────────────────────────────────┐
│          huawei-monolith Container      │
│                                         │
│  ├─ Collector (Modbus polling)          │
│  ├─ Charger (OCPP WebSocket)            │
│  ├─ Dashboard (Express + Vite)          │
│  Ports: 3001 (Web UI), 9100 (OCPP)      │
└─────────────────────────────────────────┘
```

---

### 2. Modular Profile (`--profile modular`) [Recommended]

Three independent containers communicating via shared volume IPC:

```bash
docker compose --profile modular up -d --build
```

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ huawei-collector │  │  huawei-charger  │  │huawei-dashboard  │
├──────────────────┤  ├──────────────────┤  ├──────────────────┤
│ Modbus polling   │  │ OCPP server      │  │ Express + Vite   │
│ SERVICE_ROLE=    │  │ SERVICE_ROLE=    │  │ SERVICE_ROLE=    │
│ collector        │  │ charger          │  │ dashboard        │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         │                     │                     │
         └─────────────────────┼─────────────────────┘
                    Shared IPC Volume
                   (shared_storage)
```

---

## Docker Compose Specifications

### Monolith Profile Setup

```yaml
services:
  huawei-monolith:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: huawei-monolith
    environment:
      START_MONOLITH: "true"
      MODBUS_HOST: ${MODBUS_HOST:-192.168.1.140}
    ports:
      - "3001:3001"   # Web UI
      - "9100:9100"   # OCPP WebSocket
    volumes:
      - ./storage:/app/storage
    restart: unless-stopped
```

### Modular Profile Setup

```yaml
services:
  huawei-collector:
    build: .
    container_name: huawei-collector
    environment:
      SERVICE_ROLE: collector
      MODBUS_HOST: ${MODBUS_HOST}
    volumes:
      - shared_storage:/app/storage
    restart: unless-stopped

  huawei-charger:
    build: .
    container_name: huawei-charger
    environment:
      SERVICE_ROLE: charger
    ports:
      - "9100:9100"
    volumes:
      - shared_storage:/app/storage
    restart: unless-stopped

  huawei-dashboard:
    build: .
    container_name: huawei-dashboard
    environment:
      SERVICE_ROLE: dashboard
    ports:
      - "3001:3001"
    volumes:
      - shared_storage:/app/storage
    restart: unless-stopped
    depends_on:
      - huawei-collector
      - huawei-charger

volumes:
  shared_storage:
    driver: local
```

---

## Multi-Stage Build & Linting Rules

The `Dockerfile` employs a multi-stage build pattern:

```dockerfile
# Stage 1: Build & Lint Validation
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY . .

# Static type analysis & linting (FAILS BUILD IF INVALID)
RUN npm run lint || exit 1
RUN npm run build

# Stage 2: Minimal Runtime
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY . .

EXPOSE 3001 9100
CMD ["node", "backend/server.js"]
```

**Agent Pre-Build Directive:** Run `pnpm run lint` locally before invoking `docker compose up --build` to avoid build phase failures due to TypeScript or ESLint errors.

---

## Volume & State Persistence Architecture

Ensure the host directory structure matches before mounting:

| Storage Path | Purpose | Persistence Requirement |
|---|---|---|
| `/app/storage/data/` | IPC Live State JSON files (`live-state-*.json`) | **Required** |
| `/app/storage/history/` | Daily JSONL telemetry (`YYYY-MM-DD.jsonl`) | **Required** |
| `/app/storage/logs/` | Service execution logs (`combined.jsonl`) | **Required** |

---

## Deployment & Management Procedures

### 1. Environment Variable Setup (.env)

Ensure `.env` exists in root before starting containers:

```env
MODBUS_HOST=192.168.1.140
MODBUS_PORTS=502,6607
APP_PORT=3001
OCPP_PORT=9100
TELEGRAM_BOT_TOKEN=your_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

### 2. Common Operational Commands

```bash
# Start Modular deployment in background
docker compose --profile modular up -d --build

# View container status
docker compose ps

# Follow logs for modular services
docker logs huawei-collector -f
docker logs huawei-charger -f
docker logs huawei-dashboard -f

# Restart single modular service without downtime to others
docker compose restart huawei-dashboard

# Clean shutdown (keep persistent volume data intact)
docker compose down
```

---

## Container Troubleshooting

### Issue 1: Docker Build Fails on `npm run lint`
* **Cause:** Type errors or linting violations in TypeScript code.
* **Fix:** Run `pnpm run lint` on host, fix reported issues, then rebuild.

### Issue 2: Port Conflict on 3001 or 9100
* **Cause:** Port already bound by another host process or container.
* **Check & Fix:**
  ```bash
  lsof -i :3001
  lsof -i :9100
  ```
  Pass alternate ports if needed:
  ```bash
  APP_PORT=3002 OCPP_PORT=9101 docker compose --profile modular up -d
  ```

### Issue 3: Modular Containers Cannot Read Shared Live State
* **Cause:** `shared_storage` volume mount failure or permissions issue on `/app/storage`.
* **Fix:** Verify volume mount path:
  ```bash
  docker inspect huawei-collector | grep -A 5 Mounts
  docker exec huawei-collector ls -la storage/data/
  ```

---

## Related Configuration Files

- `docker-compose.yml` → Profile definitions (monolith vs modular).
- `Dockerfile` → Multi-stage Node 22 build setup.
- `.env.example` → Template for required environment variables.
- `backend/server.ts` → Process entry point evaluating `SERVICE_ROLE`.
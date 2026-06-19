# Skill: Huawei Dashboard Docker Deployment & Profiles

**Purpose**: Guide for deploying the project in different modes (monolith vs. modular), understanding Docker Compose profiles, and troubleshooting containerized deployments.

**When to use this skill**:
- Setting up Docker Compose for the first time
- Switching between monolith and modular modes
- Debugging service-specific issues in containers
- Adding new services or modifying volumes
- Implementing CI/CD pipeline

---

## Deployment Modes

### Monolith Mode (Simple)

Single container running all services:

```bash
docker compose --profile monolith up -d --build
```

**Structure**:
```
┌─────────────────────────────────────────┐
│          huawei-monolith Container      │
│                                         │
│  ├─ Collector (Modbus polling)          │
│  ├─ Charger (OCPP WebSocket)            │
│  ├─ Dashboard (Express + Vite)          │
│  └─ Logger (unified logs)               │
│                                         │
│  Ports: 3001 (web), 9100 (OCPP)         │
└─────────────────────────────────────────┘
```

**Pros**: Simple, single container, all services share memory (no IPC latency).

**Cons**: Restart entire app if one part fails. Can't scale individual services.

**Use case**: Development, small deployments, single-board computers (Raspberry Pi).

---

### Modular Mode (Recommended Production)

Three independent containers:

```bash
docker compose --profile modular up -d --build
```

**Structure**:
```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ huawei-collector │  │  huawei-charger  │  │huawei-dashboard  │
├──────────────────┤  ├──────────────────┤  ├──────────────────┤
│ Modbus polling   │  │ OCPP server      │  │ Express + Vite   │
│ Port: (internal) │  │ Port: 9100       │  │ Port: 3001       │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         │                     │                     │
         └─────────────────────┼─────────────────────┘
                    Shared IPC Volumes
                   (storage/data/*)
```

**Each service**:
```dockerfile
FROM node:22-alpine
# ... build ...
ENV SERVICE_ROLE=collector  # (or charger, dashboard)
CMD ["node", "backend/server.js"]
```

**Pros**:
- Restart one service without stopping others
- Better fault isolation
- Can update dashboard without stopping polling
- Horizontal scaling (run multiple collectors for different devices)

**Cons**:
- More complex networking (shared volumes)
- IPC overhead (file polling every 1s)
- State consistency harder to debug

**Use case**: Production, redundancy requirements, multiple inverters.

---

## Docker Compose Configuration

### Monolith Profile

```yaml
services:
  huawei-monolith:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        # Use default npm package/build steps
        # No SERVICE_ROLE env var → starts as monolith
    container_name: huawei-monolith
    environment:
      START_MONOLITH: "true"
      MODBUS_HOST: ${MODBUS_HOST:-192.168.1.140}
      # ... other env vars ...
    ports:
      - "3001:3001"   # Dashboard web
      - "9100:9100"   # OCPP WebSocket
    volumes:
      - ./storage:/app/storage  # Persist history, logs, data
      - ./data:/app/data
    restart: unless-stopped
```

### Modular Profile

```yaml
services:
  huawei-collector:
    build: .
    container_name: huawei-collector
    environment:
      SERVICE_ROLE: collector
      MODBUS_HOST: ${MODBUS_HOST}
      # ... other env vars ...
    volumes:
      - shared_storage:/app/storage
    restart: unless-stopped
    # No port exposed (internal service)

  huawei-charger:
    build: .
    container_name: huawei-charger
    environment:
      SERVICE_ROLE: charger
      # ... env vars ...
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
      # ... env vars ...
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

## Dockerfile Build Process

The `Dockerfile` includes a **multi-stage build**:

```dockerfile
# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY . .

# TypeScript validation (catches errors early)
RUN npm run lint || exit 1

# Build frontend
RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY . .

EXPOSE 3001 9100
CMD ["node", "backend/server.js"]
```

**Key points**:
- `npm run lint` runs and **stops build if errors exist**
- Frontend built in Stage 1 (not at runtime)
- Only runtime deps copied to final image
- Exposes both 3001 and 9100 (monolith uses both)

### TypeScript Lint in Docker

If `npm run lint` fails, **entire build fails**:

```bash
docker compose --profile modular up -d --build
# ERROR: Service 'huawei-collector' failed to build:
# backend/server.ts: duplicate identifier 'foo'
```

**Fix**: Ensure all services compile locally first:

```bash
pnpm run lint  # Check before pushing
```

---

## Volumes & Data Persistence

### Essential Volumes

| Path | Purpose | Persist? |
|------|---------|----------|
| `/app/storage/data/` | Live state files (IPC) | Yes |
| `/app/storage/history/` | Daily JSONL telemetry | Yes |
| `/app/storage/logs/` | Service logs + combined.jsonl | Yes |
| `/app/dist/` | Built frontend assets | No (rebuilt each time) |

### Docker Compose Volume Definitions

**Monolith**:
```yaml
volumes:
  - ./storage:/app/storage  # Local path binding
```

**Modular** (shared volume):
```yaml
volumes:
  shared_storage:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: ${PWD}/storage
```

All three services mount the same `shared_storage` → can read/write same JSON files.

---

## Environment Variables in Docker

### File: `.env` (git-ignored)

```bash
MODBUS_HOST=192.168.1.140
MODBUS_PORTS=502,6607
APP_PORT=3001
OCPP_PORT=9100

# Telegram (optional)
TELEGRAM_BOT_TOKEN=YOUR_TOKEN
TELEGRAM_CHAT_ID=YOUR_CHAT_ID
TELEGRAM_ALERTS_ENABLED=true

# InfluxDB (optional)
INFLUX_URL=http://localhost:8086
INFLUX_TOKEN=YOUR_TOKEN
INFLUX_ORG=home
INFLUX_BUCKET=solar
```

### Passing to Docker

```bash
docker compose --env-file .env up -d

# Or inline:
MODBUS_HOST=10.0.0.50 docker compose up -d
```

---

## Common Deployment Tasks

### View Logs from Specific Service

**Monolith**:
```bash
docker logs huawei-monolith -f  # Follow logs
docker logs huawei-monolith --tail 100
```

**Modular**:
```bash
docker logs huawei-collector -f
docker logs huawei-charger -f
docker logs huawei-dashboard -f
```

### Check Service Status

```bash
docker compose ps

# Output:
# NAME                       STATUS
# huawei-collector           Up 2 hours
# huawei-charger             Up 2 hours
# huawei-dashboard           Up 2 hours
```

### Restart a Single Service (Modular)

```bash
docker compose restart huawei-dashboard
# Other services keep running
```

### Access Shell Inside Container

```bash
docker exec -it huawei-collector sh
# Now inside container:
# $ cat storage/data/live-state-collector.json
# $ head -20 storage/logs/combined.jsonl
```

### Update and Rebuild

```bash
git pull
docker compose --profile modular down
docker compose --profile modular up -d --build
```

### Cleanup (Remove containers, keep volumes)

```bash
docker compose down
# To also remove volumes (WARNING: data loss):
docker compose down -v
```

---

## Troubleshooting Deployments

### All services start but collector offline

```bash
docker logs huawei-collector | grep -i modbus
# Check if MODBUS_HOST is reachable from inside container
docker exec -it huawei-collector ping 192.168.1.140
```

### Dashboard shows old data

```bash
# Check if live-state files are being updated
docker exec -it huawei-dashboard cat storage/data/live-state-collector.json
# Should have recent timestamps. If not, collector isn't running.
```

### Modular services can't find each other's data

```bash
# Verify shared volume is mounted
docker inspect huawei-collector | grep -A 5 Mounts

# Check if files exist:
docker exec huawei-collector ls -la storage/data/
```

### Build fails with TypeScript errors

```bash
# Locally check first:
pnpm run lint

# If it passes locally but fails in Docker, might be due to:
# - Different Node version (Alpine vs your system)
# - Lock file mismatch (delete pnpm-lock.yaml, reinstall)
# - Duplicates in server.ts (check with grep SERVICE_ROLE)
```

### Port conflicts

```bash
# Check if 3001 or 9100 already in use
lsof -i :3001
lsof -i :9100

# If in use, either kill the process or use different ports
docker compose -e APP_PORT=3002 -e OCPP_PORT=9101 up -d
```

---

## Performance Considerations

### Single Docker Host

- **CPU**: Modular uses slightly more (IPC polling overhead), but negligible
- **Memory**: ~150MB per service in Alpine
- **Disk I/O**: 1 JSON write/sec per service (state-manager) + 0.5 JSONL writes/sec (history)

### Scaling Beyond Single Inverter

If you want to monitor multiple Huawei inverters:

```yaml
# Future enhancement:
services:
  collector-inverter-1:
    environment:
      SERVICE_ROLE: collector
      MODBUS_HOST: 192.168.1.140
      DEVICE_ID: inverter-1

  collector-inverter-2:
    environment:
      SERVICE_ROLE: collector
      MODBUS_HOST: 192.168.1.141
      DEVICE_ID: inverter-2

  # Single dashboard + charger for both inverters
```

---

## Key Files

- [docker-compose.yml](../docker-compose.yml) → Service definitions
- [Dockerfile](../Dockerfile) → Build process
- [.env.example](../.env.example) → Environment template
- [backend/server.ts](../backend/server.ts) → Entry point, SERVICE_ROLE check

---
name: huawei-debugging-checklist
description: >-
  Systematic troubleshooting and diagnostic guide for HuaweiDashboard services (collector, charger, dashboard).
  Use this skill whenever a service is offline, data polling stops, Modbus/OCPP connections fail, state JSON files are corrupted, or the system behaves unexpectedly.
---

# Huawei Debugging Checklist & Troubleshooting Guide

## Diagnostic Agent Protocol

When troubleshooting or when reported errors occur, **execute diagnosis in 4 sequential phases** before offering code changes:

```
┌─ Phase 1: Service & Port Health (docker compose ps, nc/ping)
├─ Phase 2: Log Inspection (grep error/warning in containers)
├─ Phase 3: State File Integrity Check (jq validation on live-state JSONs)
└─ Phase 4: Match Symptom with Critical Issues Directory (#1 - #7)
```

---

## Phase 1: Is it running? (Container & Port Health)

Run these checks to confirm container states and network accessibility:

```bash
# 1. Container status
docker compose ps

# 2. Critical local ports
nc -zv 127.0.0.1 3001  # Dashboard UI
nc -zv 127.0.0.1 9100  # OCPP Charger Server

# 3. Inverter IP Ping
ping -c 3 192.168.1.140  # Adjust to MODBUS_HOST IP
```

---

## Phase 2: Inspect Container Logs

Search for active errors or backoff reconnection loops:

```bash
# Stream real-time logs
docker logs huawei-collector -f --tail 50

# Tail last 100 lines for errors
docker logs huawei-collector --tail 100 | grep -iE "error|warning|timeout|refused"
docker logs huawei-charger --tail 100 | grep -iE "error|warning|disconnect"
docker logs huawei-dashboard --tail 100 | grep -iE "error|warning"
```

---

## Phase 3: Inspect State Files & History Integrity

Validate IPC state files and verify JSON formatting:

```bash
# 1. Check live state timestamps and validity
jq empty storage/data/live-state-collector.json && echo "Collector JSON: Valid"
jq empty storage/data/live-state-charger.json && echo "Charger JSON: Valid"
jq empty storage/data/live-state-dashboard.json && echo "Dashboard JSON: Valid"

# 2. Inspect combined logs (last 20 lines)
tail -20 storage/logs/combined.jsonl | jq .

# 3. Inspect recent daily history recording
tail -10 storage/history/$(date +%Y-%m-%d).jsonl | jq .
```

---

## Phase 4: Critical Issues Directory

### Issue #1: Collector Offline / No Data Polling

**Symptoms:** Dashboard shows "Collector: Offline", history not written, `inputPower`/`activePower` are 0.

#### Root Causes & Fixes:

1. **Modbus Connection Failure / Timeout:**
   ```bash
   docker logs huawei-collector | grep -i "modbus"
   ```
   * **Fix:** Verify `MODBUS_HOST` in `.env`. Check container reachability:
     ```bash
     docker exec huawei-collector ping -c 2 192.168.1.140
     ```
   * Test Modbus ports manually:
     ```bash
     nc -zv 192.168.1.140 502
     nc -zv 192.168.1.140 6607
     ```

2. **Multiple Collector Instances Competing (Process Conflict):**
   ```bash
   ps aux | grep node | grep collector
   docker ps -a | grep collector
   ```
   * **Fix:** Kill stray local node processes (`kill -9 <PID>`) so Docker is the sole Modbus connection.

3. **Exponential Backoff Active:**
   ```bash
   docker logs huawei-collector | grep "Scheduling reconnection"
   ```
   * **Fix:** Restart collector container to reset backoff timer:
     ```bash
     docker compose restart huawei-collector
     ```

---

### Issue #2: Charger Offline / OCPP Not Connecting

**Symptoms:** Dashboard shows "Charger: Offline", no transaction data, unable to start/stop charge.

#### Root Causes & Fixes:

1. **OCPP Port 9100 Blocked or Unexposed:**
   ```bash
   lsof -i :9100
   ```
   * **Fix:** Ensure `docker-compose.yml` maps `"9100:9100"`.

2. **Charger WebSocket Misconfiguration:**
   * **Protocol:** `ws://` (Not `wss://`).
   * **Host:** Host IP (e.g., `192.168.1.X`), not `localhost` from inside charger network.
   * **Path:** `/ocpp/CP001` (matches ChargePoint ID).

---

### Issue #3: State File Corruption / Field Ownership Violation

**Symptoms:** JSON parse errors (`Unexpected token`), charger state lost after restart.

#### Root Causes & Fixes:

1. **Guerra de Archivos (Field Ownership Overwrite):**
   ```bash
   cat storage/data/live-state-charger.json | jq .powerW
   ```
   * **Fix:** Verify `saveLiveState()` in `inverter-collector.ts` ONLY writes owned fields. Refer to `HUAWEI-IPC-STATE-MANAGEMENT.md`.

2. **Non-Atomic File Writes:**
   * **Fix:** All write operations must write to a temporary file first (`.tmp`) and atomically rename to target `.json`.

---

### Issue #4: History Not Being Recorded

**Symptoms:** `storage/history/YYYY-MM-DD.jsonl` missing or empty.

#### Root Causes & Fixes:

1. **Incomplete Modbus Sample (NaN / Infinity):**
   ```bash
   docker logs huawei-collector | grep "Skipping history write"
   ```
   * **Fix:** Ensure all required sections (PV, Input Power, Grid Meter) return finite numbers before persisting history.

2. **Permissions or Missing Directory:**
   ```bash
   mkdir -p storage/history && chmod 777 storage/history
   ```

---

### Issue #5: Dashboard Shows Stale or Cached Data

**Symptoms:** Inverter producing power but dashboard shows 0W; charger active but dashboard shows offline.

#### Root Causes & Fixes:

1. **Socket.io Disconnected:**
   ```bash
   docker logs huawei-dashboard | grep -i socket
   ```
2. **Stale Live State File:**
   ```bash
   stat storage/data/live-state-collector.json
   ```
   * If modification time is not current, collector polling has stalled.

---

### Issue #6: Charger Mode Changes / Start-Stop Failures

**Symptoms:** Click "Start Charge" fails, mode stuck on FAST, `SetChargingProfile` ignored.

#### Root Causes & Fixes:

1. **Active Transaction Conflict:**
   ```bash
   cat storage/data/live-state-charger.json | jq .transactionId
   ```
   * If non-null, an existing transaction must be stopped first.

2. **Loop Protection Cooldown (60s):**
   ```bash
   docker logs huawei-charger | grep "Loop detected"
   ```
   * Wait 60 seconds for cooldown before sending new OCPP messages.

---

### Issue #7: PV Disconnection Alerts Not Triggering

**Symptoms:** PV strings physically disconnected but no Telegram alert sent.

#### Root Causes & Fixes:

1. **Startup Grace Period Active:**
   * Alerts are suppressed for the first 30 seconds after collector startup to avoid false positives.

2. **Telegram Token Unset:**
   ```bash
   docker logs huawei-collector | grep -i telegram
   ```
   * Ensure `TELEGRAM_BOT_TOKEN` is defined in `.env`.

---

## Useful Diagnostic Commands

```bash
# Restart individual service
docker compose restart huawei-collector

# Rebuild single service
docker compose build huawei-collector

# Inspect live container shell
docker exec -it huawei-collector sh

# Validate JSON files
jq empty storage/data/live-state-collector.json && echo "Valid"
```

---

## Related Project Files

- `Agents.md` → Historical issues, post-mortems, and engineering decisions.
- `backend/services/inverter-collector.ts` → Collector polling logic.
- `backend/services/ocpp-charger.ts` → OCPP server logic.
- `backend/ipc/state-manager.ts` → State persistence implementation.
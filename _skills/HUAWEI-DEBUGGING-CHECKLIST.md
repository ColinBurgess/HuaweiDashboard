# Skill: Huawei Dashboard Debugging Checklist & Known Issues

**Purpose**: Systematic troubleshooting guide covering the most common issues, root causes, and solutions based on lessons learned from Agents.md and recent fixes.

**When to use this skill**:
- System behaving unexpectedly
- Need to diagnose why specific data is missing
- Following a structured debugging approach
- Reporting issues to the development team

---

## General Debugging Workflow

### Phase 1: Is it running?

```bash
# Check if services are alive
docker compose ps
# Expected: All services "Up" with recent uptime

# Check connectivity to critical ports
nc -zv 127.0.0.1 3001  # Dashboard
nc -zv 127.0.0.1 9100  # OCPP
ping 192.168.1.140     # Inverter (adjust IP)
```

### Phase 2: Check logs

```bash
# Real-time logs
docker logs huawei-collector -f
docker logs huawei-charger -f
docker logs huawei-dashboard -f

# Last 100 lines
docker logs huawei-collector --tail 100

# Search for errors
docker logs huawei-collector | grep -i error
docker logs huawei-collector | grep -i warning
```

### Phase 3: Inspect state files

```bash
# Check live state
cat storage/data/live-state-collector.json   # Should have recent timestamp
cat storage/data/live-state-charger.json
cat storage/data/live-state-dashboard.json

# Check combined logs (last 50 lines)
tail -50 storage/logs/combined.jsonl | jq .

# Check today's history
ls -lah storage/history/ | tail -5
tail -10 storage/history/2026-06-19.jsonl | jq .
```

### Phase 4: System health monitor

Visit `http://localhost:3001/` and check the "Health" panel:
- Last heartbeat timestamps for each service
- Status (OK or Error)
- Details (Polling, Offline, etc.)

---

## Critical Issues & Root Causes

### Issue #1: Collector Offline / No Data Polling

**Symptoms**:
- Dashboard shows "Collector: Offline"
- History not being written
- `inputPower`, `activePower` all zeros

**Root Causes** (in order of likelihood):

1. **Modbus Connection Failed**
   ```bash
   docker logs huawei-collector | grep -i modbus
   # Look for "Timeout", "Connection refused", "Network unreachable"
   ```

   **Fixes**:
   - [ ] Verify `MODBUS_HOST` in `.env` matches inverter IP
   - [ ] `ping 192.168.1.140` from host (reachable?)
   - [ ] `ping 192.168.1.140` from inside container:
     ```bash
     docker exec huawei-collector ping 192.168.1.140
     ```
   - [ ] Check if inverter is powered on and reachable
   - [ ] Try both ports: 502 and 6607 manually (telnet):
     ```bash
     telnet 192.168.1.140 502
     # If hangs → port not listening
     ```
   - [ ] Firewall blocking Modbus? (Windows Defender, iptables, etc.)

2. **Port 502/6607 Wrong**
   ```bash
   # Edit .env
   MODBUS_PORTS=502,6607
   # Restart
   docker compose restart huawei-collector
   ```

3. **Two Instances Competing (CRITICAL)**

   **Symptom**: Socket closes intermittently, "Offline" cycles.

   ```bash
   # Check ALL instances running
   docker compose ps
   # AND
   ps aux | grep node | grep collector
   # AND (if using Kubernetes, etc.)
   docker ps -a | grep collector
   ```

   **Fix**:
   - Stop development instance locally: `Ctrl+C`
   - Kill stray processes: `kill -9 <PID>`
   - Ensure Docker is the only one connecting

4. **Exponential Backoff Active (After Timeouts)**

   **Symptom**: Logs show `Scheduling reconnection in 5000ms (attempt 1)`, then nothing happens.

   ```bash
   # Check logs for backoff
   docker logs huawei-collector | grep "Scheduling reconnection"
   # Check reconnect attempts counter in Health Monitor
   ```

   **Expected behavior**: Exponential backoff (5s → 10s → 20s...) until connection succeeds.

   **Fix**: Wait for backoff to complete, or restart collector to reset:
   ```bash
   docker compose restart huawei-collector
   ```

---

### Issue #2: Charger Offline / Not Connecting

**Symptoms**:
- Dashboard shows "Charger: Offline"
- No transaction data
- Can't start/stop charging

**Root Causes**:

1. **OCPP_PORT Not Exposed or Blocked**
   ```bash
   # Check if 9100 is listening
   netstat -tuln | grep 9100
   # OR
   lsof -i :9100

   # Test connection from host
   nc -zv 127.0.0.1 9100
   ```

   **Fix**:
   - [ ] Ensure docker-compose exposes port 9100
   - [ ] Firewall allowing 9100?
   - [ ] In docker-compose.yml:
     ```yaml
     ports:
       - "9100:9100"
     ```

2. **Charger WebSocket URL Wrong**

   **Charger config must be**:
   ```
   Protocol: ws://  (not wss://)
   Host: [dashboard-machine-ip]  (not localhost from inside charger's network)
   Port: 9100
   Path: /ocpp/CP001  (or whatever chargePointId)
   ```

   **Fix**: Check charger configuration in its web UI.

3. **OCPP Server Not Running**
   ```bash
   docker logs huawei-charger | grep -i "ocpp\|websocket\|listening"
   # Should see "OCPP server listening on 0.0.0.0:9100"
   ```

---

### Issue #3: State File Corruption / Inconsistent Data

**Symptoms**:
- One service's data randomly disappears
- JSON files become invalid (can't parse)
- Charger state lost after restart

**Root Causes** (from Agents.md):

1. **Guerra de Archivos: Field Ownership Violated**

   Example: Collector writes `powerW` (belongs to charger only).

   ```bash
   # Check live-state-charger.json
   cat storage/data/live-state-charger.json | jq .powerW
   # If null/0 when charger is active → collector overwrote it
   ```

   **Fix**:
   - [ ] Review `saveLiveState()` in collector service
   - [ ] Ensure it only writes owned fields
   - [ ] Reference HUAWEI-IPC-STATE-MANAGEMENT.md for field ownership

2. **Partial/Corrupted JSON (Not Atomic Write)**

   ```bash
   # Check if file is valid JSON
   cat storage/data/live-state-collector.json | jq empty
   # If error: "Unexpected token" → corrupted file
   ```

   **Fix**:
   - [ ] All writes must be atomic (.tmp → rename)
   - [ ] Check if write failed mid-operation
   - [ ] Restart service to recover from memory

3. **Service Loading Its Own Stale File**

   **Symptom**: After restart, charger state reverts to old values.

   ```typescript
   // WRONG:
   function loadLiveState() {
     const chargerData = JSON.parse(fs.readFileSync(CHARGER_STATE_PATH));
     Object.assign(chargerState, chargerData);  // Overwrites memory with stale disk
   }

   // RIGHT:
   function loadLiveState() {
     if (process.env.SERVICE_ROLE !== 'charger') {
       const chargerData = JSON.parse(fs.readFileSync(CHARGER_STATE_PATH));
       Object.assign(chargerState, chargerData);
     }
   }
   ```

---

### Issue #4: History Not Being Recorded

**Symptoms**:
- `storage/history/2026-06-19.jsonl` doesn't exist or is empty
- Dashboard graph shows no data
- "Skipping history write due to incomplete/invalid Modbus sample" in logs

**Root Causes**:

1. **Modbus Sample Incomplete**

   ```bash
   docker logs huawei-collector | grep "Skipping history write"
   # Check which section failed
   docker logs huawei-collector | grep "Modbus read failed"
   ```

   Requirements for valid history sample:
   - ✅ PV data (voltage, current)
   - ✅ Input power (solar)
   - ✅ Active power (AC output)
   - ✅ Grid meter (net power)
   - ✅ All finite numbers (no NaN/Infinity)

   **Fix**: Address the specific read failure (see Collector Offline)

2. **Directory Doesn't Exist**
   ```bash
   mkdir -p storage/history
   ```

3. **Permissions Issue**
   ```bash
   ls -la storage/history/
   # Should be writable by docker user
   chmod 777 storage/history
   ```

---

### Issue #5: Dashboard Shows Old/Cached Data

**Symptoms**:
- Inverter is producing 5000W, dashboard shows 0W
- Charger is charging, dashboard shows offline
- History graph shows old values

**Root Causes**:

1. **Browser Cache**
   ```bash
   # Hard refresh (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows)
   # Or clear browser cache for http://localhost:3001
   ```

2. **Socket.io Not Connected**
   ```bash
   # In browser DevTools → Network tab
   # Check if WebSocket to localhost:3001 is open (Status: 101 Switching Protocols)

   # If disconnected:
   docker logs huawei-dashboard | grep -i socket
   ```

3. **Live State File Stale (Not Being Updated)**
   ```bash
   # Check modification time
   stat storage/data/live-state-collector.json | grep Modify
   # Should be "now" or recent

   # If old: collector isn't running or polling
   docker logs huawei-collector | tail -20
   ```

4. **InfluxDB Out of Sync** (if using InfluxDB)
   ```bash
   # Check if writes to InfluxDB are failing
   docker logs huawei-collector | grep -i influx
   ```

---

### Issue #6: Charger Won't Start / Mode Changes Don't Work

**Symptoms**:
- Click "Start Charge" → nothing happens
- Mode change to "GREEN" → still shows "FAST"
- SetChargingProfile not being sent

**Root Causes**:

1. **Charger Not Connected (WebSocket)**
   ```bash
   # Check if WebSocket connection established
   docker logs huawei-charger | grep -i "connection\|connected\|CP001"
   # Should see chargePointId connected
   ```

2. **Transaction Already Active**
   ```bash
   # Check if transactionId exists
   cat storage/data/live-state-charger.json | jq .transactionId
   # If not null: another transaction is active, must stop first
   ```

3. **Cable Not Plugged In**
   ```bash
   cat storage/data/live-state-charger.json | jq .cable
   # Should be "EV Plugged" or similar
   # If "Unplugged": physical connection missing
   ```

4. **Loop Protection Active**
   ```bash
   docker logs huawei-charger | grep "Loop detected"
   # If active: 60s cooldown in effect, wait and retry
   ```

5. **Charger Doesn't Support Mode**
   ```bash
   # Some chargers only support FAST
   # Check error response to SetChargingProfile
   docker logs huawei-charger | grep "SetChargingProfile"
   ```

---

### Issue #7: PV Disconnection/String Loss Alerts Not Working

**Symptoms**:
- PV strings physically disconnected but no alert
- Automatic has tripped but dashboard doesn't show
- Telegram not receiving alerts

**Root Causes**:

1. **Telegram Not Configured**
   ```bash
   echo $TELEGRAM_BOT_TOKEN
   # If empty: not set in .env
   docker logs huawei-collector | grep -i telegram
   # Should see token on startup
   ```

2. **Grace Period Active**

   First 30 seconds after startup: PV status changes ignored (prevents false alerts).

   ```bash
   # Check startup time
   docker logs huawei-collector | grep "Starting Inverter Service"
   # Wait 30s and try again
   ```

3. **Register Read Failed**
   ```bash
   docker logs huawei-collector | grep "PV connection status"
   # If read error: Modbus issue (see Issue #1)
   ```

4. **Bit Position Wrong (Huawei Model-Specific)**

   Some Huawei models might have PV status at different register/bit.

   ```bash
   # Check raw register values
   docker exec huawei-collector modbus-client read-holding 32002 1
   # Compare with expected value
   ```

---

## Systematic Debugging Flowchart

```
┌─ Is UI accessible? (http://localhost:3001)
│
├─NO→ Docker running? (docker ps)
│      ├─NO→ Start: docker compose up -d
│      └─YES→ Check logs: docker logs huawei-dashboard
│
└─YES→ Health Monitor shows what?

       ├─ All services OK? → Data should be flowing
       │  └─ Still no data? Check history file, browser cache
       │
       ├─ Collector offline? (Go to Issue #1 checklist)
       │
       ├─ Charger offline? (Go to Issue #2 checklist)
       │
       └─ Old data? (Go to Issue #5 checklist)
```

---

## Quick Reference: Essential Commands

```bash
# Status check
docker compose ps

# Full logs (last 100 lines, all services)
docker compose logs --tail 100

# Follow collector in real-time
docker logs huawei-collector -f --tail 50

# Check live state
cat storage/data/live-state-*.json | jq .

# Search for errors (last hour)
docker logs huawei-collector --since 1h | grep -i error

# Access container shell
docker exec -it huawei-collector sh

# Restart one service
docker compose restart huawei-collector

# Rebuild one service
docker compose build huawei-collector

# Check health endpoint (if available)
curl http://localhost:3001/api/health

# Validate JSON file
jq empty storage/data/live-state-collector.json && echo "Valid"
```

---

## When to Ask for Help

Before reporting an issue, ensure you've:

- [ ] Checked Health Monitor (all services status)
- [ ] Viewed full logs for all services (`docker compose logs`)
- [ ] Verified physical connections (Modbus cable, Charger cable)
- [ ] Confirmed .env variables match your setup
- [ ] Checked for port conflicts (`lsof -i :3001`, `lsof -i :9100`)
- [ ] Tried restarting the relevant service(s)
- [ ] Run `pnpm run lint` to check for code errors
- [ ] Checked this Debugging Checklist

**Include in issue report**:
- [ ] `docker compose ps` output
- [ ] Last 50 lines of logs from each service
- [ ] Contents of `live-state-*.json` files
- [ ] Your `.env` values (sanitized of secrets)
- [ ] Which mode (monolith vs modular)

---

## Key Files

- [Agents.md](../Agents.md) → Historical issues & lessons
- [backend/services/inverter-collector.ts](../backend/services/inverter-collector.ts) → Collector logs
- [backend/services/ocpp-charger.ts](../backend/services/ocpp-charger.ts) → Charger logs
- [backend/ipc/state-manager.ts](../backend/ipc/state-manager.ts) → State mechanism
- [docker-compose.yml](../docker-compose.yml) → Service definitions

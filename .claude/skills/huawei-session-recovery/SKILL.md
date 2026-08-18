---
name: huawei-session-recovery
description: >-
  Systematic recovery workflow for broken charger communication, port 9100 unresponsiveness, or IPC state sync failures between services.
  Use this skill whenever charger communication is down, the dashboard shows "Charger Offline", IPC live-state files stop updating, or services crash following major refactoring.
---

# HuaweiDashboard Session Recovery Skill

## Recovery Protocol Workflow

When charger communication or service synchronization fails, execute this step-by-step diagnostic sequence before applying major code modifications:

```
┌─ Step 1: Container Status Check (docker compose ps)
├─ Step 2: Port Binding Check (lsof -i :9100)
├─ Step 3: IPC State Freshness (stat live-state-charger.json)
├─ Step 4: Container Log Inspection (grep errors in charger service)
└─ Step 5: Root Cause Hypothesis & Remediation
```

---

## 🚀 Step-by-Step Quick Recovery

### Step 1: Verify Running Services
```bash
docker compose ps

# Confirm all 3 modular services show "Up":
# huawei-collector    ✅
# huawei-charger      ✅
# huawei-dashboard    ✅
```

If the charger service is stopped or restarting:
```bash
docker compose --profile modular up -d --build huawei-charger
sleep 5
docker logs huawei-charger --tail 50
```

### Step 2: Verify OCPP Port Binding (Port 9100)
```bash
# Verify process listening on port 9100
lsof -i :9100

# Inside container check
docker exec huawei-charger lsof -i :9100
```
*If not listening:* The charger service crashed during startup or failed to bind the socket.

### Step 3: Inspect Live IPC State File Modification Times
```bash
# Check if charger state file is being written (should update ~1s)
stat storage/data/live-state-charger.json | grep Modify

# Verify file contains valid JSON
jq empty storage/data/live-state-charger.json && echo "Valid JSON"
```

### Step 4: Inspect Charger Service Logs
```bash
docker logs huawei-charger -f --tail 100
```

**Common Log Errors & Diagnostic Indications:**
* `"Cannot find module..."` → Missing import path or TypeScript build failure.
* `"EADDRINUSE: 9100"` → Host port conflict (another process or orphaned container running).
* `"SyntaxError: Unexpected token..."` → Corrupted `storage/data/live-state-*.json` file on disk.

### Step 5: Nuclear Reset (Last Resort)
If IPC state files are corrupted or socket buffers are locked:
```bash
docker compose --profile modular down
rm -f storage/data/live-state-*.json
docker compose --profile modular up -d --build
sleep 10
docker compose ps
```

---

## 🔍 Root Cause Hypothesis Tree

### Hypothesis A: Import Path Resolution Error (High Probability)
* **Symptom:** Logs show `Cannot find module` or TS compilation error during container build.
* **Diagnosis Command:**
  ```bash
  docker logs huawei-charger | grep "Cannot find"
  ```
* **Fix:** Check relative imports in `backend/services/ocpp-charger.ts`. Ensure paths match the build output directory (`dist/`).

### Hypothesis B: Port 9100 Conflict / Binding Failure
* **Symptom:** Container is running, but external chargers cannot establish WebSocket connections (`ws://host:9100`).
* **Diagnosis Command:**
  ```bash
  lsof -i :9100
  ```
* **Fix:** Ensure `docker-compose.yml` explicitly exposes port mapping:
  ```yaml
  huawei-charger:
    ports:
      - "9100:9100"
  ```

### Hypothesis C: Stale IPC State Files
* **Symptom:** Services start up successfully but crash upon reading disk state.
* **Fix:** Delete corrupted live state files (services auto-recreate them on boot):
  ```bash
  rm -f storage/data/live-state-*.json
  docker compose restart huawei-charger
  ```

### Hypothesis D: Environment Variable `SERVICE_ROLE` Misconfiguration
* **Symptom:** Charger service boots as a monolith or collector instance.
* **Diagnosis Command:**
  ```bash
  docker exec huawei-charger env | grep SERVICE_ROLE
  ```
* **Fix:** Ensure `SERVICE_ROLE=charger` is passed in `docker-compose.yml`.

---

## 📋 Post-Fix Documentation Protocol

Once the root cause is resolved and services are healthy:

1. **Update Active Session Log (`scratch/SESSION_LOG_YYYY-MM-DD.md`):**
   ```markdown
   ### 🔴 RESOLVED ISSUE
   - **Root Cause:** [Clear description of what broke]
   - **Fix Applied:** [Specific code or config change]
   - **Verification:** ✅ Verified via `docker compose ps` and `stat live-state-charger.json`
   ```

2. **Update `CHANGELOG.md`:**
   Add under `[Unreleased] -> Fixed`:
   ```markdown
   - **Fixed:** Resolved charger service communication and port 9100 binding issue.
   ```

3. **Version & Commit (if applicable):**
   ```bash
   git add CHANGELOG.md backend/ docker-compose.yml
   git commit -m "fix: restore charger communication and port 9100 socket binding"
   ```

---

## Related Files & Resources

- `backend/services/ocpp-charger.ts` → Charger service implementation.
- `docker-compose.yml` → Service profile and port definitions.
- `RECOVERY_GUIDE.md` → Root project recovery instructions.
- `CHANGELOG.md` → Version history log.
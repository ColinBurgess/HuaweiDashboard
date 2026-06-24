---
name: huawei-session-recovery
description: Recovery workflow for HuaweiDashboard broken charger communication. Diagnoses root cause, applies fix, and updates documentation. Use when charger service fails to communicate with dashboard or inverter.
---

# HuaweiDashboard Session Recovery Skill

**Purpose**: Recover from broken charger communication using systematic diagnosis and documented recovery procedures.

**When to Use**:
- Charger service (port 9100) not responding
- Dashboard can't see charger status
- IPC state sync broken between services
- After major refactorings (skills migration, service restructuring)

---

## 🔴 Current Issue (as of 2026-06-19)

**Status**: Charger communication broken
**Root Cause**: TBD (likely skills migration or IPC sync issue)
**Impact**: Dashboard shows charger as offline, commands not reaching charger

---

## 🚀 Quick Recovery (5-10 minutes)

### Step 1: Verify Services Are Running
```bash
cd HuaweiDashboard
docker compose ps

# Should see all 3 services RUNNING:
# huawei-collector-service    ✅
# huawei-charger-service      ✅
# huawei-dashboard-service    ✅
```

**If charger service is NOT running**:
```bash
docker compose --profile modular up -d --build huawei-charger-service
sleep 5
docker logs huawei-charger-service --tail 50
# Look for errors in startup
```

### Step 2: Check OCPP Port 9100
```bash
# Is something listening on port 9100?
lsof -i :9100

# Should show: node process listening on 9100
# If not → charger crashed or didn't bind port
```

### Step 3: Verify IPC State Files
```bash
# All three files exist and are recent?
ls -lah storage/data/live-state-*.json

# Charger file being updated? (should change every ~1s)
watch -n 1 'stat storage/data/live-state-charger.json | grep Modify'

# If NOT updating → charger service stuck or dead
```

### Step 4: Check Logs for Errors
```bash
# What's happening in charger?
docker logs huawei-charger-service -f --tail 100

# Errors to look for:
# - "Cannot find module" → Import error (skills migration?)
# - "EADDRINUSE" → Port 9100 already in use
# - "SyntaxError" → Code error, lint check failed
# - "Cannot read property" → Missing IPC file
```

### Step 5: Last Resort - Full Restart
```bash
# Nuclear option
docker compose --profile modular down
rm -f storage/data/live-state-*.json storage/logs/*
docker compose --profile modular up -d --build

# Wait 15 seconds
sleep 15

# Check status
docker logs huawei-charger-service --tail 50
docker logs huawei-dashboard-service --tail 50
```

---

## 🔍 Root Cause Analysis

Based on `scratch/SESSION_LOG_2026-06-19.md`, most likely causes:

### Hypothesis A: Skills Migration Broke Imports (70% probability)
**Symptom**: Charger service fails to start with "Cannot find module" or "no such file"

**Context**: Skills were moved from `_skills/` to `~/.claude/skills/` in commit dc65074

**Check**:
```bash
grep -r "_skills/" backend/
# If found: code still references old path
```

**Fix**: Update imports in `backend/services/charger.ts` or wherever skills are referenced
```bash
# Old: import { ... } from '../../_skills/...'
# New: Delete imports (skills are docs, not code)
```

### Hypothesis B: OCPP Port Not Binding (15% probability)
**Symptom**: Port 9100 not listening, but no errors in logs

**Check**:
```bash
docker exec huawei-charger-service lsof -i :9100
# Or check docker-compose.yml ports config
```

**Fix**: Verify `docker-compose.yml` has correct port mapping:
```yaml
charger:
  ports:
    - "9100:9100"  # Should be here
```

### Hypothesis C: IPC State File Corruption (10% probability)
**Symptom**: Services start but can't read/write state files

**Check**:
```bash
cat storage/data/live-state-charger.json | jq .
# Should output valid JSON

# Check permissions
ls -l storage/data/
# Should be readable/writable by nobody (Docker user)
```

**Fix**: Delete and restart (services auto-create):
```bash
rm -f storage/data/live-state-*.json
docker restart huawei-charger-service
```

### Hypothesis D: SERVICE_ROLE Environment Variable (5% probability)
**Symptom**: Charger service running but behaving as dashboard or collector

**Check**:
```bash
docker exec huawei-charger-service env | grep SERVICE_ROLE
# Should output: SERVICE_ROLE=charger
```

**Fix**: Check `docker-compose.yml`:
```yaml
charger:
  environment:
    - SERVICE_ROLE=charger
    - NODE_ENV=production
```

---

## 📋 Systematic Debugging Flow

```
Service Running?
├─ NO → Deploy with: docker compose --profile modular up -d --build
└─ YES
   │
   Port 9100 Listening?
   ├─ NO → Check logs for bind errors
   └─ YES
      │
      IPC Files Updating?
      ├─ NO → Check file permissions or code errors
      └─ YES
         │
         Dashboard Can Connect?
         ├─ NO → Check OCPP WebSocket handshake
         └─ YES → ✅ RECOVERED
```

---

## 🛠️ After Fix: Update Documentation

Once you find the root cause and fix it:

### 1. Update `scratch/SESSION_LOG_2026-06-19.md`
```markdown
### 🔴 CURRENT ISSUE [NOW FIXED]
- **Root Cause**: [Describe what was broken]
- **Fix Applied**: [What you changed]
- **Date Fixed**: [Today's date]
- **Commit**: [commit hash]
```

### 2. Update `CHANGELOG.md`
Add under `[Unreleased] → Fixed`:
```markdown
- **Fix**: Restore charger communication
  - Root cause: [description]
  - Impact: Charger now successfully communicates with dashboard
```

### 3. Bump Version & Commit
```bash
npm run version:patch  # v0.1.0 → v0.1.1
git add .
git commit -m "fix: restore charger communication

Root cause: [what was broken]
Impact: Charger service now binds port 9100 successfully

See scratch/SESSION_LOG_2026-06-19.md for diagnosis details.
Closes [any issue if applicable]"

git tag v0.1.1
git push origin master --tags
```

---

## 🔗 Related Files

| File | Purpose |
|------|---------|
| `scratch/SESSION_LOG_2026-06-19.md` | Session bitacora (not in repo) |
| `RECOVERY_GUIDE.md` | Step-by-step diagnosis procedures |
| `CHANGELOG.md` | Release history |
| `ROADMAP.md` | Future features |
| `Agents.md` | Architecture overview |
| `docker-compose.yml` | Deployment config |
| `backend/services/charger.ts` | Charger service code |

---

## ⚠️ Critical Points

1. **Don't mix concerns**: Debugging logs are in `scratch/`, production docs in repo root
2. **Always document**: After fixing, update CHANGELOG + scratch log
3. **Verify multi-service**: Just because charger starts doesn't mean all 3 are synced
4. **Check timestamps**: IPC files should update every ~1s if services are healthy
5. **Port conflicts**: `lsof -i :9100` to verify nothing else is using it

---

## 📞 Questions to Ask

When stuck, consider:
- Are you running Docker locally or on a server?
- Are multiple instances of the app running (causing single-connection Modbus conflicts)?
- Did this break after a specific commit? (Check git log)
- Does it work in monolith mode (`--profile monolith`)?

---

## Version Info

- **Skill Created**: 2026-06-19
- **Applies to**: v0.1.0+
- **Last Updated**: 2026-06-19
- **Status**: Active

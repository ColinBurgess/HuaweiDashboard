# Recovery Guide - Charger Issues

## 🔴 Current Issue (Updated 2026-06-19 - REAL DATA)

### What Happened
- Power loss → charger powered off
- Power restored → charger rebooted
- Charger now in inconsistent state with custom OCPP server

### Current Symptoms
- ✅ **OCPP Communication Works**: Server receives/sends charger commands
- 🔴 **Charging Profile Blocked**: Setting profile + start charging → "BLOCKED" error
- 🔴 **PV-ONLY Mode Broken**: Charger waits infinitely for vehicle (no charging starts)
- 🔴 **Standard Charging Wrong**: Charges at max power (5.5kW), ignores PV production
  - Example: 4kW PV available → charger pulls 1kW from grid
  - Not optimal for cost savings

### Root Cause (Confirmed)
After power loss, charger firmware reset to defaults. Now there's a **configuration conflict** between:

| Component | State | Issue |
|-----------|-------|-------|
| Charger firmware | Reset to factory defaults | Expects native Huawei OCPP |
| Huawei app | Configured for inverter OCPP | PV-ONLY mode uses Huawei protocol |
| Custom OCPP server | Our custom handlers | Different message flow than Huawei |

**Result**: Charger can't reconcile both OCPP sources → blocking + infinite waits + wrong power

---

## ✅ Recovery Plan (2-Phase)

### Phase 1: Restore Known-Good State (Verify Hardware Works)

**Objective**: Confirm charger + Huawei inverter work WITHOUT custom server

**Steps**:

1. **Connect to charger as INSTALLER**
   - Access charger web interface or local app
   - Get to advanced settings (OCPP configuration)

2. **Remove Custom OCPP Server**
   - Delete/clear custom OCPP server URL
   - Point back to **Huawei inverter** native OCPP (your inverter's IP)
   - Factory reset OCPP settings if available

3. **Reboot Charger**
   - Via UI: Settings → Reboot
   - Or power cycle

4. **Wait for Connection** (2-3 minutes)
   - Charger should connect to Huawei inverter
   - Check Huawei app: charger status = "Connected"

5. **Verify with Huawei App**
   - [ ] Charger shows "Connected" to inverter
   - [ ] Can select "PV ONLY" mode
   - [ ] Plug in vehicle (if available)
   - [ ] Charging starts at **low power** (respecting solar)
   - [ ] NO "BLOCKED" errors
   - [ ] NO infinite waiting
   - [ ] Power ≤ available solar (no grid import)

**Success = All checkboxes pass** ✅

**If Phase 1 Fails** → Hardware issue (needs service)

**If Phase 1 Succeeds** → Proceed to Phase 2

---

### Phase 2: Reconfigure Custom OCPP Server (After Phase 1 Success)

**Objective**: Re-integrate our server while respecting power limits

**Steps**:

1. **Connect as installer again**

2. **Reconfigure OCPP Server URL**
   - Set to: `ws://localhost:9100` (our custom server)
   - Save

3. **Reboot Charger**

4. **Test Charging with Progressive Power Limits**
   ```bash
   # In charger config:
   Max Power = 1.0 kW  # Conservative start
   ```
   - Verify charger charges at ≤ 1 kW
   - Increase to 1.5 kW → 2 kW → 3 kW
   - Verify each limit is respected

5. **Integrate with Solar Data**
   - Our server reads `live-state-collector.json` (PV production)
   - Sets charger max power = available PV - margin
   - Example: 4 kW PV → limit charger to 3.5 kW
   - If 0 kW PV → limit charger to 0 kW (don't pull from grid)

**Success Criteria**:
- [ ] Server logs show OCPP messages received
- [ ] Charger respects power limits
- [ ] NO "BLOCKED" errors
- [ ] Charging stops when solar unavailable

---

## 📋 Before You Start Phase 1

Confirm these details:

1. **Do you have installer access** to charger?
2. **What is charger's IP** on network?
3. **What is Huawei inverter's IP**?
4. **Can you access Huawei app** to verify charger status?
5. **Do you have vehicle** to test charging?

---

## 🔧 Phase 1 Checklist

### Before
- [ ] Screenshot current charger settings
- [ ] Note charger software version
- [ ] Have installer credentials

### During
- [ ] Access charger as installer
- [ ] Find OCPP configuration
- [ ] Clear custom server URL
- [ ] Set to Huawei inverter (or leave default)
- [ ] Reboot charger
- [ ] Wait 3 minutes

### Verify
- [ ] Huawei app: charger "Connected"
- [ ] Can select PV-ONLY mode
- [ ] Vehicle charges low power
- [ ] No errors

---

## 📚 Related Files

| File | Purpose |
|------|---------|
| [scratch/SESSION_LOG_CHARGER_ISSUE_2026-06-19.md](scratch/SESSION_LOG_CHARGER_ISSUE_2026-06-19.md) | Detailed analysis + problem description |
| [CHANGELOG.md](CHANGELOG.md) | Will update after fix |
| [Agents.md](Agents.md) | Architecture + lessons learned |
| `.claude/skills/huawei-ocpp-charger/` | OCPP protocol details |
| `.claude/skills/huawei-docker-deployment/` | Charger deployment |

---

## Next Steps

1. **Execute Phase 1** → Verify charger + Huawei work
2. **Report results** → Works? Yes → Phase 2. No → Debug hardware.
3. **After Phase 2** → Test charging with custom server + solar integration
4. **Update CHANGELOG** → Document the fix

---

## Version Info

- **Updated**: 2026-06-19
- **Status**: In Progress (awaiting Phase 1 execution)
- **Data Source**: Real problem + user diagnosis (not speculation)

---

## Step-by-Step Recovery

### Step 1: Verify Service Is Running
```bash
docker ps | grep huawei-charger
# Should see something like:
# huawei-charger-service   node ...   SERVICE_ROLE=charger   9100/tcp
```

If NOT running:
```bash
docker compose --profile modular up -d --build huawei-charger-service
sleep 5
docker logs huawei-charger-service --tail 100
```

### Step 2: Check OCPP WebSocket on Port 9100
```bash
# macOS/Linux
lsof -i :9100
# Should show: node listening on 9100

# If nothing:
docker exec huawei-charger-service lsof -i :9100
# If still nothing → charger service didn't bind port
```

### Step 3: Verify IPC State Files
```bash
# Check all three exist
ls -la storage/data/live-state-*.json

# Check charger's file is being updated
watch -n 1 'stat storage/data/live-state-charger.json | grep Modify'
# Modification time should update every ~1s

# If NOT updating → charger service is stuck or dead
```

### Step 4: Test OCPP Connection Manually
```bash
# Try connecting to WebSocket
wscat -c ws://localhost:9100

# Or use curl (HTTP only):
curl -i http://localhost:9100

# If connection refused → port not listening
# If connection ok but WebSocket upgrade fails → check charger.ts
```

### Step 5: Check Dashboard Can See Charger
```bash
# Check live-state-dashboard.json includes charger data
cat storage/data/live-state-dashboard.json | jq '.charger'

# Should have fields like:
# {
#   "status": "Available",
#   "transactionId": null,
#   ...
# }
```

### Step 6: Nuke It and Rebuild
```bash
# Last resort - full restart
docker compose --profile modular down
rm -f storage/data/live-state-*.json
docker compose --profile modular up -d --build
sleep 10
docker logs huawei-charger-service --tail 100
```

---

## If Charger Starts But Dashboard Still Broken

The issue might be in the **dashboard service** not the charger.

```bash
# Check dashboard logs
docker logs huawei-dashboard-service --tail 100

# Check if dashboard can read charger file
docker exec huawei-dashboard-service cat /app/storage/data/live-state-charger.json

# Check if dashboard is serving port 3001
lsof -i :3001
curl -i http://localhost:3001
```

---

## Code Changes Needed (If Root Cause Found)

### If It's an Import Issue
```bash
# Grep for _skills references (old path)
grep -r "_skills/" backend/

# Replace with proper imports
# Old: import { ... } from '../../_skills/...'
# New: Just use the data directly or reference docs in CHANGELOG
```

### If It's a Service Role Issue
Check `docker-compose.yml`:
```yaml
charger:
  environment:
    - SERVICE_ROLE=charger  # MUST BE THIS
    - NODE_ENV=production
```

### If It's an IPC Issue
Check `backend/ipc/state-manager.ts`:
- File paths are correct: `storage/data/live-state-*.json`
- Permissions are correct: `-rw-r--r--`
- No hard-coded `/tmp/` paths

---

## After Fix: Testing Checklist

✅ Charger service logs show "OCPP Server listening on port 9100"
✅ Dashboard shows charger status (Online/Offline) in health panel
✅ Can send commands to charger via dashboard UI
✅ WebSocket messages flow between charger and dashboard
✅ `live-state-charger.json` updates every ~1s
✅ All three service logs show no errors

---

## Commit Template (After Fix)

```
fix: restore charger communication

Root cause: [describe what was broken]

Impact: Charger now successfully:
- Receives commands from dashboard
- Reports state via IPC to collector
- Maintains OCPP WebSocket connection

Verified with:
- Charger service on port 9100 ✓
- IPC state sync active ✓
- Dashboard health monitor shows ONLINE ✓

See `scratch/SESSION_LOG_2026-06-19.md` for context (not in repo).
Closes [any issue if applicable]
```

---

## Questions to Ask Next Session

1. Did the issue start after the skills migration?
2. Are you running modular or monolith mode?
3. What error does the dashboard show? (blank, timeout, 404, etc.)
4. Can you SSH into the container and manually check ports?


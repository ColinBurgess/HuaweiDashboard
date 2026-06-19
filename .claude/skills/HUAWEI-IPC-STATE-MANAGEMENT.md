---
name: huawei-ipc-state-management
description: Guide for understanding and debugging inter-process communication via shared JSON files. Use when adding state fields, debugging inconsistencies, or understanding service data issues.
---

# Huawei IPC & State Management

**Purpose**: Guide for understanding and debugging the inter-process communication layer via shared JSON files.

**When to use this skill**:
- Adding new fields to shared state
- Debugging state inconsistencies or race conditions
- Understanding why a service's data disappears
- Refactoring IPC layer or migrating to a message broker

---

## Architecture Overview

The project uses **file-based IPC** instead of Redis/queues. Each service is the "owner" of specific fields in shared JSON files:

```
storage/data/
├── live-state-collector.json    ← Inverter polling data + heartbeat
├── live-state-charger.json      ← Charger status + power, transaction ID
├── live-state-dashboard.json    ← User commands (start/stop/mode)
└── charger-state.json           ← Persisted charger config (restored on startup)
```

### Polling Mechanism

Every **1 second**, each service:
1. **Loads ALL files** (`loadLiveState()`)
2. **Merges data in memory** with its own updates
3. **Saves only its owned fields** (`saveLiveState()`)

```typescript
// Example: Collector service does this every 1s
inverterData.pv1Voltage = readFromModbus();
inverterData.inputPower = readFromModbus();
// ... update other fields ...
saveLiveState();  // Only writes: model, pv*, power, grid*, yield, temp, battery, status, services
```

---

## Field Ownership (Critical)

Each service **must own** specific fields to prevent overwriting:

| File | Owner (SERVICE_ROLE) | Owned Fields |
|------|---------------------|--------------|
| `live-state-collector.json` | `collector` | `model`, `pv1Voltage`, `pv1Current`, `pv2Voltage`, `pv2Current`, `inputPower`, `activePower`, `gridVoltage`, `gridFrequency`, `temperature`, `status`, `dailyYield`, `batteryPower`, `batterySOC`, `gridPower`, `consumption`, `houseLoad`, `lastUpdate`, `pvConnectionStatus`, `pvStringLossAlarm` |
| `live-state-charger.json` | `charger` | `cable`, `status`, `chargePointId`, `transactionId`, `startRequested`, `chargingMode`, `appliedCurrentLimitA`, `lastRequestedCurrentLimitA`, `powerW`, `energyWh` |
| `live-state-dashboard.json` | `dashboard` | `commandQueue`, `chargingMode` (commands only) |
| `charger-state.json` | `charger` | `chargingMode`, `startRequested`, `appliedCurrentLimitA`, `lastRequestedCurrentLimitA`, `transactionId` |

**Rule**: A service NEVER writes fields it doesn't own. Violation = data gets overwritten.

---

## Code Patterns

### Loading State (Safe)

```typescript
// At service startup or every 1s:
function loadLiveState() {
  const collector = JSON.parse(fs.readFileSync(COLLECTOR_STATE_PATH, 'utf8'));
  const charger = JSON.parse(fs.readFileSync(CHARGER_STATE_PATH, 'utf8'));
  const dashboard = JSON.parse(fs.readFileSync(DASHBOARD_STATE_PATH, 'utf8'));

  // Merge all into shared inverterData object
  Object.assign(inverterData, collector);
  Object.assign(chargerState, charger);

  // IMPORTANT: If you ARE the charger service, skip loading your own file
  // to avoid overwriting in-memory state with stale disk data
  if (process.env.SERVICE_ROLE !== 'charger') {
    Object.assign(chargerState, charger);
  }
}
```

### Saving State (Atomic)

```typescript
function saveLiveState() {
  const role = process.env.SERVICE_ROLE || 'monolith';

  // Create snapshot of owned fields
  const stateToSave = {
    // Only include fields THIS service owns
    model: inverterData.model,
    pv1Voltage: inverterData.pv1Voltage,
    // ... other owned fields ...
  };

  // Atomic write: .tmp → rename
  const tmpPath = STATE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(stateToSave, null, 2));
  fs.renameSync(tmpPath, STATE_PATH);  // Atomic, no partial writes
}
```

---

## Common Issues & Debugging

### Issue: Service X's data keeps disappearing

**Cause**: Another service is overwriting it.

**Fix**:
1. Identify which service owns the missing field (see table above)
2. Check if another service is writing to that field in `saveLiveState()`
3. Remove the unauthorized write

```typescript
// ❌ BAD: Collector writing charger fields
saveLiveState(); // Should NOT include powerW, transactionId, etc.

// ✅ GOOD: Only write owned fields
const stateToSave = {
  model: inverterData.model,
  inputPower: inverterData.inputPower,
  // charger fields left out
};
```

### Issue: Service reads stale data from disk

**Cause**: Service loads its own .json which has old data.

**Fix**:
```typescript
// When loading, skip YOUR OWN service file
if (process.env.SERVICE_ROLE === 'charger') {
  // Don't load live-state-charger.json, it's stale
  // Use in-memory chargerState instead
}
```

### Issue: Partial/corrupted JSON on disk (service crashed during write)

**Cause**: Write was not atomic.

**Fix**: Always use `.tmp` → `rename()` pattern:
```typescript
fs.writeFileSync(tmpPath, JSON.stringify(data));
fs.renameSync(tmpPath, finalPath);  // Atomic on POSIX systems
```

---

## Future Improvements

Current IPC via files is **not scalable**. Migration candidates:

1. **Redis**: Simple pub/sub + atomic operations
2. **gRPC**: Faster inter-process calls for commands
3. **OpenAPI**: Internal REST API for service discovery
4. **MQTT**: Real-time telemetry streaming

---

## Key Files

- [backend/ipc/state-manager.ts](../backend/ipc/state-manager.ts) → Main implementation
- [backend/services/inverter-collector.ts](../backend/services/inverter-collector.ts) → Example: Collector ownership
- [backend/services/ocpp-charger.ts](../backend/services/ocpp-charger.ts) → Example: Charger ownership
- [Agents.md](../Agents.md) → Historical lessons ("Guerra de Archivos")

---
name: huawei-ipc-state-management
description: >-
  Architectural specification and troubleshooting guide for file-based Inter-Process Communication (IPC) via shared JSON state files.
  Use this skill whenever modifying state-manager.ts, adding new fields to live-state JSONs, investigating data loss or race conditions across services, or implementing atomic disk writes (.tmp -> rename).
---

# Huawei IPC & State Management Specification

## Core IPC Architecture

The project uses a **file-based IPC model** via shared JSON files in `storage/data/`. Rather than using a message broker (e.g., Redis or MQTT), services poll, merge in memory, and persist state once per second.

```
storage/data/
├── live-state-collector.json    ← Inverter & Modbus polling data (Owner: collector)
├── live-state-charger.json      ← OCPP status, power, transaction ID (Owner: charger)
├── live-state-dashboard.json    ← User action commands & queues (Owner: dashboard)
└── charger-state.json           ← Persisted charger configuration
```

---

## Field Ownership Contract (Strict Enforcement)

**CRITICAL RULE ("Guerra de Archivos Avoidance"):** A service **MUST ONLY** write to fields it explicitly owns. Violating ownership causes services to overwrite each other's live telemetry in disk state.

| JSON File | Service Owner (`SERVICE_ROLE`) | Owned Fields (Exclusive Write Access) |
|---|---|---|
| `live-state-collector.json` | `collector` | `model`, `pv1Voltage`, `pv1Current`, `pv2Voltage`, `pv2Current`, `inputPower`, `activePower`, `gridVoltage`, `gridFrequency`, `temperature`, `status`, `dailyYield`, `batteryPower`, `batterySOC`, `gridPower`, `consumption`, `houseLoad`, `lastUpdate`, `pvConnectionStatus`, `pvStringLossAlarm` |
| `live-state-charger.json` | `charger` | `cable`, `status`, `chargePointId`, `transactionId`, `startRequested`, `chargingMode`, `appliedCurrentLimitA`, `lastRequestedCurrentLimitA`, `powerW`, `energyWh` |
| `live-state-dashboard.json` | `dashboard` | `commandQueue`, `chargingMode` (commands only) |
| `charger-state.json` | `charger` | `chargingMode`, `startRequested`, `appliedCurrentLimitA`, `lastRequestedCurrentLimitA`, `transactionId` |

---

## Standard Code Patterns

### 1. Atomic Disk Writes (Mandatory)

To prevent partial/corrupted JSON reads during concurrent disk access, **ALL disk writes MUST use temporary files and atomic POSIX renames**:

```typescript
import fs from 'fs';
import path from 'path';

export function saveLiveStateAtomic(filePath: string, dataToSave: Record<string, any>): void {
  const tmpPath = `${filePath}.tmp`;

  // 1. Write to temporary file
  fs.writeFileSync(tmpPath, JSON.stringify(dataToSave, null, 2), 'utf8');

  // 2. Atomic rename replaces target file cleanly
  fs.renameSync(tmpPath, filePath);
}
```

### 2. Safe State Loading (Skipping Self-Disk Load)

To prevent overwriting live in-memory telemetry with stale disk data upon polling:

```typescript
export function loadLiveState(): void {
  const currentRole = process.env.SERVICE_ROLE || 'monolith';

  // Read collector state
  if (fs.existsSync(COLLECTOR_STATE_PATH)) {
    const collector = JSON.parse(fs.readFileSync(COLLECTOR_STATE_PATH, 'utf8'));
    Object.assign(inverterData, collector);
  }

  // Read charger state ONLY if this service is NOT the charger itself
  if (currentRole !== 'charger' && fs.existsSync(CHARGER_STATE_PATH)) {
    const charger = JSON.parse(fs.readFileSync(CHARGER_STATE_PATH, 'utf8'));
    Object.assign(chargerState, charger);
  }
}
```

---

## IPC Troubleshooting Guide

### Issue 1: Data Fields Randomly Reset to Zero/Null
* **Cause:** Cross-writing violation. A non-owner service includes unowned fields in its `saveLiveState()` payload.
* **Fix:** Check `saveLiveState()` in the offending service. Filter out any fields not listed in the Ownership Matrix.

### Issue 2: `SyntaxError: Unexpected end of JSON input`
* **Cause:** Non-atomic file write interrupted during execution.
* **Fix:** Replace direct `fs.writeFileSync(TARGET)` with `saveLiveStateAtomic()` (`.tmp` → `fs.renameSync`).

### Issue 3: Charger Reverts to Stale Values on Restart
* **Cause:** Charger service loaded its own disk file on startup instead of keeping active in-memory variables.
* **Fix:** Ensure `process.env.SERVICE_ROLE === 'charger'` skips loading `live-state-charger.json` into its local primary variables.

---

## Associated Code Files

- `backend/ipc/state-manager.ts` → Core IPC loading and saving implementation.
-
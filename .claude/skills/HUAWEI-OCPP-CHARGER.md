---
name: huawei-ocpp-charger
description: Complete guide to OCPP 1.6 protocol, smart charging modes (FAST/GREEN/HYBRID), and charger service integration with inverter data. Use when debugging charger issues, adding OCPP handlers, or tuning charging parameters.
---

# Huawei OCPP Charger Service

**Purpose**: Understand the EV charger control protocol (OCPP 1.6), smart charging modes, and how the charger service integrates with inverter data.

**When to use this skill**:
- Debugging charger connection issues
- Adding new OCPP message handlers
- Tuning smart charging parameters (FAST, GREEN, HYBRID)
- Understanding SetChargingProfile and RemoteStartTransaction
- Analyzing charger state persistence

---

## Service Overview

The **Charger Service** (`backend/services/ocpp-charger.ts`) implements:

1. **OCPP 1.6 WebSocket Server** listening on port 9100
2. **Smart Charging Logic** (FAST, GREEN, HYBRID modes)
3. **Charger State Persistence** (`storage/data/charger-state.json`)
4. **Integration with Inverter Data** for solar-aware charging

---

## OCPP 1.6 Implemented Messages

### Received from Charger (Charger → Server)

| Message | Handler | Purpose |
|---------|---------|---------|
| `BootNotification` | `handleBootNotification()` | Charger announces startup, server responds with interval |
| `Heartbeat` | `handleHeartbeat()` | Charger ping, server responds with current time |
| `Authorize` | `handleAuthorize()` | Charger requests auth for RFID card, server accepts |
| `StatusNotification` | `handleStatusNotification()` | Charger reports status (Available, Occupied, etc.) |
| `MeterValues` | `handleMeterValues()` | Charger sends power/energy readings |
| `StartTransaction` | `handleStartTransaction()` | Session starts, charger requests transaction ID |
| `StopTransaction` | `handleStopTransaction()` | Session stops, reason could be Local/Other/EVDisconnected |
| `SecurityEventNotification` | ACK only | Security alert (rarely used) |
| `DiagnosticsStatusNotification` | ACK only | Diagnostic upload status |
| `FirmwareStatusNotification` | ACK only | Firmware update status |

### Sent to Charger (Server → Charger)

| Message | Purpose | When Sent |
|---------|---------|-----------|
| `RemoteStartTransaction` | Start charging session | User clicks "Start" + charger accepts |
| `RemoteStopTransaction` | Stop session | User clicks "Stop" or mode switches |
| `SetChargingProfile` | Limit current (FAST) or set dynamic limit (GREEN/HYBRID) | Every 30s in smart modes or probe test |
| `ClearChargingProfile` | Remove limits | Cleanup or mode change |
| `GetConfiguration` | Query charger settings | For smart probe detection |
| `ChangeConfiguration` | Enable meters or set heartbeat | Setup |
| `TriggerMessage` | Request immediate meter value | For faster feedback |

---

## Smart Charging Modes

### FAST

Charges at maximum allowed amps without solar restrictions.

```typescript
// User: chargingMode = 'FAST'
// Backend: RemoteStartTransaction + SetChargingProfile with max amps
// Example: 32A max

const maxAmps = GREEN_MAX_CHARGING_AMPS;  // 32A typical
const profile = {
  stackLevel: 0,
  chargingProfilePurpose: 'ChargePointMaxProfile',
  chargingProfileKind: 'Absolute',
  chargingSchedule: {
    duration: 86400,  // 24 hours
    chargingRateUnit: 'A',
    chargingSchedulePeriod: [
      { startPeriod: 0, limit: maxAmps }
    ]
  }
};
```

**When to use**: Off-peak hours, battery low, or user wants full charge ASAP.

### GREEN

Only charges with **surplus solar power**.

```
Calculation:
  surplusW = gridPower + chargerPower
  (if gridPower > 0: we're exporting to grid)
  (if chargerPower is positive: charger is using power)

  targetAmps = surplusW / GREEN_GRID_VOLTAGE  (e.g., 230V)
```

**Rules**:
- If targetAmps < 6A → Stop charging (minimum current too low)
- Apply hysteresis (200W default) to avoid toggling
- Update every 30 seconds

**Example**:
```
inverter.gridPower = +3000W (exporting)
charger.powerW = -1000W (consuming)
surplus = 3000 + 1000 = 4000W
targetAmps = 4000 / 230 ≈ 17.4A

→ Send SetChargingProfile with 17A
```

### HYBRID

Combines **guaranteed minimum** with solar surplus.

```
targetAmps = min(maxAmps, max(minAmps, surplusW / 230))
```

**Rules**:
- Start session: minimum 8A (configurable HYBRID_START_MIN_CHARGING_AMPS)
- Session active: minimum 7A (configurable HYBRID_MIN_CHARGING_AMPS)
- Above minimum: use surplus solar
- Example: 7A guaranteed + up to 25A from solar = 7-32A range

**Use case**: Want to ensure car charges but prioritize solar.

---

## Charging Profile (SetChargingProfile)

Structure sent to charger:

```typescript
interface ChargingProfile {
  id: number;
  stackLevel: number;  // 0 = ChargePoint override, 1 = Transaction, 2 = Smart probe
  chargingProfilePurpose: 'TxDefaultProfile' | 'ChargePointMaxProfile';
  chargingProfileKind: 'Absolute' | 'Recurring';
  chargingSchedule: {
    duration?: number;
    startSchedule?: string;  // ISO datetime
    chargingRateUnit: 'A' | 'W';
    minChargingRate?: number;
    chargingSchedulePeriod: [
      {
        startPeriod: number;  // seconds from start
        limit: number;        // amps or watts
        numberPhases?: number;
      }
    ]
  };
}
```

**Common profiles**:

1. **ChargePointMaxProfile** (stackLevel 0)
   - Limits what the charger is allowed to do
   - Highest priority, applies to all transactions
   - Used for FAST mode (high limit)

2. **TxProfile** (stackLevel 1)
   - Per-transaction limit
   - Used for GREEN/HYBRID (dynamic limit)

3. **Smart Probe** (stackLevel 2)
   - Low-priority probe to detect charger capabilities
   - Used on connect to determine if charger supports A/W limits

---

## State Persistence

The charger saves its state atomically to `storage/data/charger-state.json`:

```json
{
  "chargingMode": "FAST",
  "startRequested": true,
  "appliedCurrentLimitA": 32,
  "lastRequestedCurrentLimitA": 32,
  "transactionId": "TXN-2026-06-19-001",
  "cable": "EV Plugged",
  "status": "Charging",
  "powerW": 7500,
  "energyWh": 45000
}
```

### Restore on Startup

```typescript
function restorePersistedChargerState() {
  const saved = JSON.parse(fs.readFileSync('charger-state.json', 'utf8'));
  Object.assign(chargerState, saved);
  // On WebSocket connect, reconcile this state with actual charger
}
```

### Reconciliation

When charger reconnects after a crash:

1. Check if `transactionId` exists in memory
2. If charger has a different transaction → stop old one, start new
3. If charger lost connection mid-charge → resume with saved `appliedCurrentLimitA`
4. Prevent "loop protection" if charger keeps sending StopTransaction(Other)

---

## Anti-Loop Protection

Problem: Charger sends `StopTransaction(reason=Other)` repeatedly → infinite loop of attempts to restart.

Solution:

```typescript
let loopDetectionCounter = 0;
let loopDetectionCooldownMs = 0;

function handleStopTransaction(reason: string) {
  if (reason === 'Other') {
    loopDetectionCounter++;

    if (loopDetectionCounter >= 3) {
      console.warn('🔴 Loop detected: 3+ StopTransaction(Other) in short time');
      loopDetectionCooldownMs = 60000;  // 60s cooldown
      loopDetectionCounter = 0;
      return;  // Don't retry
    }
  }

  if (loopDetectionCooldownMs > 0) {
    return;  // In cooldown, skip rearming
  }

  // Normal flow: rearming logic here
}
```

---

## Smart Charging Probe

Used on charger connect to detect capabilities.

```typescript
// Probe Scenario 1: Charger supports Amps
const probeProfile = {
  stackLevel: 2,  // Low priority
  chargingProfilePurpose: 'ChargePointMaxProfile',
  chargingProfileKind: 'Absolute',
  chargingSchedule: {
    duration: 30,
    chargingRateUnit: 'A',
    chargingSchedulePeriod: [
      { startPeriod: 0, limit: 8 }  // Low test limit
    ]
  }
};
```

If charger accepts → supports amps. If rejects → try watts.

---

## Integration with Inverter Data

The charger continuously reads from `inverterData`:

```typescript
// In GREEN mode decision loop:
const inverter = await loadLiveState();  // Load from disk
const surplus = inverter.gridPower + chargerPower;
const targetAmps = Math.max(6, surplus / GREEN_GRID_VOLTAGE);

await setChargingLimit(targetAmps);
```

**Data flow**:
```
Inverter Collector → live-state-collector.json (gridPower, inputPower)
                  ↓
              State Manager (loadLiveState)
                  ↓
          Charger reads inverterData
                  ↓
          Calculates surplusW → targetAmps
                  ↓
          SetChargingProfile(targetAmps)
```

---

## Configuration (Constants)

In `backend/config/constants.ts`:

```typescript
OCPP_HOST = '0.0.0.0';               // Listen on all interfaces
OCPP_PORT = 9100;                    // WebSocket port
OCPP_HEARTBEAT_INTERVAL = 30;        // seconds

GREEN_GRID_VOLTAGE = 230;             // For A/W conversion
GREEN_MAX_CHARGING_AMPS = 32;         // Max limit in FAST
GREEN_HYSTERESIS_WATTS = 200;         // Min change to update profile

HYBRID_MIN_CHARGING_AMPS = 7;         // Guaranteed min
HYBRID_START_MIN_CHARGING_AMPS = 8;   // Min at start
```

---

## Debugging Checklist

### Charger not connecting

- [ ] Charger OCPP URL configured correctly (`ws://[dashboard-ip]:9100/ocpp/CP001`)
- [ ] Dashboard port (3001) and OCPP port (9100) are accessible from charger
- [ ] No firewall blocking 9100
- [ ] Check logs for `BootNotification` received
- [ ] Is another instance running on same port?

### Charging not starting

- [ ] User clicked "Start" in UI (checks `chargeState.startRequested`)
- [ ] Charger cable connected (check `StatusNotification` shows "Occupied" or "Charging")
- [ ] RemoteStartTransaction sent to charger (check logs)
- [ ] Current limit set via SetChargingProfile (check latest profile)
- [ ] Charger in correct mode (not error state)

### Current limit not applied

- [ ] GREEN/HYBRID mode: check `gridPower` from inverter (is surplus calculated correctly?)
- [ ] Hysteresis threshold: change might be <200W (no update sent)
- [ ] Check if `OCPP_SMART_PROBE_ON_CONNECT` is interfering (now set to `0`)
- [ ] Check if SetChargingProfile response is OK or error

### Charger disconnects after charging

- [ ] Check `StopTransaction` reason (Local, EVDisconnected, Other?)
- [ ] If reason=Other repeatedly → loop protection activated
- [ ] Check `loopDetectionCooldownMs` in logs
- [ ] Some chargers require specific cable status handling

### Green mode charging stops at 6A

- [ ] 6A is the hardcoded minimum (prevents unstable low-current charges)
- [ ] Surplus must be >1380W (6A × 230V) to keep charging
- [ ] Check inverter's `gridPower` is actually positive (exporting)

---

## Key Files

- [backend/services/ocpp-charger.ts](../backend/services/ocpp-charger.ts) → Main service
- [backend/config/constants.ts](../backend/config/constants.ts) → OCPP config & limits
- [backend/ipc/state-manager.ts](../backend/ipc/state-manager.ts) → State loading
- [OCPP 1.6 Spec](https://www.openchargealliance.org/) → Official protocol docs

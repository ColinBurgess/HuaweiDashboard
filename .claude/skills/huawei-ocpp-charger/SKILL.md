---
name: huawei-ocpp-charger
description: >-
  Technical specification for the OCPP 1.6 WebSocket server (ocpp-charger.ts), EV smart charging modes (FAST, GREEN, HYBRID), SetChargingProfile formatting, and inverter solar surplus integration.
  Use this skill whenever adding OCPP message handlers, debugging charger WebSocket connections on port 9100, adjusting dynamic current limits, or resolving transaction retry loops.
---

# Huawei OCPP Charger Service Specification

## Service Architecture Overview

The Charger Service (`backend/services/ocpp-charger.ts`) acts as a central system for EV charge points using the **OCPP 1.6 JSON-over-WebSocket** protocol on port **9100**. It correlates live inverter solar telemetry with EV charging commands.

```
                  ┌──────────────────────────────┐
                  │   EV Charger (e.g., CP001)   │
                  └──────────────┬───────────────┘
                                 │ OCPP 1.6 WS (ws://host:9100/ocpp/CP001)
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ocpp-charger.ts Service                     │
│  ├─ WebSocket Server (Port 9100)                                │
│  ├─ Smart Charging Mode Engine (FAST / GREEN / HYBRID)          │
│  ├─ Anti-Loop Protection Guard                                  │
│  └─ Persisted State Sync (storage/data/charger-state.json)      │
└────────────────────────────────┬────────────────────────────────┘
                                 │ Reads live telemetry
                                 ▼
                    live-state-collector.json
                   (gridPower & inputPower)
```

---

## OCPP 1.6 Message Handlers

### Inbound Messages (Charger → Server)

| Message Type | Service Handler | Action / Response |
|---|---|---|
| `BootNotification` | `handleBootNotification()` | Registers charge point ID, returns heartbeat interval (30s) and status `Accepted`. |
| `Heartbeat` | `handleHeartbeat()` | Updates timestamp, responds with current UTC server time. |
| `Authorize` | `handleAuthorize()` | Validates RFID tag / ID token, returns status `Accepted`. |
| `StatusNotification` | `handleStatusNotification()` | Tracks status transitions (`Available`, `Preparing`, `Charging`, `Faulted`). |
| `MeterValues` | `handleMeterValues()` | Extracts active power (`W`) and energy counter (`Wh`). |
| `StartTransaction` | `handleStartTransaction()` | Allocates local transaction ID (`TXN-YYYY-MM-DD-XXX`) and acknowledges. |
| `StopTransaction` | `handleStopTransaction()` | Handles session end, reason code inspection, and triggers rearming/cooldown guard. |

### Outbound Messages (Server → Charger)

| Message Type | Purpose | Trigger Event |
|---|---|---|
| `RemoteStartTransaction` | Initiates charging session | UI "Start Charge" request or auto-rearm |
| `RemoteStopTransaction` | Terminates active session | UI "Stop Charge" or mode change stop |
| `SetChargingProfile` | Transmits dynamic current limit (Amps) | Every 30s in smart modes or on manual override |
| `ClearChargingProfile` | Clears profile constraints | Mode transition / cleanup |

---

## Smart Charging Modes & Mathematics

Current calculations use nominal voltage $V = 230\text{V}$ (`GREEN_GRID_VOLTAGE`).

### 1. FAST Mode
* **Logic:** Charges at maximum allowed physical limit regardless of solar output.
* **Current Limit Formula:**
  $$\text{TargetAmps} = \text{GREEN\_MAX\_CHARGING\_AMPS} \quad (\text{Default: } 32\text{A})$$

### 2. GREEN Mode (Pure Solar Surplus)
* **Logic:** Adjusts charging current exclusively based on available solar export to grid.
* **Surplus Calculation:**
  $$\text{SurplusW} = \text{inverter.gridPower} + \text{charger.powerW}$$
  *(where positive `gridPower` represents export to grid).*
* **Current Limit Formula:**
  $$\text{TargetAmps} = \left\lfloor \frac{\text{SurplusW}}{230} \right\rfloor$$
* **Constraints:**
  * If $\text{TargetAmps} < 6\text{A}$ ($<1380\text{W}$ surplus), trigger session stop or drop limit to 0A to prevent relay chatter.
  * **Hysteresis:** Apply a minimum change threshold of $200\text{W}$ before transmitting an updated `SetChargingProfile`.

### 3. HYBRID Mode (Guaranteed Minimum + Solar Surplus)
* **Logic:** Blends a guaranteed minimum grid charge with dynamic solar surplus.
* **Current Limit Formula:**
  $$\text{TargetAmps} = \min\left(\text{MaxAmps}, \, \max\left(\text{MinAmps}, \, \left\lfloor \frac{\text{SurplusW}}{230} \right\rfloor\right)\right)$$
* **Minimum Amps Rules:**
  * **Session Start:** `HYBRID_START_MIN_CHARGING_AMPS` ($8\text{A}$ default).
  * **Active Session:** `HYBRID_MIN_CHARGING_AMPS` ($7\text{A}$ default).

---

## `SetChargingProfile` Structure Template

```typescript
const chargingProfilePayload = {
  connectorId: 1,
  csChargingProfiles: {
    chargingProfileId: 100,
    stackLevel: 0, // 0 = ChargePointMaxProfile override
    chargingProfilePurpose: 'ChargePointMaxProfile',
    chargingProfileKind: 'Absolute',
    chargingSchedule: {
      duration: 86400, // 24 Hours
      chargingRateUnit: 'A',
      chargingSchedulePeriod: [
        {
          startPeriod: 0,
          limit: targetAmps // Calculated integer (6A - 32A)
        }
      ]
    }
  }
};
```

---

## Resiliency & Anti-Loop Protection

When a charger repeatedly transmits `StopTransaction(reason="Other")` during automated remote starts, it can trigger an infinite command loop.

### Protection Logic Implementation:
1. Maintain `loopDetectionCounter`.
2. Increment counter on every `StopTransaction` where `reason === 'Other'`.
3. If `loopDetectionCounter >= 3` within 120 seconds:
   * Activate **60-second cooldown** (`loopDetectionCooldownMs = 60000`).
   * Suppress `RemoteStartTransaction` retries until cooldown expires.
   * Emit warning log: `🔴 Loop detected: 3+ StopTransaction(Other) in short time`.

---

## Configuration Variables

Defined in `backend/config/constants.ts`:

```typescript
export const OCPP_HOST = '0.0.0.0';
export const OCPP_PORT = 9100;
export const OCPP_HEARTBEAT_INTERVAL = 30;

export const GREEN_GRID_VOLTAGE = 230;
export const GREEN_MAX_CHARGING_AMPS = 32;
export const GREEN_HYSTERESIS_WATTS = 200;

export const HYBRID_MIN_CHARGING_AMPS = 7;
export const HYBRID_START_MIN_CHARGING_AMPS = 8;
```

---

## Associated Code Files

- `backend/services/ocpp-charger.ts` → OCPP WebSocket server and charging logic.
- `backend/config/constants.ts` → Thresholds, voltages, and hysteresis constants.
- `storage/data/charger-state.json` → Persisted state on disk.
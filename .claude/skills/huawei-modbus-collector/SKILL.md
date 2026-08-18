---
name: huawei-modbus-collector
description: >-
  Technical specification for the Huawei Modbus TCP polling service (inverter-collector.ts), register maps, port rotation, and exponential backoff reconnection.
  Use this skill whenever adding Modbus registers, debugging inverter connection timeouts, tuning polling intervals/delays, or troubleshooting JSONL telemetry persistence.
---

# Huawei Modbus Collector & Reconnection Specification

## Service Role & Workflow

The Collector service (`backend/services/inverter-collector.ts`) executes a polling loop to extract telemetry via Modbus TCP from the inverter, process raw registers, write history logs, and update live IPC state.

```
1. Startup -> connectModbus() -> Read Model Identity (30000)
2. Polling Loop (Every MODBUS_POLLING_INTERVAL ms):
   ├─ Read Operation Block (32016, 100) -> PV, Power, Yield, Temp
   ├─ Delay 60ms
   ├─ Read Grid Meter (37113, 2)      -> Net Grid Import/Export
   ├─ Delay 60ms
   ├─ Read PV Status (32002, 1)        -> Connection & Alarm Flags
   ├─ Delay 60ms
   └─ Save IPC Live State & Append to YYYY-MM-DD.jsonl History
```

---

## Modbus Register Reference Map

| Register Address | Length (Words) | Data Type | Field Description | Unit / Scale |
|---|---|---|---|---|
| `30000` | 15 | String | Inverter Model (e.g., SUN2000-3.68KTL-JP-1) | ASCII |
| `30015` | 10 | String | Inverter Serial Number | ASCII |
| `32016` | 100 | Block | PV strings (V/A), Input Power, Active AC Power, Temp, Yield | Multiple |
| `32002` | 1 | Bitmask | PV Connection Status (Bit 1 = Connected/Trip) | Bit 1 |
| `32010` | 1 | Bitmask | Alarm Flags (Bit 6 = String Loss Alarm ID 2015) | Bit 6 |
| `37113` | 2 | Signed i32 | Power Meter (+ Export to Grid, - Import from Grid) | Watts (W) |
| `37001` | 2 | Signed i32 | Battery Charge/Discharge Power (if enabled) | Watts (W) |
| `37004` | 1 | u16 | Battery State of Charge (SOC) | 0-1000 (0.1%) |

*Note: Delays (60ms) between read commands are mandatory to avoid tripping Modbus socket buffer overflows on Huawei hardware.*

---

## Reconnection & Resiliency Algorithm

When network instability or Modbus read timeouts occur, the collector executes an automatic 3-phase resilience algorithm:

### Phase 1: Timeout Threshold Detection
* Maintain a counter of consecutive read failures (`consecutiveModbusTimeouts`).
* **Threshold Trigger:** If `consecutiveModbusTimeouts >= 3`, invoke `socket.destroy()`, reset `reconnectAttempts = 0`, and trigger a clean reconnect after 500ms.

### Phase 2: Exponential Backoff Math
When connection fails on socket establishment, apply an exponential backoff delay capped at 120s:

$$\text{Delay} = \min\left(5000 \times 2^{\text{reconnectAttempts}}, \, 120000\right) \text{ ms}$$

* **Attempt 1:** 5s
* **Attempt 2:** 10s
* **Attempt 3:** 20s
* **Attempt 4:** 40s
* **Attempt 5:** 80s
* **Attempt 6+:** 120s (Cap)

Upon successful connection (`socket.on('connect')`), immediately reset `reconnectAttempts = 0` and `consecutiveModbusTimeouts = 0`.

### Phase 3: Port Rotation & Watchdog

* **Port Cycling:** After 3 consecutive failed socket connection attempts on port `502`, cycle the active port target to `6607` (and vice-versa) using `MODBUS_PORTS = [502, 6607]`.
* **Watchdog Loop (Every 30s):** If `inverterData.connected === false` and time offline exceeds **60 seconds**, forcefully trigger `connectModbus()`. If offline exceeds **300 seconds (5 mins)**, log a CRITICAL alert.

---

## Telemetry Validation & Persistence Rules

Before appending a record to `storage/history/YYYY-MM-DD.jsonl`, validate the payload against these criteria:

```json
{
  "time": "2026-08-18T10:00:00.000Z",
  "power": 4200,
  "inputPower": 5100,
  "consumption": 800,
  "batterySOC": 87.5,
  "gridPower": 1100,
  "pv1Power": 2550,
  "pv2Power": 2550
}
```

**Validation Criteria:**
- [x] Modbus block `32016` read without socket error.
- [x] Grid meter `37113` read successfully (required to compute `houseLoad`).
- [x] No values contain `NaN`, `null`, or `Infinity`.
*If validation fails, skip writing to JSONL and emit a log warning.*

---

## Configuration Variables

Defined in `backend/config/constants.ts`:

```typescript
export const MODBUS_HOST = process.env.MODBUS_HOST || '192.168.1.140';
export const MODBUS_PORTS = process.env.MODBUS_PORTS?.split(',').map(Number) || [502, 6607];
export const MODBUS_POLLING_INTERVAL = 2000; // 2000ms poll cycle
export const MODBUS_HAS_BATTERY = process.env.MODBUS_HAS_BATTERY === 'true';
```

---

## Related Codebase Files

- `backend/services/inverter-collector.ts` → Collector polling logic & watchdog.
- `backend/config/constants.ts` → Register maps, host IPs, and constants.
- `backend/utils/converters.ts` → Word decoding helper functions (`u16ToStr`, `i32FromRegs`).
- `Agents.md` → Post-mortem records on Modbus socket concurrency.
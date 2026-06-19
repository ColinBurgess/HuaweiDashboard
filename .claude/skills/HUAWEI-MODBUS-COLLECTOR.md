---
name: huawei-modbus-collector
description: Complete guide for Modbus polling service, connection management, and exponential backoff reconnection system. Use when collector is offline, adding registers, tuning intervals, or implementing reconnection patterns.
---

# Huawei Modbus Collector & Reconnection

**Purpose**: Complete guide for understanding the Modbus polling service, connection management, and the new exponential backoff reconnection system.

**When to use this skill**:
- Collector service is not connecting or stuck offline
- Adding new Modbus registers to monitor
- Tuning polling intervals or timeouts
- Understanding port rotation and backoff logic
- Implementing similar reconnection patterns elsewhere

---

## Service Overview

The **Collector Service** (`backend/services/inverter-collector.ts`) is responsible for:

1. **Modbus TCP polling** every N milliseconds (configurable)
2. **Register reading** with proper conversions (u16, i32, etc.)
3. **Telemetry persistence** to daily JSONL history files
4. **PV status monitoring** (connection loss, string failures)
5. **Automatic reconnection** with exponential backoff (NEW)

---

## Connection Lifecycle

### Startup Phase

```
1. connectModbus()           → Initiate TCP connection
2. socket.on('connect')      → handleModbusConnect()
3. Reset counters            → consecutiveModbusTimeouts = 0
4. Read identity             → model, serialNumber (once only)
5. pollInverter() loop       → Every MODBUS_POLLING_INTERVAL
```

### Active Polling

```
pollInverter():
  ├─ Read Identity         [Register 30000, 30015]
  ├─ Read Operation Block  [Register 32016, 100]  ← PV, input, active, temp, yield
  ├─ delay(60ms)
  ├─ Read Grid Meter       [Register 37113, 2]    ← gridPower
  ├─ delay(60ms)
  ├─ Read PV Status        [Register 32002, 1]    ← pvConnectionStatus
  ├─ delay(60ms)
  ├─ Read PV Alarm         [Register 32010, 1]    ← pvStringLossAlarm
  ├─ (optional) Read Battery [Register 37001/37004]
  ├─ Calculate houseLoad
  ├─ Validate sample completeness
  └─ Write to history JSONL + InfluxDB
```

**Delays between sections**: Prevent overloading Modbus with rapid requests.

---

## Register Map (Important Ones)

| Address | Length | What | Example |
|---------|--------|------|---------|
| 30000   | 15     | Model string | "SUN2000-3.68KTL-JP-1" |
| 30015   | 10     | Serial number | "NSxxxxxxxxxx" |
| 32016   | 100    | **PV strings, input power, active power, temperature, yield** | Largest block |
| 32002   | 1      | Status flags (includes PV connection Bit 1) | 0x0001 = connected |
| 32010   | 1      | Alarm flags (includes string loss Bit 6) | 0x0040 = alarm active |
| 37113   | 2      | Grid power (import/export, signed i32) | +5000 = export, -2000 = import |
| 37001   | 2      | Battery power | (if MODBUS_HAS_BATTERY=true) |
| 37004   | 1      | Battery SOC | 0-1000 = 0%-100% (divide by 10) |

---

## Reconnection Strategy (Exponential Backoff)

### New in v2 (After Timeout Fix)

When **3+ consecutive Modbus timeouts** are detected:

1. **Timeout Detection**
   ```typescript
   consecutiveModbusTimeouts++  // Increments on each read failure
   if (consecutiveModbusTimeouts >= 3) {
     socket.destroy();           // Force disconnect
     reconnectAttempts = 0;      // Reset to allow immediate attempt
     setTimeout(connectModbus, 500ms);  // Schedule reconnect ASAP
   }
   ```

2. **Exponential Backoff**
   ```
   Attempt 1: wait 5s   (5000 * 2^0)
   Attempt 2: wait 10s  (5000 * 2^1)
   Attempt 3: wait 20s  (5000 * 2^2)
   Attempt 4: wait 40s  (5000 * 2^3)
   Attempt 5: wait 80s  (5000 * 2^4)
   ... capped at 120s (2 minutes)
   ```

3. **Reset on Success**
   ```typescript
   handleModbusConnect() {
     reconnectAttempts = 0;  // Reset backoff
     consecutiveModbusTimeouts = 0;
   }
   ```

### Watchdog (NEW)

Runs every 30 seconds:

```typescript
if (!inverterData.connected) {
  const timeOffline = Date.now() - lastDisconnectTime;

  if (timeOffline > 60000) {
    console.warn('Offline > 60s. Forcing reconnection attempt...');
    connectModbus();
  }

  if (timeOffline > 300000) {
    console.error('🚨 CRITICAL: Offline for 5+ minutes!');
  }
}
```

---

## Port Rotation

Huawei inverters can listen on multiple Modbus ports:

```typescript
MODBUS_PORTS = [502, 6607];  // Default: try 502 first, fallback to 6607

// After 3 consecutive connection failures:
modbusPortIndex = (modbusPortIndex + 1) % MODBUS_PORTS.length;
// Cycle to next port and retry
```

**Use case**: Some Huawei setups use non-standard ports or require fallback.

---

## Timeout Handling

### Types of Timeouts

1. **Socket Timeout**: Connection lost mid-read
   ```
   "Req timed out" → consecutiveModbusTimeouts++
   ```

2. **Connection Timeout**: Can't reach inverter
   ```
   socket.on('error') → handleModbusError() → reconnect with backoff
   ```

3. **Persistent Timeouts** (3+ in a row)
   ```
   socket.destroy() + immediate reconnect attempt
   ```

### Timeout Detection Logic

```typescript
try {
  const res = await client.readHoldingRegisters(32016, 100);
  consecutiveModbusTimeouts = 0;  // Reset on success
  lastSuccessfulReadTime = Date.now();
} catch (err) {
  consecutiveModbusTimeouts++;
  if (consecutiveModbusTimeouts >= 3) {
    socket.destroy();
    reconnectAttempts = 0;
    setTimeout(connectModbus, 500);
  }
}
```

---

## History Persistence

Every valid telemetry sample is saved to:

```
storage/history/YYYY-MM-DD.jsonl
```

Each line:
```json
{
  "time": "2026-06-19T10:00:00.000Z",
  "power": 4200,
  "inputPower": 5100,
  "consumption": 800,
  "batterySOC": 87.5,
  "gridPower": 1100,
  "pv1Power": 2550,
  "pv2Power": 2550
}
```

**Requirements for valid sample**:
- ✅ PV data read successfully
- ✅ Input power read
- ✅ Active power read
- ✅ Grid meter read
- ✅ All values are finite numbers

If any section fails → skip write (warns in logs).

---

## Configuration (Constants)

In `backend/config/constants.ts`:

```typescript
MODBUS_HOST = process.env.MODBUS_HOST || '192.168.1.140';
MODBUS_PORTS = process.env.MODBUS_PORTS?.split(',').map(Number) || [502, 6607];
MODBUS_POLLING_INTERVAL = 2000;  // 2 seconds between full polls
MODBUS_HAS_BATTERY = process.env.MODBUS_HAS_BATTERY === 'true';
```

---

## PV Status Monitoring

The collector also monitors:

1. **PV Connection Status** (Bit 1 of Register 32002)
   ```
   0 = Disconnected (Automatico has tripped)
   1 = Connected (Normal)
   ```
   → Sends Telegram alert on state transition

2. **PV String Loss Alarm** (Bit 6 of Register 32010)
   ```
   0 = No alarm
   1 = String failure detected (Alarm ID: 2015)
   ```
   → Sends Telegram alert

**Grace Period**: First 30s ignores transient changes on startup (prevents false alerts).

---

## Debugging Checklist

### Collector not connecting

- [ ] `MODBUS_HOST` is correct IP (e.g., 192.168.1.140)
- [ ] `MODBUS_PORTS` include both 502 and 6607
- [ ] Inverter is powered on and reachable (`ping` from same network)
- [ ] No firewall blocking TCP 502/6607
- [ ] In Docker: check if collector service is actually running (`docker compose ps`)
- [ ] Check logs for port rotation attempts
- [ ] Is another process (e.g., dev instance) already connected to the inverter? (Modbus is single-connection)

### Timeouts occurring

- [ ] Network latency to inverter (try ping RTT)
- [ ] Modbus registers 32016+ are accessible (some Huawei models have restrictions)
- [ ] Load on inverter high (many WebSocket clients, logging enabled)
- [ ] Check `lastSuccessfulReadTime` in health monitor
- [ ] Watchdog should attempt reconnect after 60s offline

### Data missing from history

- [ ] Check `storage/history/YYYY-MM-DD.jsonl` file exists
- [ ] Sample validation failed (inspect logs for "Skipping history write")
- [ ] Grid meter read (37113) failed → houseLoad can't be calculated
- [ ] Check `combined.jsonl` to see if collector is even polling

### PV Connection Lost alerts but it's actually connected

- [ ] Grace period might still be active (first 30s)
- [ ] Bit 1 of Register 32002 might be inverted on this Huawei model
- [ ] Check raw register value with Modbus client tool

---

## Key Files

- [backend/services/inverter-collector.ts](../backend/services/inverter-collector.ts) → Main service
- [backend/config/constants.ts](../backend/config/constants.ts) → Configuration & register map
- [backend/utils/converters.ts](../backend/utils/converters.ts) → u16ToStr(), i32FromRegs()
- [Agents.md](../Agents.md) → "Instancias Simultáneas y Modbus" lesson

---

## Recent Changes (2026-06-19)

- ✅ Added exponential backoff for reconnection (BASE: 5s, MAX: 2min)
- ✅ Added watchdog monitor (checks every 30s, forces reconnect if offline >60s)
- ✅ Reset `reconnectAttempts` on successful connection
- ✅ Immediate reconnect attempt (500ms) after socket.destroy()
- ✅ Improved logging visibility ("🔄 Attempting...", "⏱️ Scheduling...")
- ✅ Health heartbeat now shows reconnect attempts count

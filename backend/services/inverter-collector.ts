/**
 * Inverter Data Collector Service
 * Handles Modbus TCP polling from Huawei inverter and telemetry persistence
 * Runs in: monolith mode or 'collector' service role
 */

import net from 'net';
import path from 'path';
import fs from 'fs';
// @ts-ignore
import { client as ModbusClient } from 'jsmodbus';
import {
  PORT,
  MODBUS_HOST,
  MODBUS_PORTS,
  SLAVE_ID,
  MODBUS_REGISTRY_MAP,
  MODBUS_HAS_BATTERY,
  MODBUS_POLLING_INTERVAL,
  HISTORY_DIR,
  DATA_DIR,
} from '../config/constants.js';
import {
  u16ToStr,
  i32FromRegs,
  u32FromRegs,
} from '../utils/converters.js';
import {
  writeToInflux,
} from '../utils/stats.js';
import {
  inverterData,
  chargerState,
  saveLiveState,
  loadLiveState,
  restorePersistedChargerState,
} from '../ipc/state-manager.js';
import {
  alertInverterDisconnected,
  alertInverterReconnected,
  alertPvDisconnected,
  alertPvReconnected,
  alertPvStringLoss,
  isTelegramEnabled,
} from './telegram.js';
import { PvAlertMonitor } from './pv-alert-monitor.js';

// ============================================================================
// MODBUS CLIENT INITIALIZATION
// ============================================================================

const isCollector = process.env.SERVICE_ROLE === 'collector' || process.env.START_MONOLITH === 'true';

/**
 * TCP socket for Modbus communication
 * Only initialized if running as collector or monolith
 */
const socket = isCollector ? new net.Socket() : null;

/**
 * Modbus TCP client
 * Only initialized if socket exists
 */
const client = socket ? new ModbusClient.TCP(socket, SLAVE_ID) : null;

// ============================================================================
// STATE TRACKING
// ============================================================================

let modbusPortIndex = 0;
let modbusConsecutiveConnectionFailures = 0;
let isConnecting = false;
let hasAlertedDisconnection = false;
let reconnectAttempts = 0;
let lastReconnectAttemptTime = 0;
const BASE_RECONNECT_DELAY_MS = 5000;  // 5 seconds
const MAX_RECONNECT_DELAY_MS = 120000; // 2 minutes
let lastDisconnectTime = 0;
let hasAlertedPersistentDisconnection = false;

let pvConnectionStatusReadAt = 0;
let pvStringLossAlarmReadAt = 0;

// Device Status Monitoring (Register 32089)
// Used to differentiate between Standby (expected offline) vs actual disconnection
let lastInverterStatus = -1; // -1 = unknown, 0-3 = Standby, 256-771 = other states
let lastStatusChangeTime = 0;
const STANDBY_STATES = [0, 1, 2, 3]; // All Standby variants
const pvAlertMonitor = new PvAlertMonitor({
  startupGraceMs: Math.max(0, Number(process.env.PV_ALERT_STARTUP_GRACE_MS ?? 60000)),
  disconnectConfirmMs: Math.max(0, Number(process.env.PV_ALERT_DISCONNECT_CONFIRM_MS ?? 180000)),
  reconnectConfirmMs: Math.max(0, Number(process.env.PV_ALERT_RECONNECT_CONFIRM_MS ?? 60000)),
  stringLossConfirmMs: Math.max(0, Number(process.env.PV_ALERT_STRING_LOSS_CONFIRM_MS ?? 60000)),
  statusMaxAgeMs: Math.max(5000, Number(process.env.PV_ALERT_STATUS_MAX_AGE_MS ?? 15000)),
  standbyStatuses: STANDBY_STATES,
});

// Telemetry
let firstTelemetrySyncLogged = false;
let consecutiveModbusTimeouts = 0;
let lastSuccessfulReadTime = 0;

// ============================================================================
// UTILITIES
// ============================================================================

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Map device status code to human-readable name (from Huawei SUN2000 specs)
 */
function getStatusName(status: number): string {
  const statuses: Record<number, string> = {
    0: 'Standby: initializing',
    1: 'Standby: insulation detecting',
    2: 'Standby: irradiation detecting',
    3: 'Standby: grid detecting',
    256: 'Starting',
    512: 'On-grid / Running',
    513: 'Grid: power limited',
    514: 'Grid: self-derating',
    515: 'Off-grid running',
    768: 'Shutdown: fault',
    769: 'Shutdown: command',
    770: 'Shutdown: OVGR',
    771: 'Shutdown: communication'
  };
  return statuses[status] ?? `Unknown (${status})`;
}

/**
 * Log device status changes to a dedicated file (separate from main logs)
 * Useful for diagnosing inverter state transitions and troubleshooting
 */
function logStatusChange(status: number, reason: string = ''): void {
  const timestamp = new Date().toISOString();
  const statusName = getStatusName(status);
  const logEntry = JSON.stringify({
    time: timestamp,
    status,
    statusName,
    reason,
  }) + '\n';

  const statusLogFile = path.join(HISTORY_DIR, 'device-status.jsonl');
  fs.appendFile(statusLogFile, logEntry, (err) => {
    if (err) console.error('Error saving to device-status log:', err);
  });

  console.log(`[STATUS] ${timestamp} | Status ${status}: ${statusName}${reason ? ' (' + reason + ')' : ''}`);
}

/**
 * Get the current Modbus port in rotation
 */
function currentModbusPort(): number {
  return MODBUS_PORTS[modbusPortIndex];
}

// ============================================================================
// MODBUS CONNECTION MANAGEMENT
// ============================================================================

/**
 * Initiate Modbus TCP connection to inverter
 * Implements port rotation and exponential backoff
 */
function connectModbus() {
  if (!socket) return;
  if (isConnecting || socket.connecting || inverterData.connected) return;

  const now = Date.now();
  const timeSinceLastAttempt = now - lastReconnectAttemptTime;
  const reconnectDelay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY_MS
  );

  // Check if enough time has passed since last attempt
  if (timeSinceLastAttempt < reconnectDelay) {
    return;
  }

  const port = currentModbusPort();
  isConnecting = true;
  lastReconnectAttemptTime = now;
  const delayInfo = reconnectAttempts > 0 ? ` (attempt ${reconnectAttempts + 1}, backoff: ${reconnectDelay}ms)` : '';
  console.log(`🔄 Attempting Modbus connection to ${MODBUS_HOST}:${port}...${delayInfo}`);
  socket.connect({ host: MODBUS_HOST, port });
}

/**
 * Handle successful Modbus connection
 */
function handleModbusConnect() {
  if (!socket) return;
  isConnecting = false;
  inverterData.connected = true;
  modbusConsecutiveConnectionFailures = 0;
  consecutiveModbusTimeouts = 0;
  reconnectAttempts = 0;  // Reset exponential backoff
  lastSuccessfulReadTime = Date.now();
  hasAlertedPersistentDisconnection = false;
  console.log(`✅ [MODBUS] Connected to ${MODBUS_HOST}:${currentModbusPort()}`);

  if (isTelegramEnabled() && hasAlertedDisconnection) {
    alertInverterReconnected().catch(err => console.error('Failed to send reconnection alert:', err));
    hasAlertedDisconnection = false;
  }
}

/**
 * Handle Modbus connection error or loss
 */
function handleModbusError(err: any) {
  if (!socket) return;
  isConnecting = false;
  inverterData.connected = false;

  modbusConsecutiveConnectionFailures++;
  console.error(`[MODBUS ERROR] Connection failed (attempt #${modbusConsecutiveConnectionFailures}):`, err.message ?? err);

  // IMPORTANT: Only alert if NOT in Standby mode
  // If inverter is in Standby (states 0-3), timeouts are expected and normal
  // Alert only if: (1) Running/Operating state, or (2) Shutdown/Error state
  const isStandbyState = STANDBY_STATES.includes(lastInverterStatus);
  const shouldAlert = !isStandbyState && isTelegramEnabled() && !hasAlertedDisconnection;

  if (shouldAlert) {
    console.warn('⚠️  ALERT TRIGGERED: Disconnection during expected operating state');
    alertInverterDisconnected().catch(err => console.error('Failed to send disconnection alert:', err));
    hasAlertedDisconnection = true;
  } else if (isStandbyState) {
    console.log('⭕ Timeout ignored: Inverter in Standby mode (state ' + lastInverterStatus + ', expected)');
  }

  // Rotate ports on failure
  if (modbusConsecutiveConnectionFailures >= 3) {
    const nextIndex = (modbusPortIndex + 1) % MODBUS_PORTS.length;
    if (nextIndex !== modbusPortIndex) {
      console.log(`⚠️  Rotating Modbus port: ${currentModbusPort()} → ${MODBUS_PORTS[nextIndex]}`);
      modbusPortIndex = nextIndex;
    }
    modbusConsecutiveConnectionFailures = 0;
  }

  // Schedule reconnection with exponential backoff
  reconnectAttempts++;
  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1),
    MAX_RECONNECT_DELAY_MS
  );
  console.warn(`⏳ Scheduling reconnection in ${delay}ms (attempt ${reconnectAttempts})`);
  setTimeout(connectModbus, delay);
}

// Setup Modbus socket event handlers (if collector or monolith)
if (socket) {
  socket.on('connect', handleModbusConnect);
  socket.on('error', handleModbusError);
  socket.on('close', () => {
    if (socket) {
      isConnecting = false;
      inverterData.connected = false;
      lastDisconnectTime = Date.now();
      console.warn('⚠️ Modbus socket closed');
      // Attempt reconnection after socket close
      reconnectAttempts++;
      const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1),
        MAX_RECONNECT_DELAY_MS
      );
      console.warn(`⏳ Scheduling reconnection in ${delay}ms after socket close`);
      setTimeout(connectModbus, delay);
    }
  });
}

// ============================================================================
// PV STATUS MONITORING
// ============================================================================

function monitorPvStatus() {
  const now = Date.now();
  const events = pvAlertMonitor.evaluate({
    now,
    inverterStatus: lastInverterStatus,
    connectionStatus: inverterData.pvConnectionStatus,
    connectionStatusReadAt: pvConnectionStatusReadAt,
    stringLossAlarm: inverterData.pvStringLossAlarm,
    stringLossAlarmReadAt: pvStringLossAlarmReadAt,
    inputPowerW: inverterData.inputPower,
    activePowerW: inverterData.activePower,
    pv1VoltageV: inverterData.pv1Voltage,
    pv1CurrentA: inverterData.pv1Current,
    pv2VoltageV: inverterData.pv2Voltage,
    pv2CurrentA: inverterData.pv2Current,
  });

  for (const event of events) {
    console.warn('[PV_ALERT_DIAGNOSTIC]', {
      ...event,
      confirmedAtIso: new Date(event.confirmedAt).toISOString(),
      pendingSinceIso: new Date(event.pendingSince).toISOString(),
    });

    if (event.type === 'pv_disconnected') {
      console.error('🔴 PV CONNECTION LOSS CONFIRMED');
      alertPvDisconnected().catch(err => console.error('Failed to send PV disconnection alert:', err));
    } else if (event.type === 'pv_reconnected') {
      console.log('🟢 PV CONNECTION RECOVERY CONFIRMED');
      alertPvReconnected().catch(err => console.error('Failed to send PV reconnection alert:', err));
    } else {
      console.error('🔴 PV STRING LOSS CONFIRMED - Alarm ID: 2015');
      alertPvStringLoss().catch(err => console.error('Failed to send PV string loss alert:', err));
    }
  }
}

// ============================================================================
// MODBUS POLLING LOOP
// ============================================================================

/**
 * Main Modbus polling function
 * Reads all registers sequentially with delays between sections
 * Updates inverterData and persists telemetry to history
 */
async function pollInverter() {
  if (!inverterData.connected || !client) return;

  const sectionReadStatus = {
    pv: false,
    inputPower: false,
    activePower: false,
    tempStatus: false,
    yields: false,
    grid: false,
    gridMeter: false,
    battery: false,
  };

  // Read inverter identity (only once)
  if (inverterData.model === 'Unknown') {
    try {
      const modelRes = await client.readHoldingRegisters(30000, 15);
      inverterData.model = u16ToStr(modelRes.response.body.values);
      const snRes = await client.readHoldingRegisters(30015, 10);
      inverterData.serialNumber = u16ToStr(snRes.response.body.values);

      console.log(`📡 [MODBUS] Inverter Identity successfully read:`);
      console.log(`   Model:  ${inverterData.model}`);
      console.log(`   S/N:    ${inverterData.serialNumber}`);
    } catch (err) {
      console.warn('Modbus read failed (identity block):', err);
    }
  }

  // Read main operation block (PV, input, active power, temperature, yield)
  try {
    const block1Res = await client.readHoldingRegisters(32016, 100);
    const regs1 = block1Res.response.body.values;

    // PV Strings
    inverterData.pv1Voltage = regs1[32016 - 32016] / 10;
    inverterData.pv1Current = regs1[32017 - 32016] / 100;
    inverterData.pv2Voltage = regs1[32018 - 32016] / 10;
    inverterData.pv2Current = regs1[32019 - 32016] / 100;
    sectionReadStatus.pv = true;

    // Input Power (Solar)
    inverterData.inputPower = i32FromRegs([regs1[32064 - 32016], regs1[32065 - 32016]]);
    sectionReadStatus.inputPower = true;

    // Grid voltage and frequency
    inverterData.gridVoltage = regs1[32066 - 32016] / 10;
    inverterData.gridFrequency = regs1[32069 - 32016] / 100;

    // Active Power (what inverter is outputting)
    inverterData.activePower = i32FromRegs([regs1[32080 - 32016], regs1[32081 - 32016]]);
    sectionReadStatus.activePower = true;

    // Temperature and status
    inverterData.temperature = regs1[32087 - 32016] / 10;
    inverterData.status = regs1[32089 - 32016];

    // Track device status changes (register 32089 = device status)
    const currentStatus = inverterData.status;
    if (currentStatus !== lastInverterStatus) {
      const reason = lastInverterStatus === -1 ? 'initial read' : `changed from ${lastInverterStatus} to ${currentStatus}`;
      logStatusChange(currentStatus, reason);
      lastInverterStatus = currentStatus;
      lastStatusChangeTime = Date.now();
    }

    // Daily Yield
    inverterData.dailyYield = i32FromRegs([regs1[32114 - 32016], regs1[32115 - 32016]]) / 100;

    // Reset timeout counter on successful read
    consecutiveModbusTimeouts = 0;
    lastSuccessfulReadTime = Date.now();
  } catch (err) {
    console.warn('Modbus read failed (Operation Block):', err);
    consecutiveModbusTimeouts++;
    if (consecutiveModbusTimeouts >= 3 && socket) {
      console.error('🔴 Persistent Modbus timeouts detected (3+ consecutive timeouts). Forcing socket disconnect and reconnection...');
      socket.destroy();
      inverterData.connected = false;
      isConnecting = false;
      consecutiveModbusTimeouts = 0;
      lastDisconnectTime = Date.now();
      // Force immediate reconnection attempt
      reconnectAttempts = 0;  // Reset to allow immediate reconnect
      lastReconnectAttemptTime = 0;
      setTimeout(connectModbus, 500);
    }
  }

  await delay(60);

  // Read grid meter (net power from/to grid)
  try {
    const meterRes = await client.readHoldingRegisters(37113, 2);
    inverterData.gridPower = i32FromRegs(meterRes.response.body.values);
    sectionReadStatus.gridMeter = true;
  } catch (err) {
    console.warn('Modbus read failed (Grid Meter):', err);
  }

  await delay(60);

  // Read PV connection status (Reg 32002, Bit 1)
  try {
    const state2Res = await client.readHoldingRegisters(32002, 1);
    const state2Value = state2Res.response.body.values[0];
    inverterData.pvConnectionStatus = Boolean((state2Value >> 1) & 1);
    pvConnectionStatusReadAt = Date.now();
  } catch (err) {}

  await delay(60);

  // Read PV string loss alarm (Reg 32010, Bit 6)
  try {
    const alarm3Res = await client.readHoldingRegisters(32010, 1);
    const alarm3Value = alarm3Res.response.body.values[0];
    inverterData.pvStringLossAlarm = Boolean((alarm3Value >> 6) & 1);
    pvStringLossAlarmReadAt = Date.now();
  } catch (err) {}

  // Read battery power and SOC (if enabled)
  if (MODBUS_HAS_BATTERY) {
    await delay(60);
    try {
      const battPowerRes = await client.readHoldingRegisters(37001, 2);
      inverterData.batteryPower = i32FromRegs(battPowerRes.response.body.values);
      const battSocRes = await client.readHoldingRegisters(37004, 1);
      inverterData.batterySOC = battSocRes.response.body.values[0] / 10;
      sectionReadStatus.battery = true;
    } catch (err) {
      console.warn('Modbus read failed (Battery Block):', err);
      inverterData.batteryPower = 0;
      inverterData.batterySOC = 0;
    }
  } else {
    inverterData.batteryPower = 0;
    inverterData.batterySOC = 0;
    sectionReadStatus.battery = true;
  }

  // Calculate house load (Total consumption minus EV charger)
  const totalLoad = inverterData.activePower - inverterData.gridPower + inverterData.batteryPower;
  const evLoad = Math.max(0, chargerState.powerW ?? 0);
  inverterData.houseLoad = Math.max(0, totalLoad - evLoad);
  inverterData.consumption = inverterData.houseLoad + evLoad;

  // Update timestamp and emit data
  inverterData.lastUpdate = new Date().toISOString();

  // Emit combined data and save live state (modular mode)
  if (process.env.SERVICE_ROLE === 'collector') {
    saveLiveState();
  }

  // Monitor PV status for alarms
  monitorPvStatus();

  // Validate that we have enough data for history recording
  const hasValidHistorySample = (
    sectionReadStatus.pv
    && sectionReadStatus.inputPower
    && sectionReadStatus.activePower
    && sectionReadStatus.gridMeter
    && Number.isFinite(inverterData.activePower)
    && Number.isFinite(inverterData.inputPower)
    && Number.isFinite(inverterData.consumption)
    && Number.isFinite(inverterData.gridPower)
  );

  if (!hasValidHistorySample) {
    console.warn('Skipping history write due to incomplete/invalid Modbus sample');
    return;
  }

  // Log first successful telemetry sync
  if (!firstTelemetrySyncLogged) {
    firstTelemetrySyncLogged = true;
    console.log(`\n✅ [MODBUS] First successful telemetry sync completed:`);
    console.log(`   Solar Input Power:  ${inverterData.inputPower} W`);
    console.log(`   Inverter Active:    ${inverterData.activePower} W`);
    console.log(`   Grid Net Power:     ${inverterData.gridPower} W (Contador)`);
    console.log(`   House Load:         ${inverterData.houseLoad} W`);
    console.log(`   Device Status:      ${inverterData.status} (${getStatusName(inverterData.status)})`);
    console.log(`   PV Conn. State:     ${inverterData.pvConnectionStatus ? 'Connected (1)' : 'Disconnected (0)'}`);
    console.log(`   PV String Alarm:    ${inverterData.pvStringLossAlarm ? 'Active (1)' : 'Inactive (0)'}\n`);
  }

  // Write to daily history log (JSONL)
  const today = new Date().toISOString().split('T')[0];
  const logFile = path.join(HISTORY_DIR, `${today}.jsonl`);

  // Calculate PV string powers for accurate historical data
  const pv1Raw = inverterData.pv1Voltage * inverterData.pv1Current;
  const pv2Raw = inverterData.pv2Voltage * inverterData.pv2Current;
  const rawSum = Math.max(0, pv1Raw) + Math.max(0, pv2Raw);
  const totalInput = Math.max(0, inverterData.inputPower);

  let pv1Power = 0;
  let pv2Power = 0;
  if (rawSum > 0) {
    pv1Power = totalInput * (Math.max(0, pv1Raw) / rawSum);
    pv2Power = Math.max(0, totalInput - pv1Power);
  } else if (totalInput > 0) {
    // No voltage/current data, assume 50/50
    pv1Power = totalInput / 2;
    pv2Power = totalInput / 2;
  }

  const logEntry = JSON.stringify({
    time: inverterData.lastUpdate,
    power: inverterData.activePower,
    inputPower: inverterData.inputPower,
    consumption: inverterData.consumption,
    batterySOC: inverterData.batterySOC,
    gridPower: inverterData.gridPower,
    // Store calculated PV powers, not raw voltages/currents
    // This ensures consistent, accurate distribution in frontend
    pv1Power: Math.round(pv1Power),
    pv2Power: Math.round(pv2Power),
  }) + '\n';

  fs.appendFile(logFile, logEntry, (err) => {
    if (err) console.error('Error saving to history:', err);
  });

  // Write to InfluxDB (if configured and this is the collector role)
  writeToInflux(inverterData);
}

// ============================================================================
// SERVICE STARTUP
// ============================================================================

/**
 * Start the inverter collector service
 * Sets up Modbus polling, loads persisted state, starts health monitoring
 * Exported for use by main entry point
 */
export async function startInverterService() {
  console.log('🚀 Starting Inverter Service (Polling + History)...');

  // Print Modbus registry map for debugging
  console.log('\n📊 [MODBUS MONITORING PLAN]');
  console.log('----------------------------------------------------------------------');
  console.log(' ADDR.REG | LEN | PARAMETER DESCRIPTION                | CONVERSION');
  console.log('----------------------------------------------------------------------');
  MODBUS_REGISTRY_MAP.forEach(reg => {
    if (!MODBUS_HAS_BATTERY && (reg.address === 37001 || reg.address === 37004)) {
      return;
    }
    const addrStr = String(reg.address).padEnd(8);
    const lenStr = String(reg.length).padEnd(3);
    const nameStr = reg.name.padEnd(36);
    const typeStr = reg.type;
    console.log(` ${addrStr} | ${lenStr} | ${nameStr} | ${typeStr}`);
  });
  console.log('----------------------------------------------------------------------\n');

  // In modular mode, start polling live-state files from other services
  if (process.env.START_MONOLITH !== 'true' && !process.argv[1].endsWith('server.ts') && !process.argv[1].endsWith('server.js')) {
    console.log('[INIT] Modular mode detected, starting live-state polling for inverter service');
    setInterval(loadLiveState, 1000);
  }

  // Restore charger state from disk and start polling
  restorePersistedChargerState();
  connectModbus();
  setInterval(pollInverter, MODBUS_POLLING_INTERVAL);

  // Watchdog: Monitor connection health and force reconnection if offline too long
  const OFFLINE_THRESHOLD_MS = 60000;  // 60 seconds offline triggers watchdog
  const PERSISTENT_FAILURE_THRESHOLD_MS = 300000;  // 5 minutes of failures = critical alert
  setInterval(() => {
    if (!inverterData.connected) {
      const timeSinceLastDisconnect = Date.now() - lastDisconnectTime;
      const timeSinceLastSuccessfulRead = Date.now() - lastSuccessfulReadTime;

      // Alert if persistently disconnected for too long
      if (timeSinceLastSuccessfulRead > PERSISTENT_FAILURE_THRESHOLD_MS && !hasAlertedPersistentDisconnection) {
        console.error('🚨 CRITICAL: Modbus has been offline for 5+ minutes. Check inverter/network/firewall.');
        hasAlertedPersistentDisconnection = true;
      }

      // Force reconnection if offline for more than threshold
      if (timeSinceLastDisconnect > OFFLINE_THRESHOLD_MS) {
        console.warn(`⚠️  Watchdog: Offline for ${Math.round(timeSinceLastDisconnect / 1000)}s. Forcing reconnection attempt...`);
        reconnectAttempts = 0;  // Reset backoff
        lastReconnectAttemptTime = 0;
        connectModbus();
      }
    }
  }, 30000);  // Check every 30 seconds

  // Send health heartbeat
  setInterval(() => {
    const role = process.env.SERVICE_ROLE || 'monolith';

    const status = inverterData.connected ? 'OK' : 'Error (Disconnected)';
    const details = inverterData.connected ? `Polling at ${currentModbusPort()}` : `Offline (${reconnectAttempts} reconnect attempts)`;

    inverterData.services[role] = {
      lastHeartbeat: new Date().toISOString(),
      status,
      details
    };
    saveLiveState();
  }, 10000);
}

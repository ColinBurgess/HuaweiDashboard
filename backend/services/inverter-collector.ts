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

// PV Status Monitoring
let pvConnectionStatusPrevious = true;
let pvStringLossAlarmPrevious = false;
let hasAlertedPvDisconnection = false;
let hasAlertedPvStringLoss = false;
let pvStatusRegistersAvailable = false;

// Telemetry
let firstTelemetrySyncLogged = false;
let consecutiveModbusTimeouts = 0;

// ============================================================================
// UTILITIES
// ============================================================================

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

  const port = currentModbusPort();
  isConnecting = true;
  console.log(`Connecting to Modbus ${MODBUS_HOST}:${port}...`);
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

  if (isTelegramEnabled() && !hasAlertedDisconnection) {
    alertInverterDisconnected().catch(err => console.error('Failed to send disconnection alert:', err));
    hasAlertedDisconnection = true;
  }

  // Rotate ports on failure
  if (modbusConsecutiveConnectionFailures >= 3) {
    const nextIndex = (modbusPortIndex + 1) % MODBUS_PORTS.length;
    if (nextIndex !== modbusPortIndex) {
      console.log(`Rotating Modbus port: ${currentModbusPort()} → ${MODBUS_PORTS[nextIndex]}`);
      modbusPortIndex = nextIndex;
    }
    modbusConsecutiveConnectionFailures = 0;
  }

  // Schedule reconnection
  setTimeout(connectModbus, 10_000);
}

// Setup Modbus socket event handlers (if collector or monolith)
if (socket) {
  socket.on('connect', handleModbusConnect);
  socket.on('error', handleModbusError);
  socket.on('close', () => {
    if (socket) {
      isConnecting = false;
      inverterData.connected = false;
      console.warn('⚠️ Modbus socket closed');
    }
  });
}

// ============================================================================
// PV STATUS MONITORING
// ============================================================================

/**
 * Monitor PV connection status and string loss alarms
 * Sends Telegram alerts on state transitions
 */
function monitorPvStatus() {
  if (!pvStatusRegistersAvailable) return;

  if (inverterData.pvConnectionStatus !== pvConnectionStatusPrevious) {
    pvConnectionStatusPrevious = inverterData.pvConnectionStatus;

    if (!inverterData.pvConnectionStatus && !hasAlertedPvDisconnection) {
      console.error('🔴 PV CONNECTION LOST - Automatico has tripped!');
      alertPvDisconnected().catch(err => console.error('Failed to send PV disconnection alert:', err));
      hasAlertedPvDisconnection = true;
    } else if (inverterData.pvConnectionStatus && hasAlertedPvDisconnection) {
      console.log('🟢 PV CONNECTION RESTORED');
      alertPvReconnected().catch(err => console.error('Failed to send PV reconnection alert:', err));
      hasAlertedPvDisconnection = false;
    }
  }

  if (inverterData.pvStringLossAlarm !== pvStringLossAlarmPrevious) {
    pvStringLossAlarmPrevious = inverterData.pvStringLossAlarm;

    if (inverterData.pvStringLossAlarm && !hasAlertedPvStringLoss) {
      console.error('🔴 PV STRING LOSS DETECTED - Alarm ID: 2015');
      alertPvStringLoss().catch(err => console.error('Failed to send PV string loss alert:', err));
      hasAlertedPvStringLoss = true;
    } else if (!inverterData.pvStringLossAlarm && hasAlertedPvStringLoss) {
      console.log('🟢 PV STRING LOSS CLEARED');
      hasAlertedPvStringLoss = false;
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

    // Daily Yield
    inverterData.dailyYield = i32FromRegs([regs1[32114 - 32016], regs1[32115 - 32016]]) / 100;
  } catch (err) {
    console.warn('Modbus read failed (Operation Block):', err);
    consecutiveModbusTimeouts++;
    if (consecutiveModbusTimeouts >= 3 && socket) {
      console.error('🔴 Persistent Modbus timeouts detected. Forcing socket disconnect...');
      socket.destroy();
      inverterData.connected = false;
      consecutiveModbusTimeouts = 0;
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
    pvStatusRegistersAvailable = true;
  } catch (err) {}

  await delay(60);

  // Read PV string loss alarm (Reg 32010, Bit 6)
  try {
    const alarm3Res = await client.readHoldingRegisters(32010, 1);
    const alarm3Value = alarm3Res.response.body.values[0];
    inverterData.pvStringLossAlarm = Boolean((alarm3Value >> 6) & 1);
    pvStatusRegistersAvailable = true;
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
  inverterData.consumption = inverterData.houseLoad;

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
    console.log(`   PV Conn. State:     ${inverterData.pvConnectionStatus ? 'Connected (1)' : 'Disconnected (0)'}`);
    console.log(`   PV String Alarm:    ${inverterData.pvStringLossAlarm ? 'Active (1)' : 'Inactive (0)'}\n`);
  }

  // Write to daily history log (JSONL)
  const today = new Date().toISOString().split('T')[0];
  const logFile = path.join(HISTORY_DIR, `${today}.jsonl`);
  const logEntry = JSON.stringify({
    time: inverterData.lastUpdate,
    power: inverterData.activePower,
    inputPower: inverterData.inputPower,
    consumption: inverterData.consumption,
    batterySOC: inverterData.batterySOC,
    gridPower: inverterData.gridPower,
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
  setInterval(pollInverter, 1000);

  // Send health heartbeat
  setInterval(() => {
    const role = process.env.SERVICE_ROLE || 'monolith';

    const status = inverterData.connected ? 'OK' : 'Error (Disconnected)';
    const details = inverterData.connected ? `Polling at ${currentModbusPort()}` : 'Modbus connection failed';

    inverterData.services[role] = {
      lastHeartbeat: new Date().toISOString(),
      status,
      details
    };
    saveLiveState();
  }, 10000);
}

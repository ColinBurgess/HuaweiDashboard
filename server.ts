import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import net from 'net';
import fs from 'fs';

// @ts-ignore
import { client as ModbusClient } from 'jsmodbus';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = Number(process.env.PORT ?? process.env.APP_PORT ?? 3001);
const MODBUS_HOST = process.env.MODBUS_HOST ?? '192.168.1.140';
const MODBUS_PORTS = (process.env.MODBUS_PORTS ?? process.env.MODBUS_PORT ?? '502,6607')
  .split(',')
  .map((port) => Number(port.trim()))
  .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
const SLAVE_ID = 1;
const HISTORY_DIR = path.join(process.cwd(), 'history');
const LOGS_DIR = path.join(process.cwd(), 'logs');
const CHARGER_STATE_FILE = path.join(process.cwd(), 'charger-state.json');
const CHARGER_STATE_TMP_FILE = `${CHARGER_STATE_FILE}.tmp`;
const SERVER_START_TIME = new Date();

const OCPP_HOST = process.env.OCPP_HOST ?? '0.0.0.0';
const OCPP_PORT = Number(process.env.OCPP_PORT ?? 9100);
const OCPP_PATH_PREFIX = process.env.OCPP_PATH_PREFIX ?? '/ocpp';
const OCPP_HEARTBEAT_INTERVAL = Number(process.env.OCPP_HEARTBEAT_INTERVAL ?? 30);
const OCPP_CONFIG_DEBOUNCE_MS = 5 * 60 * 1000;
const MODBUS_RECONNECT_DELAY_MS = 10_000;
const MODBUS_PORT_ROTATE_THRESHOLD = 3;
const GREEN_CONTROL_LOOP_MS = 30_000;
const GREEN_GRID_VOLTAGE = Number(process.env.GREEN_GRID_VOLTAGE ?? 230);
const GREEN_MIN_CHARGING_AMPS = 6;
const GREEN_MAX_CHARGING_AMPS = Number(process.env.GREEN_MAX_CHARGING_AMPS ?? 32);
const GREEN_HYSTERESIS_AMPS = 1;
const HYBRID_MIN_CHARGING_AMPS = Math.max(
  GREEN_MIN_CHARGING_AMPS,
  Math.min(GREEN_MAX_CHARGING_AMPS, Number(process.env.HYBRID_MIN_CHARGING_AMPS ?? GREEN_MIN_CHARGING_AMPS)),
);

type ChargingMode = 'FAST' | 'GREEN' | 'HYBRID';

if (MODBUS_PORTS.length === 0) {
  throw new Error('No valid Modbus ports configured. Set MODBUS_PORT or MODBUS_PORTS.');
}

if (!Number.isInteger(OCPP_PORT) || OCPP_PORT < 1 || OCPP_PORT > 65535) {
  throw new Error('OCPP_PORT must be a valid TCP port (1-65535).');
}

fs.mkdirSync(HISTORY_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

type RuntimeLogLevel = 'info' | 'warn' | 'error';

type RuntimeLogEntry = {
  time: string;
  level: RuntimeLogLevel;
  source: string;
  message: string;
};

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const liveLogs: RuntimeLogEntry[] = [];
const MAX_LIVE_LOGS = 250;

function formatLogSessionTimestamp(date: Date): string {
  return date.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

const RUNTIME_LOG_FILE = path.join(LOGS_DIR, `${formatLogSessionTimestamp(SERVER_START_TIME)}.jsonl`);

function stringifyLogArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack ?? arg.message;
  }

  if (typeof arg === 'string') {
    return arg;
  }

  if (typeof arg === 'number' || typeof arg === 'boolean' || arg == null) {
    return String(arg);
  }

  try {
    return JSON.stringify(arg, null, 2);
  } catch {
    return String(arg);
  }
}

function storeLiveLog(entry: RuntimeLogEntry) {
  liveLogs.push(entry);
  if (liveLogs.length > MAX_LIVE_LOGS) {
    liveLogs.splice(0, liveLogs.length - MAX_LIVE_LOGS);
  }

  io.emit('server-log', entry);
}

function appendRuntimeLog(entry: RuntimeLogEntry, sync = false) {
  const serializedEntry = `${JSON.stringify(entry)}\n`;

  if (sync) {
    fs.appendFileSync(RUNTIME_LOG_FILE, serializedEntry);
    return;
  }

  fs.appendFile(RUNTIME_LOG_FILE, serializedEntry, (err) => {
    if (err) {
      originalConsole.error('Error saving runtime log:', err);
    }
  });
}

function persistRuntimeLog(level: RuntimeLogLevel, source: string, args: unknown[]) {
  if (args.length === 0) {
    return;
  }

  const message = args.map(stringifyLogArg).join(' ');
  if (message.trim().length === 0) {
    return;
  }

  const entry: RuntimeLogEntry = {
    time: new Date().toISOString(),
    level,
    source,
    message,
  };

  storeLiveLog(entry);
  appendRuntimeLog(entry);
}

function recordLifecycleLog(message: string, level: RuntimeLogLevel = 'info', sync = false) {
  const entry: RuntimeLogEntry = {
    time: new Date().toISOString(),
    level,
    source: 'lifecycle',
    message,
  };

  storeLiveLog(entry);
  appendRuntimeLog(entry, sync);
}

console.log = (...args: unknown[]) => {
  originalConsole.log(...args);
  persistRuntimeLog('info', 'server', args);
};

console.warn = (...args: unknown[]) => {
  originalConsole.warn(...args);
  persistRuntimeLog('warn', 'server', args);
};

console.error = (...args: unknown[]) => {
  originalConsole.error(...args);
  persistRuntimeLog('error', 'server', args);
};

let isShuttingDown = false;

function handleShutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  recordLifecycleLog(`Server stopping (${signal})`, 'warn', true);
  originalConsole.warn(`Server stopping (${signal})`);
  process.exit(0);
}

process.once('SIGINT', () => handleShutdown('SIGINT'));
process.once('SIGTERM', () => handleShutdown('SIGTERM'));

recordLifecycleLog(`Server started. Session log: ${path.basename(RUNTIME_LOG_FILE)}`, 'info', true);


// Helper functions for data conversion
function u16ToStr(registers: any): string {
  const regs = Array.isArray(registers) ? registers : Array.from(registers as Uint8Array);
  const buffer = Buffer.alloc(regs.length * 2);
  regs.forEach((reg, i) => buffer.writeUInt16BE(reg as number, i * 2));
  return buffer.toString('ascii').replace(/\0/g, '').trim();
}

function i32FromRegs(registers: any): number {
  const buffer = Buffer.alloc(4);
  const regs = Array.isArray(registers) ? registers : Array.from(registers as Uint8Array);
  buffer.writeUInt16BE(regs[0] as number, 0);
  buffer.writeUInt16BE(regs[1] as number, 2);
  return buffer.readInt32BE(0);
}

function u32FromRegs(registers: any): number {
  const buffer = Buffer.alloc(4);
  const regs = Array.isArray(registers) ? registers : Array.from(registers as Uint8Array);
  buffer.writeUInt16BE(regs[0] as number, 0);
  buffer.writeUInt16BE(regs[1] as number, 2);
  return buffer.readUInt32BE(0);
}

type ChargerState = {
  connected: boolean;
  chargePointId: string;
  status: string;
  powerW: number;
  transactionId?: number;
  chargingMode: ChargingMode;
  startRequested: boolean;
  appliedCurrentLimitA?: number;
  lastRequestedCurrentLimitA?: number;
  lastUpdate: string;
};

type PersistedChargerState = {
  chargingMode: ChargingMode;
  startRequested: boolean;
  appliedCurrentLimitA: number | null;
  lastRequestedCurrentLimitA: number | null;
  transactionId: number | null;
  savedAt: string;
};

type OcppCall = [2, string, string, Record<string, any>];
type OcppCallResult = [3, string, Record<string, unknown>];
type OcppCallError = [4, string, string, string, Record<string, unknown>];

const chargerState: ChargerState = {
  connected: false,
  chargePointId: 'Unknown',
  status: 'Disconnected',
  powerW: 0,
  transactionId: undefined,
  chargingMode: 'FAST',
  startRequested: false,
  appliedCurrentLimitA: undefined,
  lastRequestedCurrentLimitA: undefined,
  lastUpdate: new Date().toISOString(),
};

let lastPersistedChargerStateSignature = '';

function buildChargerStateSignature(): string {
  return JSON.stringify({
    chargingMode: chargerState.chargingMode,
    startRequested: chargerState.startRequested,
    appliedCurrentLimitA: chargerState.appliedCurrentLimitA ?? null,
    lastRequestedCurrentLimitA: chargerState.lastRequestedCurrentLimitA ?? null,
    transactionId: chargerState.transactionId ?? null,
  });
}

function persistChargerStateIfChanged(force = false): void {
  try {
    const signature = buildChargerStateSignature();
    if (!force && signature === lastPersistedChargerStateSignature) {
      return;
    }

    const payload: PersistedChargerState = {
      chargingMode: chargerState.chargingMode,
      startRequested: chargerState.startRequested,
      appliedCurrentLimitA: chargerState.appliedCurrentLimitA ?? null,
      lastRequestedCurrentLimitA: chargerState.lastRequestedCurrentLimitA ?? null,
      transactionId: chargerState.transactionId ?? null,
      savedAt: new Date().toISOString(),
    };

    fs.writeFileSync(CHARGER_STATE_TMP_FILE, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(CHARGER_STATE_TMP_FILE, CHARGER_STATE_FILE);
    lastPersistedChargerStateSignature = signature;
  } catch (error) {
    console.error('Failed to persist charger state:', error);
  }
}

function restorePersistedChargerState(): void {
  if (!fs.existsSync(CHARGER_STATE_FILE)) {
    console.log('[STATE] No persisted charger state file found, starting with defaults');
    return;
  }

  try {
    const raw = fs.readFileSync(CHARGER_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedChargerState>;
    const mode = String(parsed.chargingMode ?? '').toUpperCase();

    if (mode === 'FAST' || mode === 'GREEN' || mode === 'HYBRID') {
      chargerState.chargingMode = mode;
    }

    chargerState.startRequested = Boolean(parsed.startRequested);
    chargerState.appliedCurrentLimitA = Number.isFinite(parsed.appliedCurrentLimitA as number)
      ? Number(parsed.appliedCurrentLimitA)
      : undefined;
    chargerState.lastRequestedCurrentLimitA = Number.isFinite(parsed.lastRequestedCurrentLimitA as number)
      ? Number(parsed.lastRequestedCurrentLimitA)
      : undefined;
    chargerState.transactionId = Number.isFinite(parsed.transactionId as number)
      ? Number(parsed.transactionId)
      : undefined;
    chargerState.lastUpdate = new Date().toISOString();
    lastPersistedChargerStateSignature = buildChargerStateSignature();

    console.log(
      `[STATE] Restored charger state mode=${chargerState.chargingMode} startRequested=${chargerState.startRequested} txId=${chargerState.transactionId ?? 'none'} appliedLimitA=${chargerState.appliedCurrentLimitA ?? 'none'} lastRequestedLimitA=${chargerState.lastRequestedCurrentLimitA ?? 'none'} savedAt=${parsed.savedAt ?? 'unknown'}`,
    );
  } catch (error) {
    console.error('Failed to restore charger state:', error);
  }
}

// Active WebSocket connection to the charger (only one at a time)
let chargerWs: WebSocket | null = null;

let inverterData = {
  model: 'Unknown',
  serialNumber: 'Unknown',
  activePower: 0,
  pv1Voltage: 0,
  pv1Current: 0,
  pv2Voltage: 0,
  pv2Current: 0,
  inputPower: 0,
  dailyYield: 0,
  totalYield: 0,
  temperature: 0,
  status: 0,
  gridVoltage: 0,
  gridFrequency: 0,
  gridPower: 0,
  batteryPower: 0,
  batterySOC: 0,
  houseLoad: 0,
  carChargePower: 0,
  chargerConnected: false,
  chargerStatus: 'Disconnected',
  chargePointId: 'Unknown',
  chargerLastUpdate: new Date().toISOString(),
  chargingMode: 'FAST' as ChargingMode,
  chargerStartRequested: false,
  chargerCurrentLimitA: null as number | null,
  consumption: 0,
  lastUpdate: new Date().toISOString(),
  connected: false
};

const socket = new net.Socket();
const client = new ModbusClient.TCP(socket, SLAVE_ID);
let modbusPortIndex = 0;
let modbusConsecutiveConnectionFailures = 0;

function currentModbusPort(): number {
  return MODBUS_PORTS[modbusPortIndex];
}

function connectModbus() {
  const port = currentModbusPort();
  console.log(`Connecting to Modbus ${MODBUS_HOST}:${port}...`);
  socket.connect({ host: MODBUS_HOST, port });
}

function syncChargerIntoInverterData() {
  inverterData.carChargePower = Math.max(0, chargerState.powerW);
  inverterData.chargerConnected = chargerState.connected;
  inverterData.chargerStatus = chargerState.status;
  inverterData.chargePointId = chargerState.chargePointId;
  inverterData.chargerLastUpdate = chargerState.lastUpdate;
  inverterData.chargingMode = chargerState.chargingMode;
  inverterData.chargerStartRequested = chargerState.startRequested;
  inverterData.chargerCurrentLimitA = chargerState.appliedCurrentLimitA ?? null;
}

function emitCombinedData() {
  syncChargerIntoInverterData();
  persistChargerStateIfChanged();
  io.emit('inverter-data', inverterData);
}

function extractChargePointId(pathValue: string): string {
  const cleanPath = pathValue.split('?')[0];
  const segments = cleanPath.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? 'Unknown';
}

let callIdCounter = 0;
function generateCallId(): string {
  return String(++callIdCounter);
}

const lastOcppConfigAtByChargePoint = new Map<string, number>();

let transactionIdCounter = 0;
function generateTransactionId(): number {
  return ++transactionIdCounter;
}

function buildCall(action: string, payload: Record<string, any>): OcppCall {
  return [2, generateCallId(), action, payload];
}

function sendOcppCall(ws: WebSocket, chargePointId: string, action: string, payload: Record<string, any>): void {
  if (ws.readyState !== ws.OPEN) {
    return;
  }

  ws.send(JSON.stringify(buildCall(action, payload)));
  console.log(`[${chargePointId}] → ${action}`);
}

function configureChargerTelemetryIfNeeded(ws: WebSocket, chargePointId: string): void {
  const now = Date.now();
  const lastConfiguredAt = lastOcppConfigAtByChargePoint.get(chargePointId) ?? 0;

  if (now - lastConfiguredAt < OCPP_CONFIG_DEBOUNCE_MS) {
    console.log(`[${chargePointId}] Skipping telemetry reconfiguration (debounced < 5min)`);
    return;
  }

  lastOcppConfigAtByChargePoint.set(chargePointId, now);

  sendOcppCall(ws, chargePointId, 'GetConfiguration', {});
  sendOcppCall(ws, chargePointId, 'ChangeConfiguration', {
    key: 'MeterValueSampleInterval',
    value: '10',
  });
  sendOcppCall(ws, chargePointId, 'ChangeConfiguration', {
    key: 'MeterValuesSampledData',
    value: 'Power.Active.Import,Energy.Active.Import.Register',
  });
  sendOcppCall(ws, chargePointId, 'TriggerMessage', {
    requestedMessage: 'MeterValues',
    connectorId: 1,
  });
}

function canSendToCharger(): boolean {
  return Boolean(chargerWs && chargerWs.readyState === chargerWs.OPEN);
}

function sendRemoteStartTransaction(): boolean {
  if (!canSendToCharger() || !chargerWs) {
    return false;
  }

  const cmd = buildCall('RemoteStartTransaction', { connectorId: 1, idTag: 'Dashboard' });
  chargerWs.send(JSON.stringify(cmd));
  chargerState.lastUpdate = new Date().toISOString();
  emitCombinedData();
  console.log('[API] → RemoteStartTransaction');
  return true;
}

function sendRemoteStopTransaction(): boolean {
  if (!canSendToCharger() || !chargerWs) {
    return false;
  }

  const txId = chargerState.transactionId ?? 0;
  const cmd = buildCall('RemoteStopTransaction', { transactionId: txId });
  chargerWs.send(JSON.stringify(cmd));
  chargerState.lastUpdate = new Date().toISOString();
  emitCombinedData();
  console.log(`[API] → RemoteStopTransaction txId=${txId}`);
  return true;
}

function sendChargingLimit(amps: number): boolean {
  if (!canSendToCharger() || !chargerWs) {
    return false;
  }

  const sanitizedAmps = Math.max(
    GREEN_MIN_CHARGING_AMPS,
    Math.min(GREEN_MAX_CHARGING_AMPS, Math.round(amps)),
  );

  const cmd = buildCall('SetChargingProfile', {
    connectorId: 1,
    csChargingProfiles: {
      chargingProfileId: 100,
      stackLevel: 1,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [
          {
            startPeriod: 0,
            limit: sanitizedAmps,
            numberPhases: 1,
          },
        ],
      },
    },
  });

  chargerWs.send(JSON.stringify(cmd));
  chargerState.lastRequestedCurrentLimitA = sanitizedAmps;
  chargerState.appliedCurrentLimitA = sanitizedAmps;
  chargerState.lastUpdate = new Date().toISOString();
  emitCombinedData();
  console.log(`[SMART] → SetChargingProfile TxDefaultProfile limit=${sanitizedAmps}A`);
  return true;
}

function clearChargingLimit(): boolean {
  if (!canSendToCharger() || !chargerWs) {
    return false;
  }

  const cmd = buildCall('ClearChargingProfile', {
    connectorId: 1,
    chargingProfilePurpose: 'TxDefaultProfile',
    stackLevel: 1,
  });

  chargerWs.send(JSON.stringify(cmd));
  chargerState.lastRequestedCurrentLimitA = undefined;
  chargerState.appliedCurrentLimitA = undefined;
  chargerState.lastUpdate = new Date().toISOString();
  emitCombinedData();
  console.log('[SMART] → ClearChargingProfile TxDefaultProfile');
  return true;
}

function applyGreenChargingPolicy(): void {
  if (chargerState.chargingMode !== 'GREEN') {
    return;
  }

  if (!chargerState.startRequested) {
    return;
  }

  if (!canSendToCharger()) {
    return;
  }

  const gridExportW = Math.max(0, inverterData.gridPower);
  const chargerPowerW = Math.max(0, chargerState.powerW);
  const surplusW = gridExportW + chargerPowerW;

  const rawTargetAmps = surplusW / GREEN_GRID_VOLTAGE;
  const hasEnoughSurplus = rawTargetAmps >= GREEN_MIN_CHARGING_AMPS;

  if (!hasEnoughSurplus) {
    chargerState.appliedCurrentLimitA = undefined;
    chargerState.lastRequestedCurrentLimitA = undefined;
    if (chargerState.status === 'Charging') {
      sendRemoteStopTransaction();
    } else {
      chargerState.lastUpdate = new Date().toISOString();
      emitCombinedData();
      console.log(`[SMART] Waiting for solar surplus >= ${GREEN_MIN_CHARGING_AMPS}A (current=${rawTargetAmps.toFixed(2)}A)`);
    }
    return;
  }

  const boundedTargetAmps = Math.max(
    GREEN_MIN_CHARGING_AMPS,
    Math.min(GREEN_MAX_CHARGING_AMPS, Math.floor(rawTargetAmps)),
  );

  const lastSent = chargerState.lastRequestedCurrentLimitA;
  const shouldUpdateLimit = lastSent === undefined || Math.abs(boundedTargetAmps - lastSent) > GREEN_HYSTERESIS_AMPS;

  if (shouldUpdateLimit) {
    sendChargingLimit(boundedTargetAmps);
  }

  if (chargerState.status !== 'Charging') {
    sendRemoteStartTransaction();
  }
}

function applyHybridChargingPolicy(): void {
  if (chargerState.chargingMode !== 'HYBRID') {
    return;
  }

  if (!chargerState.startRequested) {
    return;
  }

  if (!canSendToCharger()) {
    return;
  }

  const gridExportW = Math.max(0, inverterData.gridPower);
  const chargerPowerW = Math.max(0, chargerState.powerW);
  const surplusW = gridExportW + chargerPowerW;
  const rawTargetAmps = surplusW / GREEN_GRID_VOLTAGE;

  const boundedTargetAmps = Math.max(
    HYBRID_MIN_CHARGING_AMPS,
    Math.min(GREEN_MAX_CHARGING_AMPS, Math.floor(rawTargetAmps)),
  );

  const lastSent = chargerState.lastRequestedCurrentLimitA;
  const shouldUpdateLimit = lastSent === undefined || Math.abs(boundedTargetAmps - lastSent) > GREEN_HYSTERESIS_AMPS;

  if (shouldUpdateLimit) {
    sendChargingLimit(boundedTargetAmps);
  }

  if (chargerState.status !== 'Charging') {
    sendRemoteStartTransaction();
  }
}

function applySmartChargingPolicy(): void {
  if (chargerState.chargingMode === 'GREEN') {
    applyGreenChargingPolicy();
    return;
  }

  if (chargerState.chargingMode === 'HYBRID') {
    applyHybridChargingPolicy();
  }
}

function reconcileChargerControlState(trigger: string): void {
  console.log(
    `[RECON] trigger=${trigger} mode=${chargerState.chargingMode} startRequested=${chargerState.startRequested} connected=${chargerState.connected} status=${chargerState.status} appliedLimitA=${chargerState.appliedCurrentLimitA ?? 'none'} txId=${chargerState.transactionId ?? 'none'}`,
  );

  if (!chargerState.startRequested) {
    console.log('[RECON] No start requested, reconciliation completed without action');
    return;
  }

  if (chargerState.chargingMode === 'FAST') {
    console.log('[RECON] FAST mode armed, no smart-limit reconciliation required');
    return;
  }

  if (!canSendToCharger()) {
    console.log('[RECON] Smart mode armed but charger socket is not ready yet');
    return;
  }

  console.log(`[RECON] Applying smart policy for mode=${chargerState.chargingMode}`);
  applySmartChargingPolicy();
}

function buildCallResult(uniqueId: string, payload: Record<string, unknown>): OcppCallResult {
  return [3, uniqueId, payload];
}

function buildCallError(
  uniqueId: string,
  code: string,
  description: string,
  details: Record<string, unknown> = {},
): OcppCallError {
  return [4, uniqueId, code, description, details];
}

function parseMeterPower(payload: Record<string, any>): number | undefined {
  const meterValues = payload.meterValue;
  if (!Array.isArray(meterValues)) return undefined;

  for (const meterValue of meterValues) {
    const sampledValues = meterValue?.sampledValue;
    if (!Array.isArray(sampledValues)) continue;

    for (const sampled of sampledValues) {
      const valueRaw = Number(sampled?.value);
      if (!Number.isFinite(valueRaw)) continue;

      const measurand = sampled?.measurand;
      const unit = sampled?.unit;
      const context = sampled?.context;

      if (measurand === 'Power.Active.Import' || measurand === 'Power.Active.Export') {
        return unit === 'kW' ? Math.round(valueRaw * 1000) : Math.round(valueRaw);
      }

      if (!measurand && (!unit || unit === 'W' || unit === 'kW') && (!context || context === 'Sample.Periodic')) {
        return unit === 'kW' ? Math.round(valueRaw * 1000) : Math.round(valueRaw);
      }
    }
  }

  return undefined;
}

function handleOcppCall(
  ws: WebSocket,
  chargePointId: string,
  frame: OcppCall,
) {
  const [, uniqueId, action, payload] = frame;

  console.log(`[${chargePointId}] OCPP Call: ${action}`);

  switch (action) {
    case 'BootNotification':
      chargerState.connected = true;
      chargerState.chargePointId = chargePointId;
      chargerState.status = 'Available';
      chargerState.lastUpdate = new Date().toISOString();
      ws.send(JSON.stringify(buildCallResult(uniqueId, {
        currentTime: new Date().toISOString(),
        interval: OCPP_HEARTBEAT_INTERVAL,
        status: 'Accepted',
      })));
      emitCombinedData();
      console.log(`[${chargePointId}] BootNotification accepted`, payload);
      configureChargerTelemetryIfNeeded(ws, chargePointId);
      reconcileChargerControlState('BootNotification');
      return;

    case 'Heartbeat':
      chargerState.lastUpdate = new Date().toISOString();
      ws.send(JSON.stringify(buildCallResult(uniqueId, { currentTime: new Date().toISOString() })));
      emitCombinedData();
      return;

    case 'Authorize':
      ws.send(JSON.stringify(buildCallResult(uniqueId, { idTagInfo: { status: 'Accepted' } })));
      return;

    case 'StatusNotification':
      chargerState.connected = true;
      chargerState.chargePointId = chargePointId;
      // connectorId 0 is the charger unit itself (always "Available"), ignore it.
      // Only update status from connectorId >= 1 (actual charging connectors).
      if ((payload.connectorId ?? 1) >= 1) {
        chargerState.status = String(payload.status ?? chargerState.status ?? 'Unknown');
        // Reset power when not actively charging
        if (chargerState.status !== 'Charging') {
          chargerState.powerW = 0;
          chargerState.transactionId = undefined;
        }
      }
      chargerState.lastUpdate = new Date().toISOString();
      ws.send(JSON.stringify(buildCallResult(uniqueId, {})));
      emitCombinedData();
      console.log(`[${chargePointId}] StatusNotification`, payload);
      return;

    case 'MeterValues': {
      const power = parseMeterPower(payload);
      if (Number.isFinite(power)) {
        chargerState.powerW = Math.max(0, Number(power));
      }
      // Capture transactionId reported by charger (useful when charging started before we connected)
      if (payload.transactionId !== undefined && payload.transactionId !== null) {
        chargerState.transactionId = Number(payload.transactionId);
      }
      chargerState.connected = true;
      chargerState.chargePointId = chargePointId;
      chargerState.lastUpdate = new Date().toISOString();
      ws.send(JSON.stringify(buildCallResult(uniqueId, {})));
      emitCombinedData();
      console.log(`[${chargePointId}] MeterValues (power=${chargerState.powerW}W, txId=${chargerState.transactionId})`);
      return;
    }

    case 'StartTransaction':
      chargerState.connected = true;
      chargerState.chargePointId = chargePointId;
      chargerState.status = 'Charging';
      chargerState.startRequested = true;
      chargerState.transactionId = generateTransactionId();
      chargerState.lastUpdate = new Date().toISOString();
      ws.send(JSON.stringify(buildCallResult(uniqueId, {
        transactionId: chargerState.transactionId,
        idTagInfo: { status: 'Accepted' },
      })));
      emitCombinedData();
      console.log(`[${chargePointId}] StartTransaction accepted, assigned txId=${chargerState.transactionId}`, payload);
      return;

    case 'StopTransaction':
      chargerState.status = 'Available';
      chargerState.startRequested = false;
      chargerState.transactionId = undefined;
      chargerState.powerW = 0;
      chargerState.appliedCurrentLimitA = undefined;
      chargerState.lastRequestedCurrentLimitA = undefined;
      chargerState.lastUpdate = new Date().toISOString();
      ws.send(JSON.stringify(buildCallResult(uniqueId, { idTagInfo: { status: 'Accepted' } })));
      emitCombinedData();
      console.log(`[${chargePointId}] StopTransaction`, payload);
      return;

    case 'SecurityEventNotification':
    case 'DiagnosticsStatusNotification':
    case 'FirmwareStatusNotification':
      chargerState.lastUpdate = new Date().toISOString();
      ws.send(JSON.stringify(buildCallResult(uniqueId, {})));
      emitCombinedData();
      console.log(`[${chargePointId}] ${action}`, payload);
      return;

    default:
      ws.send(JSON.stringify(buildCallError(
        uniqueId,
        'NotImplemented',
        `Action ${action} is not implemented by this local server.`,
      )));
      console.warn(`[${chargePointId}] Unsupported action: ${action}`);
  }
}

socket.on('connect', () => {
  console.log(`Connected to Inverter via Modbus TCP (${MODBUS_HOST}:${currentModbusPort()})`);
  inverterData.connected = true;
  modbusConsecutiveConnectionFailures = 0;
});

socket.on('error', (err: NodeJS.ErrnoException) => {
  console.error('Modbus Socket Error:', err.message);
  inverterData.connected = false;
});

socket.on('close', () => {
  console.log('Modbus Connection Closed');
  inverterData.connected = false;

  modbusConsecutiveConnectionFailures += 1;
  if (
    MODBUS_PORTS.length > 1
    && modbusConsecutiveConnectionFailures >= MODBUS_PORT_ROTATE_THRESHOLD
  ) {
    modbusPortIndex = (modbusPortIndex + 1) % MODBUS_PORTS.length;
    modbusConsecutiveConnectionFailures = 0;
    console.warn(`Rotating Modbus port after persistent connection failures. Next port: ${currentModbusPort()}`);
  }

  setTimeout(() => {
    if (!inverterData.connected) {
      connectModbus();
    }
  }, MODBUS_RECONNECT_DELAY_MS);
});

async function pollInverter() {
  if (!inverterData.connected) return;

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

  if (inverterData.model === 'Unknown') {
    try {
      const modelRes = await client.readHoldingRegisters(30000, 15);
      inverterData.model = u16ToStr(modelRes.response.body.values);
      const snRes = await client.readHoldingRegisters(30015, 10);
      inverterData.serialNumber = u16ToStr(snRes.response.body.values);
    } catch (err) {
      console.warn('Modbus read failed (identity block):', err);
    }
  }

  try {
    const pvRes = await client.readHoldingRegisters(32016, 10);
    const pvVals = pvRes.response.body.values;
    inverterData.pv1Voltage = pvVals[0] / 10;
    inverterData.pv1Current = pvVals[1] / 100;
    inverterData.pv2Voltage = pvVals[2] / 10;
    inverterData.pv2Current = pvVals[3] / 100;
    sectionReadStatus.pv = true;
  } catch (err) {
    console.warn('Modbus read failed (PV block):', err);
  }

  try {
    const powerRes = await client.readHoldingRegisters(32064, 2);
    inverterData.inputPower = i32FromRegs(powerRes.response.body.values);
    sectionReadStatus.inputPower = true;
  } catch (err) {
    console.warn('Modbus read failed (input power):', err);
  }

  try {
    const activePowerRes = await client.readHoldingRegisters(32080, 2);
    inverterData.activePower = i32FromRegs(activePowerRes.response.body.values);
    sectionReadStatus.activePower = true;
  } catch (err) {
    console.warn('Modbus read failed (active power):', err);
  }

  try {
    const tempStatusRes = await client.readHoldingRegisters(32087, 3);
    inverterData.temperature = tempStatusRes.response.body.values[0] / 10;
    inverterData.status = tempStatusRes.response.body.values[2];
    sectionReadStatus.tempStatus = true;
  } catch (err) {
    console.warn('Modbus read failed (temperature/status):', err);
  }

  try {
    const yieldRes = await client.readHoldingRegisters(32106, 2);
    inverterData.dailyYield = u32FromRegs(yieldRes.response.body.values) / 100;

    const totalYieldRes = await client.readHoldingRegisters(32114, 2);
    inverterData.totalYield = u32FromRegs(totalYieldRes.response.body.values) / 100;
    sectionReadStatus.yields = true;
  } catch (err) {
    console.warn('Modbus read failed (yield counters):', err);
  }

  try {
    const gridRes = await client.readHoldingRegisters(32066, 4);
    inverterData.gridVoltage = gridRes.response.body.values[0] / 10;
    inverterData.gridFrequency = gridRes.response.body.values[3] / 100;
    sectionReadStatus.grid = true;
  } catch (err) {
    console.warn('Modbus read failed (grid voltage/frequency):', err);
  }

  try {
    const meterRes = await client.readHoldingRegisters(37113, 2);
    inverterData.gridPower = i32FromRegs(meterRes.response.body.values);
    sectionReadStatus.gridMeter = true;
  } catch (err) {
    console.warn('Modbus read failed (grid power meter):', err);
  }

  try {
    const battPowerRes = await client.readHoldingRegisters(37001, 2);
    inverterData.batteryPower = i32FromRegs(battPowerRes.response.body.values);
    const battSocRes = await client.readHoldingRegisters(37004, 1);
    inverterData.batterySOC = battSocRes.response.body.values[0] / 10;
    sectionReadStatus.battery = true;
  } catch (err) {
    console.warn('Modbus read failed (battery block):', err);
  }

  const totalLoad = inverterData.activePower - inverterData.gridPower + inverterData.batteryPower;
  inverterData.houseLoad = Math.max(0, totalLoad);
  inverterData.consumption = inverterData.houseLoad;

  inverterData.lastUpdate = new Date().toISOString();
  emitCombinedData();

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
    if (err) {
      console.error('Error saving to history:', err);
    }
  });
}


// Initial connection
restorePersistedChargerState();
syncChargerIntoInverterData();
persistChargerStateIfChanged(true);
connectModbus();

// Poll every 2 seconds
setInterval(pollInverter, 2000);

const ocppHttpServer = createServer((req, res) => {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Use WebSocket OCPP endpoint.' }));
});

const ocppWss = new WebSocketServer({
  server: ocppHttpServer,
  handleProtocols: (protocols) => {
    if (protocols.has('ocpp1.6')) {
      return 'ocpp1.6';
    }
    return false;
  },
});

ocppWss.on('connection', (ws, req) => {
  const requestPath = req.url ?? '/';
  if (!requestPath.startsWith(`${OCPP_PATH_PREFIX}/`)) {
    console.warn(`Rejected OCPP path: ${requestPath}`);
    ws.close(1008, 'Invalid OCPP path');
    return;
  }

  const chargePointId = extractChargePointId(requestPath);
  chargerState.connected = true;
  chargerState.chargePointId = chargePointId;
  chargerState.lastUpdate = new Date().toISOString();
  chargerWs = ws;
  emitCombinedData();

  console.log(`OCPP connection opened for ${chargePointId} (${req.socket.remoteAddress ?? 'unknown'})`);
  reconcileChargerControlState('WebSocketConnected');

  ws.on('message', (raw) => {
    try {
      const parsed = JSON.parse(raw.toString());
      if (!Array.isArray(parsed) || parsed.length < 3) {
        return;
      }

      const messageType = parsed[0];

      if (messageType === 2) {
        // Call from charger
        handleOcppCall(ws, chargePointId, parsed as OcppCall);
      } else if (messageType === 3) {
        // CallResult: charger responded to one of our commands
        console.log(`[${chargePointId}] ← CallResult:`, JSON.stringify(parsed[2], null, 2));
      } else if (messageType === 4) {
        // CallError: charger rejected one of our commands
        console.warn(`[${chargePointId}] ← CallError:`, JSON.stringify(parsed, null, 2));
      }
    } catch (error) {
      console.error(`[${chargePointId}] Could not parse OCPP frame`, error);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`OCPP connection closed for ${chargePointId} (${code}) ${reason.toString()}`);
    chargerWs = null;
    chargerState.connected = false;
    chargerState.lastUpdate = new Date().toISOString();
    emitCombinedData();
  });

  ws.on('error', (error) => {
    console.error(`OCPP socket error for ${chargePointId}:`, error);
  });
});

ocppHttpServer.on('error', (error) => {
  console.error(`OCPP server failed on ${OCPP_HOST}:${OCPP_PORT}`, error);
});

ocppHttpServer.listen(OCPP_PORT, OCPP_HOST, () => {
  console.log(`OCPP server listening on ws://${OCPP_HOST}:${OCPP_PORT}${OCPP_PATH_PREFIX}/<chargePointId>`);
});

// REST API: charger control
app.use(express.json());

app.post('/api/charger/start', (req, res) => {
  if (!canSendToCharger()) {
    res.status(503).json({ error: 'Charger not connected' });
    return;
  }

  chargerState.startRequested = true;
  chargerState.lastUpdate = new Date().toISOString();

  if (chargerState.chargingMode === 'GREEN' || chargerState.chargingMode === 'HYBRID') {
    reconcileChargerControlState('ApiStart');
    res.json({
      status: chargerState.status === 'Charging' ? 'sent' : 'armed',
      mode: chargerState.chargingMode,
      limitA: chargerState.appliedCurrentLimitA ?? null,
    });
    return;
  }

  clearChargingLimit();
  sendRemoteStartTransaction();
  res.json({ status: 'sent', mode: chargerState.chargingMode });
});

app.post('/api/charger/stop', (req, res) => {
  if (!canSendToCharger()) {
    res.status(503).json({ error: 'Charger not connected' });
    return;
  }

  chargerState.startRequested = false;
  chargerState.appliedCurrentLimitA = undefined;
  chargerState.lastRequestedCurrentLimitA = undefined;
  clearChargingLimit();

  if (chargerState.status === 'Charging') {
    sendRemoteStopTransaction();
    res.json({ status: 'sent' });
    return;
  }

  chargerState.lastUpdate = new Date().toISOString();
  emitCombinedData();
  res.json({ status: 'cancelled' });
});

app.post('/api/charger/mode', (req, res) => {
  const modeRaw = String(req.body?.mode ?? '').toUpperCase();
  if (modeRaw !== 'FAST' && modeRaw !== 'GREEN' && modeRaw !== 'HYBRID') {
    res.status(400).json({ error: 'Invalid mode. Use FAST, GREEN or HYBRID.' });
    return;
  }

  const mode = modeRaw as ChargingMode;
  chargerState.chargingMode = mode;
  chargerState.lastUpdate = new Date().toISOString();

  if (mode === 'FAST') {
    clearChargingLimit();
  } else {
    reconcileChargerControlState('ApiModeChange');
  }

  emitCombinedData();
  console.log(`[API] Charger mode changed to ${mode}`);
  res.json({
    status: 'ok',
    mode: chargerState.chargingMode,
    limitA: chargerState.appliedCurrentLimitA ?? null,
  });
});

setInterval(() => {
  applySmartChargingPolicy();
}, GREEN_CONTROL_LOOP_MS);

app.get('/api/logs/live', (req, res) => {
  res.json(liveLogs);
});

app.get('/api/logs/:date', (req, res) => {
  const filePath = path.join(LOGS_DIR, `${req.params.date}.jsonl`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Logs not found for this date' });
  }

  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'Error reading logs' });

    try {
      const records = data
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      res.json(records);
    } catch (error) {
      res.status(500).json({ error: 'Corrupt log file' });
    }
  });
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        watch: {
          ignored: ['**/logs/**', '**/history/**'],
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// History API
app.get('/api/history/list', (req, res) => {
  fs.readdir(HISTORY_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: 'Could not list history' });
    const days = files
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort((a, b) => b.localeCompare(a));
    res.json(days);
  });
});

app.get('/api/history/:date', (req, res) => {
  const filePath = path.join(HISTORY_DIR, `${req.params.date}.jsonl`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'History not found for this date' });
  }

  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'Error reading history' });
    try {
      const records = data
        .trim()
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line));
      res.json(records);
    } catch (e) {
      res.status(500).json({ error: 'Corrupt history file' });
    }
  });
});

startServer();


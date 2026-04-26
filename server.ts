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
const SERVER_START_TIME = new Date();

const OCPP_HOST = process.env.OCPP_HOST ?? '0.0.0.0';
const OCPP_PORT = Number(process.env.OCPP_PORT ?? 9100);
const OCPP_PATH_PREFIX = process.env.OCPP_PATH_PREFIX ?? '/ocpp';
const OCPP_HEARTBEAT_INTERVAL = Number(process.env.OCPP_HEARTBEAT_INTERVAL ?? 30);

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
  lastUpdate: string;
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
  lastUpdate: new Date().toISOString(),
};

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
  consumption: 0,
  lastUpdate: new Date().toISOString(),
  connected: false
};

const socket = new net.Socket();
const client = new ModbusClient.TCP(socket, SLAVE_ID);
let modbusPortIndex = 0;

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
}

function emitCombinedData() {
  syncChargerIntoInverterData();
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

let transactionIdCounter = 0;
function generateTransactionId(): number {
  return ++transactionIdCounter;
}

function buildCall(action: string, payload: Record<string, any>): OcppCall {
  return [2, generateCallId(), action, payload];
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
      chargerState.transactionId = undefined;
      chargerState.powerW = 0;
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
});

socket.on('error', (err: NodeJS.ErrnoException) => {
  console.error('Modbus Socket Error:', err.message);
  inverterData.connected = false;
});

socket.on('close', () => {
  console.log('Modbus Connection Closed');
  inverterData.connected = false;

  // Rotate through configured ports to support installations that use 6607 instead of 502.
  modbusPortIndex = (modbusPortIndex + 1) % MODBUS_PORTS.length;

  setTimeout(() => {
    if (!inverterData.connected) {
      connectModbus();
    }
  }, 5000);
});

async function pollInverter() {
  if (!inverterData.connected) return;

  try {
    if (inverterData.model === 'Unknown') {
      const modelRes = await client.readHoldingRegisters(30000, 15);
      inverterData.model = u16ToStr(modelRes.response.body.values);
      const snRes = await client.readHoldingRegisters(30015, 10);
      inverterData.serialNumber = u16ToStr(snRes.response.body.values);
    }

    const pvRes = await client.readHoldingRegisters(32016, 10);
    const pvVals = pvRes.response.body.values;
    inverterData.pv1Voltage = pvVals[0] / 10;
    inverterData.pv1Current = pvVals[1] / 100;
    inverterData.pv2Voltage = pvVals[2] / 10;
    inverterData.pv2Current = pvVals[3] / 100;

    const powerRes = await client.readHoldingRegisters(32064, 2);
    inverterData.inputPower = i32FromRegs(powerRes.response.body.values);

    const activePowerRes = await client.readHoldingRegisters(32080, 2);
    inverterData.activePower = i32FromRegs(activePowerRes.response.body.values);

    const tempStatusRes = await client.readHoldingRegisters(32087, 3);
    inverterData.temperature = tempStatusRes.response.body.values[0] / 10;
    inverterData.status = tempStatusRes.response.body.values[2];

    const yieldRes = await client.readHoldingRegisters(32106, 2);
    inverterData.dailyYield = u32FromRegs(yieldRes.response.body.values) / 100;

    const totalYieldRes = await client.readHoldingRegisters(32114, 2);
    inverterData.totalYield = u32FromRegs(totalYieldRes.response.body.values) / 100;

    const gridRes = await client.readHoldingRegisters(32066, 4);
    inverterData.gridVoltage = gridRes.response.body.values[0] / 10;
    inverterData.gridFrequency = gridRes.response.body.values[3] / 100;

    try {
      const meterRes = await client.readHoldingRegisters(37113, 2);
      inverterData.gridPower = i32FromRegs(meterRes.response.body.values);
    } catch (e) {
      inverterData.gridPower = 0;
    }

    try {
      const battPowerRes = await client.readHoldingRegisters(37001, 2);
      inverterData.batteryPower = i32FromRegs(battPowerRes.response.body.values);
      const battSocRes = await client.readHoldingRegisters(37004, 1);
      inverterData.batterySOC = battSocRes.response.body.values[0] / 10;
    } catch (e) {
      inverterData.batteryPower = 0;
      inverterData.batterySOC = 0;
    }

    // Calculation
    const totalLoad = inverterData.activePower - inverterData.gridPower + inverterData.batteryPower;
    inverterData.houseLoad = Math.max(0, totalLoad);
    inverterData.consumption = inverterData.houseLoad;

    inverterData.lastUpdate = new Date().toISOString();
    emitCombinedData();

    // Save to history
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(HISTORY_DIR, `${today}.jsonl`);
    const logEntry = JSON.stringify({
      time: inverterData.lastUpdate,
      power: inverterData.activePower,
      inputPower: inverterData.inputPower,
      consumption: inverterData.consumption,
      batterySOC: inverterData.batterySOC,
      gridPower: inverterData.gridPower
    }) + '\n';

    fs.appendFile(logFile, logEntry, (err) => {
      if (err) console.error('Error saving to history:', err);
    });

  } catch (err) {

    console.error('Polling Error:', err);
  }
}


// Initial connection
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

  // After a short delay (let the charger send BootNotification/StatusNotification first),
  // send configuration commands to enable MeterValues reporting
  setTimeout(() => {
    if (ws.readyState !== ws.OPEN) return;

    // 1) Discover current configuration
    const getConfig = buildCall('GetConfiguration', {});
    ws.send(JSON.stringify(getConfig));
    console.log(`[${chargePointId}] → GetConfiguration`);

    // 2) Set sampling interval to 10 seconds
    setTimeout(() => {
      if (ws.readyState !== ws.OPEN) return;
      const setInterval = buildCall('ChangeConfiguration', {
        key: 'MeterValueSampleInterval',
        value: '10',
      });
      ws.send(JSON.stringify(setInterval));
      console.log(`[${chargePointId}] → ChangeConfiguration MeterValueSampleInterval=10`);
    }, 1000);

    // 3) Set what measurands to sample
    setTimeout(() => {
      if (ws.readyState !== ws.OPEN) return;
      const setMeasurands = buildCall('ChangeConfiguration', {
        key: 'MeterValuesSampledData',
        value: 'Power.Active.Import,Energy.Active.Import.Register',
      });
      ws.send(JSON.stringify(setMeasurands));
      console.log(`[${chargePointId}] → ChangeConfiguration MeterValuesSampledData`);
    }, 2000);

    // 4) Ask charger to push a MeterValues immediately
    setTimeout(() => {
      if (ws.readyState !== ws.OPEN) return;
      const trigger = buildCall('TriggerMessage', {
        requestedMessage: 'MeterValues',
        connectorId: 1,
      });
      ws.send(JSON.stringify(trigger));
      console.log(`[${chargePointId}] → TriggerMessage MeterValues`);
    }, 3000);
  }, 3000);

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
    chargerState.status = 'Disconnected';
    chargerState.powerW = 0;
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
  if (!chargerWs || chargerWs.readyState !== chargerWs.OPEN) {
    res.status(503).json({ error: 'Charger not connected' });
    return;
  }
  const cmd = buildCall('RemoteStartTransaction', { connectorId: 1, idTag: 'Dashboard' });
  chargerWs.send(JSON.stringify(cmd));
  console.log(`[API] → RemoteStartTransaction`);
  res.json({ status: 'sent' });
});

app.post('/api/charger/stop', (req, res) => {
  if (!chargerWs || chargerWs.readyState !== chargerWs.OPEN) {
    res.status(503).json({ error: 'Charger not connected' });
    return;
  }
  // Use known transactionId or 0 as fallback (charger will match the active transaction)
  const txId = chargerState.transactionId ?? 0;
  const cmd = buildCall('RemoteStopTransaction', { transactionId: txId });
  chargerWs.send(JSON.stringify(cmd));
  console.log(`[API] → RemoteStopTransaction txId=${txId}`);
  res.json({ status: 'sent' });
});

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


import express from 'express';
import { createServer } from 'http';
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

const PORT = 3001;
const MODBUS_HOST = '192.168.1.140';
const MODBUS_PORT = 502;
const SLAVE_ID = 1;
const HISTORY_DIR = path.join(process.cwd(), 'history');


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
  consumption: 0,
  lastUpdate: new Date().toISOString(),
  connected: false
};

const socket = new net.Socket();
const client = new ModbusClient.TCP(socket, SLAVE_ID);

socket.on('connect', () => {
  console.log('Connected to Inverter via Modbus TCP');
  inverterData.connected = true;
});

socket.on('error', (err) => {
  console.error('Modbus Socket Error:', err.message);
  inverterData.connected = false;
});

socket.on('close', () => {
  console.log('Modbus Connection Closed');
  inverterData.connected = false;
  setTimeout(() => {
    if (!inverterData.connected) {
      socket.connect({ host: MODBUS_HOST, port: MODBUS_PORT });
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
    io.emit('inverter-data', inverterData);

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
socket.connect({ host: MODBUS_HOST, port: MODBUS_PORT });

// Poll every 2 seconds
setInterval(pollInverter, 2000);

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
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


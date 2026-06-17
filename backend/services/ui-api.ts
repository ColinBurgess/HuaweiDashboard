/**
 * UI/Dashboard API Service
 * Handles Express routes, Socket.io, and HTTP server for the dashboard
 * Runs in: monolith mode or 'dashboard' service role
 */

import express, { Express } from 'express';
import { createServer, Server as HttpServer } from 'http';
import { Server as SocketIoServer, Socket } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import {
  PORT,
  LOGS_DIR,
  HISTORY_DIR,
  MAX_LIVE_LOGS,
  RuntimeLogEntry,
  MODBUS_POLLING_INTERVAL,
  MODBUS_HOST,
  MODBUS_PORTS,
} from '../config/constants.js';
import {
  calculateStatsForDate,
  queryInfluxStats,
} from '../utils/stats.js';
import {
  chargerState,
  inverterData,
  ChargingMode,
  saveLiveState,
  loadLiveState,
  persistChargerStateIfChanged,
} from '../ipc/state-manager.js';

// ============================================================================
// EXPRESS & SOCKET.IO INITIALIZATION
// ============================================================================

const isDashboard = process.env.SERVICE_ROLE === 'dashboard' || process.env.START_MONOLITH === 'true' || (!process.env.SERVICE_ROLE && process.argv[1].endsWith('server.ts')) || (!process.env.SERVICE_ROLE && process.argv[1].endsWith('server.js'));

/**
 * Express application
 */
export const app: Express | null = isDashboard ? express() : null;

/**
 * HTTP server wrapping Express
 */
export const httpServer: HttpServer | null = app ? createServer(app) : null;

/**
 * Socket.io server for real-time updates
 */
export const io: SocketIoServer | null = httpServer ? new SocketIoServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
}) : null;

// ============================================================================
// LIVE LOGGING STATE
// ============================================================================

let liveLogs: RuntimeLogEntry[] = [];
let lastLogPosition = 0;

/**
 * Store a log entry in memory with balanced distribution across services
 */
function storeLiveLog(entry: RuntimeLogEntry) {
  liveLogs.push(entry);

  // If we exceed max logs, remove oldest entry from the service with most logs
  if (liveLogs.length > MAX_LIVE_LOGS) {
    // Count logs by source
    const sourceCount: Record<string, number> = {};
    for (const log of liveLogs) {
      sourceCount[log.source] = (sourceCount[log.source] || 0) + 1;
    }

    // Find service with most logs
    const maxSource = Object.entries(sourceCount).sort((a, b) => b[1] - a[1])[0]?.[0];

    if (maxSource) {
      // Remove oldest log from that service
      const idx = liveLogs.findIndex(log => log.source === maxSource);
      if (idx !== -1) {
        liveLogs.splice(idx, 1);
      }
    } else {
      // Fallback: just remove first log
      liveLogs.splice(0, 1);
    }
  }

  if (io) {
    io.emit('server-log', entry);
  }
}

/**
 * Read new logs from combined.jsonl and emit them via Socket.io
 */
function readAndEmitLogs() {
  try {
    const combinedLogPath = path.resolve(LOGS_DIR, 'combined.jsonl');
    if (!fs.existsSync(combinedLogPath)) return;

    const content = fs.readFileSync(combinedLogPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    // Get only new lines since last read
    const newLines = lines.slice(lastLogPosition);
    lastLogPosition = lines.length;

    for (const line of newLines) {
      try {
        const entry = JSON.parse(line) as RuntimeLogEntry;
        storeLiveLog(entry);
      } catch (e) {
        // Skip malformed lines
      }
    }
  } catch (err) {
    // Silently fail to avoid noisy logs
  }
}

// ============================================================================
// SOCKET.IO CONNECTION HANDLER
// ============================================================================

if (io) {
  io.on('connection', (socket: Socket) => {
    // Load live state when dashboard connects
    if (process.env.SERVICE_ROLE === 'dashboard') {
      loadLiveState();
    }
    // Send current inverter data to client
    socket.emit('inverter-data', inverterData);
    // Send current logs
    socket.emit('initial-logs', liveLogs);
  });
}

// ============================================================================
// EXPRESS ROUTES - CHARGER CONTROL
// ============================================================================

if (app) {
  app.use(express.json());

  /**
   * POST /api/charger/start
   * Request charger to start charging
   */
  app.post('/api/charger/start', (req, res) => {
    chargerState.startRequested = true;
    chargerState.lastUpdate = new Date().toISOString();
    saveLiveState();

    res.json({ status: 'sent', mode: chargerState.chargingMode });
  });

  /**
   * POST /api/charger/stop
   * Request charger to stop charging
   */
  app.post('/api/charger/stop', (req, res) => {
    chargerState.startRequested = false;
    chargerState.appliedCurrentLimitA = undefined;
    chargerState.lastRequestedCurrentLimitA = undefined;
    chargerState.lastUpdate = new Date().toISOString();
    saveLiveState();

    res.json({ status: 'sent' });
  });

  /**
   * POST /api/charger/mode
   * Change charging mode (FAST, GREEN, or HYBRID)
   */
  app.post('/api/charger/mode', (req, res) => {
    const modeRaw = String(req.body?.mode ?? '').toUpperCase();
    if (modeRaw !== 'FAST' && modeRaw !== 'GREEN' && modeRaw !== 'HYBRID') {
      res.status(400).json({ error: 'Invalid mode. Use FAST, GREEN or HYBRID.' });
      return;
    }

    const mode = modeRaw as ChargingMode;
    chargerState.chargingMode = mode;
    chargerState.lastUpdate = new Date().toISOString();
    saveLiveState();

    res.json({
      status: 'ok',
      mode: chargerState.chargingMode,
      limitA: chargerState.appliedCurrentLimitA ?? null,
    });
  });

  /**
   * POST /api/charger/probe-smart
   * Send smart charging probe (dashboard role just saves to state)
   */
  app.post('/api/charger/probe-smart', (req, res) => {
    if (!chargerState.connected) {
      res.status(503).json({ error: 'Charger not connected' });
      return;
    }

    res.json({
      status: 'sent',
      chargePointId: chargerState.chargePointId,
      txId: chargerState.transactionId ?? null,
    });
  });

  // ============================================================================
  // EXPRESS ROUTES - LOGGING
  // ============================================================================

  /**
   * GET /api/logs/live
   * Get recent runtime logs (in-memory buffer)
   */
  app.get('/api/logs/live', (req, res) => {
    res.json(liveLogs);
  });

  /**
   * GET /api/logs/:date
   * Get runtime logs for a specific date (from disk)
   */
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

  // ============================================================================
  // EXPRESS ROUTES - DIAGNOSTICS & CONFIG
  // ============================================================================

  /**
   * GET /api/config/collector
   * Returns the current collector service configuration
   * Useful for verifying that environment variables are applied correctly
   */
  app.get('/api/config/collector', (req, res) => {
    res.json({
      pollingInterval: MODBUS_POLLING_INTERVAL,
      modbusHost: MODBUS_HOST,
      modbusPorts: MODBUS_PORTS,
      connected: inverterData.connected,
      model: inverterData.model,
      serialNumber: inverterData.serialNumber,
      lastUpdate: inverterData.lastUpdate,
    });
  });

  // ============================================================================
  // EXPRESS ROUTES - HISTORY
  // ============================================================================

  /**
   * GET /api/history/list
   * List all available history dates
   */
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

  /**
   * GET /api/history/:date
   * Get telemetry history for a specific date
   */
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

  // ============================================================================
  // EXPRESS ROUTES - STATISTICS
  // ============================================================================

  /**
   * GET /api/stats/summary
   * Get statistics for today
   *
   * 🚧 WIP: Energy Statistics section needs refinement
   *    - Query logic implemented and working
   *    - UI display in frontend needs improvement
   *    - Period calculations may need optimization
   *    - Marked for enhancement in future development sessions
   */
  app.get('/api/stats/summary', async (req, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const stats = await calculateStatsForDate(today);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: 'Failed to calculate stats' });
    }
  });

  /**
   * GET /api/stats/:period
   * Get statistics for a time period (day, month, year)
   */
  app.get('/api/stats/:period', async (req, res) => {
    const { period } = req.params;
    const { date, month, year } = req.query;

    let start, stop;

    if (period === 'day') {
      const stats = await calculateStatsForDate(date as string);
      return res.json(stats);
    } else if (period === 'month') {
      start = `${year}-${String(month).padStart(2, '0')}-01T00:00:00Z`;
      const nextMonth = Number(month) === 12 ? 1 : Number(month) + 1;
      const nextYear = Number(month) === 12 ? Number(year) + 1 : Number(year);
      stop = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00Z`;
    } else if (period === 'year') {
      start = `${year}-01-01T00:00:00Z`;
      stop = `${Number(year) + 1}-01-01T00:00:00Z`;
    } else {
      return res.status(400).json({ error: 'Invalid period' });
    }

    try {
      const stats = await queryInfluxStats(start, stop);
      res.json(stats || { production: 0, consumption: 0, export: 0, import: 0, selfConsumption: 0 });
    } catch (err) {
      console.warn(`[WARN] Stats query failed:`, (err as any).message);
      res.json({ production: 0, consumption: 0, export: 0, import: 0, selfConsumption: 0 });
    }
  });
}

// ============================================================================
// HTTP SERVER STARTUP
// ============================================================================

/**
 * Start Express server
 */
async function startServer() {
  if (!app || !httpServer) return;

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
    const distPath = process.env.DIST_PATH || path.resolve(process.cwd(), 'dist');
    console.log(`[INFO] Serving static files from: ${distPath}`);
    if (!fs.existsSync(distPath)) {
      console.warn(`[WARN] Production directory not found at ${distPath}. Did you run 'npm run build'?`);
    }
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Frontend build not found. Please run npm run build.');
      }
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Dashboard API listening on port ${PORT}`);
  });
}

// ============================================================================
// SERVICE STARTUP
// ============================================================================

/**
 * Update service health heartbeat
 * Sends status information and persists it
 */
function updateServiceHeartbeat(status = 'OK', details?: string) {
  const role = process.env.SERVICE_ROLE || 'monolith';
  inverterData.services[role] = {
    lastHeartbeat: new Date().toISOString(),
    status,
    details
  };
  saveLiveState();
  persistChargerStateIfChanged();
}

/**
 * Start the dashboard service
 */
export async function startDashboardService() {
  console.log('🚀 Starting Dashboard Service (API + UI)...');

  if (process.env.SERVICE_ROLE === 'dashboard') {
    loadLiveState();
    setInterval(loadLiveState, 1000);

    // Emit real-time inverter data to connected clients every second
    // This powers the Power & Consumption widget with live updates
    if (io) {
      setInterval(() => {
        io.emit('inverter-data', inverterData);
      }, 1000);
    }

    // Read logs from file every 500ms
    readAndEmitLogs();
    setInterval(readAndEmitLogs, 500);

    // Update heartbeat every 10 seconds
    setInterval(() => updateServiceHeartbeat('OK'), 10000);
    // Initial heartbeat
    updateServiceHeartbeat('OK');
  }

  await startServer();
}

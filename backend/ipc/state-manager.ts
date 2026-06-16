/**
 * State Management Module
 * Handles persistence and synchronization of application state across IPC boundaries
 */

import fs from 'fs';
import path from 'path';
import {
  CHARGER_STATE_FILE,
  DATA_DIR,
  ChargingMode,
} from '../config/constants.js';

// Re-export types for convenience
export type { ChargingMode };

const CHARGER_STATE_TMP_FILE = `${CHARGER_STATE_FILE}.tmp`;

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * In-memory charger state (runtime)
 */
export type ChargerState = {
  connected: boolean;
  cableConnected: boolean;
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

/**
 * Persisted charger state (on disk)
 */
export type PersistedChargerState = {
  chargingMode: ChargingMode;
  startRequested: boolean;
  appliedCurrentLimitA: number | null;
  lastRequestedCurrentLimitA: number | null;
  transactionId: number | null;
  connected: boolean;
  cableConnected: boolean;
  status: string;
  powerW: number;
  savedAt: string;
};

/**
 * OCPP protocol message types
 */
export type OcppCall = [2, string, string, Record<string, any>];
export type OcppCallResult = [3, string, Record<string, unknown>];
export type OcppCallError = [4, string, string, string, Record<string, unknown>];

// ============================================================================
// STATE OBJECTS (Exported - Mutable by other services)
// ============================================================================

/**
 * In-memory charger state
 * Mutable object shared across modules
 */
export const chargerState: ChargerState = {
  connected: false,
  cableConnected: false,
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

/**
 * In-memory inverter data
 * Combines inverter telemetry + charger state + UI commands
 * Mutable object shared across modules
 */
export let inverterData = {
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
  chargerCableConnected: false,
  chargerStatus: 'Disconnected',
  chargePointId: 'Unknown',
  chargerLastUpdate: new Date().toISOString(),
  chargingMode: 'FAST' as ChargingMode,
  chargerStartRequested: false,
  chargerCurrentLimitA: null as number | null,
  consumption: 0,
  lastUpdate: new Date().toISOString(),
  connected: false,
  pvConnectionStatus: true,
  pvStringLossAlarm: false,
  services: {} as Record<string, { lastHeartbeat: string, status: string, details?: string }>
};

// ============================================================================
// IPC FIELD OWNERSHIP
// ============================================================================

/**
 * Defines which service is the "owner" of each field in inverterData
 * Prevents race conditions in multi-process environments
 *
 * - collector: Modbus telemetry fields (voltage, power, yield, etc)
 * - charger: OCPP connector fields (connected, cable, status, power)
 * - dashboard: UI command fields (chargingMode, startRequested)
 */
export const SERVICE_OWNED_FIELDS: Record<string, string[]> = {
  collector: [
    'model', 'serialNumber', 'activePower', 'pv1Voltage', 'pv1Current',
    'pv2Voltage', 'pv2Current', 'inputPower', 'dailyYield', 'totalYield',
    'temperature', 'status', 'gridVoltage', 'gridFrequency', 'gridPower',
    'batteryPower', 'batterySOC', 'houseLoad', 'consumption', 'lastUpdate', 'connected'
  ],
  charger: [
    'chargerConnected', 'chargerCableConnected', 'chargerStatus', 'carChargePower',
    'chargePointId', 'chargerLastUpdate', 'chargerCurrentLimitA'
  ],
  dashboard: [
    'chargingMode', 'chargerStartRequested'
  ]
};

// ============================================================================
// INTERNAL STATE
// ============================================================================

let lastPersistedChargerStateSignature = '';

// ============================================================================
// CHARGER STATE PERSISTENCE
// ============================================================================

/**
 * Build a JSON signature of charger state fields for change detection
 * @internal
 */
function buildChargerStateSignature(): string {
  return JSON.stringify({
    chargingMode: chargerState.chargingMode,
    startRequested: chargerState.startRequested,
    appliedCurrentLimitA: chargerState.appliedCurrentLimitA ?? null,
    lastRequestedCurrentLimitA: chargerState.lastRequestedCurrentLimitA ?? null,
    transactionId: chargerState.transactionId ?? null,
    connected: chargerState.connected,
    cableConnected: chargerState.cableConnected,
    status: chargerState.status,
    powerW: chargerState.powerW,
  });
}

/**
 * Persist charger state to disk if it has changed
 * Uses atomic writes (write to .tmp, then rename) to prevent corruption
 *
 * @param force - Force persistence even if no changes detected
 * @internal
 */
export function persistChargerStateIfChanged(force = false): void {
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
      connected: chargerState.connected,
      cableConnected: chargerState.cableConnected,
      status: chargerState.status,
      powerW: chargerState.powerW,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(CHARGER_STATE_TMP_FILE, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(CHARGER_STATE_TMP_FILE, CHARGER_STATE_FILE);
    lastPersistedChargerStateSignature = signature;
  } catch (error) {
    console.error('Failed to persist charger state:', error);
  }
}

/**
 * Restore charger state from disk if available
 * Loads persisted charger configuration (mode, start request, limits, etc.)
 * @internal
 */
export function restorePersistedChargerState(): void {
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

    chargerState.connected = Boolean(parsed.connected);
    chargerState.cableConnected = Boolean(parsed.cableConnected);
    chargerState.status = String(parsed.status ?? 'Disconnected');
    chargerState.powerW = Number(parsed.powerW ?? 0);

    chargerState.lastUpdate = new Date().toISOString();
    lastPersistedChargerStateSignature = buildChargerStateSignature();

    console.log(
      `[STATE] Restored charger state mode=${chargerState.chargingMode} startRequested=${chargerState.startRequested} txId=${chargerState.transactionId ?? 'none'} appliedLimitA=${chargerState.appliedCurrentLimitA ?? 'none'} lastRequestedLimitA=${chargerState.lastRequestedCurrentLimitA ?? 'none'} savedAt=${parsed.savedAt ?? 'unknown'}`,
    );
  } catch (error) {
    console.error('Failed to restore charger state:', error);
  }
}

// ============================================================================
// IPC STATE SYNCHRONIZATION (Modular Architecture)
// ============================================================================

/**
 * Save service-owned fields to disk (Modular mode only)
 * Each service writes only its own fields to live-state-{role}.json
 * Uses atomic writes to prevent corruption from concurrent access
 *
 * Called by modular services (collector, charger, dashboard) to sync state
 * @internal
 */
export function saveLiveState() {
  const role = process.env.SERVICE_ROLE || 'monolith';
  const targetFile = path.resolve(DATA_DIR, `live-state-${role}.json`);

  try {
    const ownedFields = SERVICE_OWNED_FIELDS[role] || [];
    const dataToSave: any = {};

    ownedFields.forEach(field => {
      if ((inverterData as any)[field] !== undefined) {
        dataToSave[field] = (inverterData as any)[field];
      }
    });

    if (inverterData.services[role]) {
      dataToSave.services = { [role]: inverterData.services[role] };
    }

    // Escritura atómica para prevenir lecturas corruptas de otros contenedores
    const tmpFile = `${targetFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(dataToSave, null, 2), 'utf8');
    fs.renameSync(tmpFile, targetFile);
  } catch (err) {
    console.error(`[ERROR] Failed to save live state for ${role}:`, err);
    console.error(`[DEBUG] inverterData.services[${role}]:`, inverterData.services[role]);
  }
}

/**
 * Load state from other services' files (Modular mode only)
 * Merges state from live-state-{collector,charger,dashboard}.json files
 * Updates chargerState object if chargingMode or startRequested changes detected
 *
 * Called periodically (~1s) to sync state from other services
 * @internal
 */
export function loadLiveState() {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('live-state-') && f.endsWith('.json'));
    const role = process.env.SERVICE_ROLE || 'monolith';

    for (const file of files) {
      if (file === `live-state-${role}.json`) continue;

      const filePath = path.join(DATA_DIR, file);
      if (!fs.existsSync(filePath)) continue;

      const fileContent = fs.readFileSync(filePath, 'utf8');
      if (!fileContent) continue;

      let data;
      try {
        data = JSON.parse(fileContent);
      } catch (e) {
        continue;
      }

      if (data.services) {
        inverterData.services = { ...inverterData.services, ...data.services };
        delete data.services;
      }

      const modeChanged = data.chargingMode && data.chargingMode !== inverterData.chargingMode;
      const startChanged = data.chargerStartRequested !== undefined && data.chargerStartRequested !== inverterData.chargerStartRequested;

      Object.assign(inverterData, data);

      if (modeChanged || startChanged) {
        const isChargerRole = process.env.SERVICE_ROLE === 'charger';
        const isMonolithLocal = process.env.START_MONOLITH === 'true';

        if (isChargerRole || isMonolithLocal) {
          console.log(`[SYNC] Detected external command change: mode=${inverterData.chargingMode} start=${inverterData.chargerStartRequested}`);
          chargerState.chargingMode = inverterData.chargingMode;
          chargerState.startRequested = inverterData.chargerStartRequested;

          // Este callback será llamado desde ocpp-charger.ts cuando se implemente
          // Por ahora, la lógica de reconciliación va directamente en server.ts
          // TODO: Migrar a ocpp-charger.ts en Paso 3
        }
      }
    }

    chargerState.connected = inverterData.chargerConnected;
    chargerState.cableConnected = inverterData.chargerCableConnected;
    chargerState.status = inverterData.chargerStatus;
    chargerState.chargePointId = inverterData.chargePointId;
    chargerState.lastUpdate = inverterData.chargerLastUpdate;
    chargerState.chargingMode = inverterData.chargingMode;
    chargerState.startRequested = inverterData.chargerStartRequested;
    chargerState.appliedCurrentLimitA = inverterData.chargerCurrentLimitA ?? undefined;
  } catch (error) {
    // Ignorar fallos de acceso o locks temporales
  }
}

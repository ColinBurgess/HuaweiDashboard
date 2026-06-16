/**
 * Configuration module for HuaweiDashboard
 * Centralizes all environment variables, constants, and configuration values
 */

import path from 'path';

// ============================================================================
// ENVIRONMENT VARIABLES & BASIC CONFIGURATION
// ============================================================================

// Service Role Detection
export const SERVICE_ROLE = process.env.SERVICE_ROLE || 'monolith';
export const START_MONOLITH = process.env.START_MONOLITH === 'true';

export const role = SERVICE_ROLE;
export const isMonolith = START_MONOLITH || process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js');
export const isDashboard = isMonolith || role === 'dashboard';
export const isCharger = isMonolith || role === 'charger';
export const isCollector = isMonolith || role === 'collector';

// ============================================================================
// DASHBOARD / API CONFIGURATION
// ============================================================================

export const PORT = Number(process.env.PORT ?? process.env.APP_PORT ?? 3001);
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const DIST_PATH = process.env.DIST_PATH || path.resolve(process.cwd(), 'dist');

// ============================================================================
// MODBUS INVERTER CONFIGURATION
// ============================================================================

export const MODBUS_HOST = process.env.MODBUS_HOST ?? '192.168.1.140';
export const MODBUS_PORTS: number[] = (process.env.MODBUS_PORTS ?? process.env.MODBUS_PORT ?? '502,6607')
  .split(',')
  .map((port) => Number(port.trim()))
  .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);

export const SLAVE_ID = 1;
export const MODBUS_RECONNECT_DELAY_MS = 10_000;
export const MODBUS_PORT_ROTATE_THRESHOLD = 3;
export const MODBUS_HAS_BATTERY = String(process.env.MODBUS_HAS_BATTERY ?? 'true').toLowerCase() !== 'false';

/**
 * Modbus register map for inverter telemetry
 * Maps register addresses to parameter descriptions and conversion types
 */
export const MODBUS_REGISTRY_MAP = [
  { address: 30000, length: 15, name: "Identidad del Inversor (Model)", type: "String (ASCII)" },
  { address: 30015, length: 10, name: "Número de Serie (SN)", type: "String (ASCII)" },
  { address: 32016, length: 1,  name: "Tensión Placas String 1 (PV1 V)", type: "U16 / 10 (V)" },
  { address: 32017, length: 1,  name: "Corriente Placas String 1 (PV1 A)", type: "U16 / 100 (A)" },
  { address: 32018, length: 1,  name: "Tensión Placas String 2 (PV2 V)", type: "U16 / 10 (V)" },
  { address: 32019, length: 1,  name: "Corriente Placas String 2 (PV2 A)", type: "U16 / 100 (A)" },
  { address: 32064, length: 2,  name: "Potencia Entrada Total Solar", type: "I32 (W)" },
  { address: 32066, length: 1,  name: "Tensión de Red Eléctrica", type: "U16 / 10 (V)" },
  { address: 32069, length: 1,  name: "Frecuencia de Red Eléctrica", type: "U16 / 100 (Hz)" },
  { address: 32080, length: 2,  name: "Potencia Activa Inversor", type: "I32 (W)" },
  { address: 32087, length: 1,  name: "Temperatura del Inversor", type: "U16 / 10 (°C)" },
  { address: 32089, length: 1,  name: "Estado de Operación Inversor", type: "U16" },
  { address: 32114, length: 2,  name: "Producción Solar Diaria (Yield)", type: "I32 / 100 (kWh)" },
  { address: 37113, length: 2,  name: "Lectura Contador de Red (Meter)", type: "I32 (W)" },
  { address: 32002, length: 1,  name: "Estado 2 (Bit 1: Conexión PV)", type: "Bitfield" },
  { address: 32010, length: 1,  name: "Alarma 3 (Bit 6: Pérdida String)", type: "Bitfield" },
  { address: 37001, length: 2,  name: "Potencia de Batería (Carga/Desc)", type: "I32 (W)" },
  { address: 37004, length: 1,  name: "Nivel de Carga Batería (SOC)", type: "U16 / 10 (%)" }
] as const;

// ============================================================================
// INFLUXDB TELEMETRY CONFIGURATION
// ============================================================================

export const INFLUX_URL = process.env.INFLUX_URL || 'http://localhost:8086';
export const INFLUX_TOKEN = process.env.INFLUX_TOKEN || '';
export const INFLUX_ORG = process.env.INFLUX_ORG || 'huawei-dashboard';
export const INFLUX_BUCKET = process.env.INFLUX_BUCKET || 'telemetry';

// ============================================================================
// OCPP CHARGER CONFIGURATION
// ============================================================================

export const OCPP_HOST = process.env.OCPP_HOST ?? '0.0.0.0';
export const OCPP_PORT = Number(process.env.OCPP_PORT ?? 9100);
export const OCPP_PATH_PREFIX = process.env.OCPP_PATH_PREFIX ?? '/ocpp';
export const OCPP_HEARTBEAT_INTERVAL = Number(process.env.OCPP_HEARTBEAT_INTERVAL ?? 30);
export const OCPP_CONFIG_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

// Smart Charging Probe Configuration
export const OCPP_SMART_PROBE_ON_CONNECT = String(process.env.OCPP_SMART_PROBE_ON_CONNECT ?? '1').toLowerCase() !== '0';
export const OCPP_SMART_PROBE_DELAY_MS = Number(process.env.OCPP_SMART_PROBE_DELAY_MS ?? 1500);
export const OCPP_SMART_PROBE_STACK_LEVEL = Number(process.env.OCPP_SMART_PROBE_STACK_LEVEL ?? 2);
export const OCPP_SMART_PROBE_CP_MAX_AMPS = Number(process.env.OCPP_SMART_PROBE_CP_MAX_AMPS ?? 8);
export const OCPP_SMART_PROBE_TX_AMPS = Number(process.env.OCPP_SMART_PROBE_TX_AMPS ?? 10);
export const OCPP_SMART_PROBE_CP_MAX_WATTS = Number(process.env.OCPP_SMART_PROBE_CP_MAX_WATTS ?? 2000);
export const OCPP_SMART_PROBE_TX_WATTS = Number(process.env.OCPP_SMART_PROBE_TX_WATTS ?? 2300);
export const OCPP_SMART_PROBE_RATE_UNIT = String(process.env.OCPP_SMART_PROBE_RATE_UNIT ?? 'auto').toLowerCase();

// Stop Transaction Cooldown
export const STOP_OTHER_COOLDOWN_THRESHOLD = 3;
export const STOP_OTHER_COOLDOWN_MS = 60_000; // 1 minute

// ============================================================================
// SMART CHARGING CONFIGURATION (GREEN / HYBRID MODES)
// ============================================================================

export const GREEN_CONTROL_LOOP_MS = 30_000; // 30 seconds
export const GREEN_GRID_VOLTAGE = Number(process.env.GREEN_GRID_VOLTAGE ?? 230);
export const GREEN_MIN_CHARGING_AMPS = 6;
export const GREEN_MAX_CHARGING_AMPS = Number(process.env.GREEN_MAX_CHARGING_AMPS ?? 32);
export const GREEN_HYSTERESIS_WATTS = Number(process.env.GREEN_HYSTERESIS_WATTS ?? 200);

export const HYBRID_MIN_CHARGING_AMPS = Math.max(
  GREEN_MIN_CHARGING_AMPS,
  Math.min(GREEN_MAX_CHARGING_AMPS, Number(process.env.HYBRID_MIN_CHARGING_AMPS ?? 7)),
);

export const HYBRID_START_MIN_CHARGING_AMPS = Math.max(
  HYBRID_MIN_CHARGING_AMPS,
  Math.min(GREEN_MAX_CHARGING_AMPS, Number(process.env.HYBRID_START_MIN_CHARGING_AMPS ?? 8)),
);

// ============================================================================
// STORAGE PATHS
// ============================================================================

export const HISTORY_DIR = path.resolve(process.cwd(), 'storage/history');
export const LOGS_DIR = path.resolve(process.cwd(), 'storage/logs');
export const DATA_DIR = path.resolve(process.cwd(), 'storage/data');

export const CHARGER_STATE_FILE = path.resolve(DATA_DIR, 'charger-state.json');
export const LIVE_STATE_FILE = path.resolve(DATA_DIR, 'live-state.json');
export const STATE_FILE = LIVE_STATE_FILE; // For backward compatibility
export const CHARGER_STATE_TMP_FILE = `${CHARGER_STATE_FILE}.tmp`;

// ============================================================================
// LOGGING CONFIGURATION
// ============================================================================

export const MAX_LIVE_LOGS = 250;
export const MAX_COMBINED_LOG_SIZE_MB = 100;
export const MAX_COMBINED_LOG_SIZE_BYTES = MAX_COMBINED_LOG_SIZE_MB * 1024 * 1024;
export const SERVER_START_TIME = new Date();

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate critical configuration on module load
 */
export function validateConfiguration(): void {
  if (MODBUS_PORTS.length === 0) {
    throw new Error('No valid Modbus ports configured. Set MODBUS_PORT or MODBUS_PORTS.');
  }

  if (!Number.isInteger(OCPP_PORT) || OCPP_PORT < 1 || OCPP_PORT > 65535) {
    throw new Error('OCPP_PORT must be a valid TCP port (1-65535).');
  }
}

// ============================================================================
// TYPES
// ============================================================================

export type ChargingMode = 'FAST' | 'GREEN' | 'HYBRID';

export interface ModbusRegister {
  address: number;
  length: number;
  name: string;
  type: string;
}

export type RuntimeLogLevel = 'info' | 'warn' | 'error';

export interface RuntimeLogEntry {
  time: string;
  level: RuntimeLogLevel;
  source: string;
  message: string;
}

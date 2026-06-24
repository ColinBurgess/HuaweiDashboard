/**
 * OCPP 1.6 Charger Service
 * Handles EV charger communication via OCPP 1.6 WebSocket protocol
 * Manages smart charging policies (GREEN, HYBRID, FAST modes)
 * Runs in: monolith mode or 'charger' service role
 */

import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  OCPP_HOST,
  OCPP_PORT,
  OCPP_PATH_PREFIX,
  OCPP_HEARTBEAT_INTERVAL,
  OCPP_CONFIG_DEBOUNCE_MS,
  OCPP_SMART_CHARGING_ENABLED,
  OCPP_DEBUG_API,
  OCPP_SMART_PROBE_ON_CONNECT,
  OCPP_SMART_PROBE_DELAY_MS,
  OCPP_SMART_PROBE_STACK_LEVEL,
  OCPP_SMART_PROBE_CP_MAX_AMPS,
  OCPP_SMART_PROBE_TX_AMPS,
  OCPP_SMART_PROBE_CP_MAX_WATTS,
  OCPP_SMART_PROBE_TX_WATTS,
  OCPP_SMART_PROBE_RATE_UNIT,
  GREEN_CONTROL_LOOP_MS,
  GREEN_GRID_VOLTAGE,
  GREEN_MIN_CHARGING_AMPS,
  GREEN_MAX_CHARGING_AMPS,
  GREEN_HYSTERESIS_WATTS,
  HYBRID_MIN_CHARGING_AMPS,
  HYBRID_START_MIN_CHARGING_AMPS,
} from '../config/constants.js';
import {
  chargerState,
  inverterData,
  ChargingMode,
  OcppCall,
  OcppCallResult,
  OcppCallError,
  saveLiveState,
  loadLiveState,
  persistChargerStateIfChanged,
  restorePersistedChargerState,
} from '../ipc/state-manager.js';

// ============================================================================
// OCPP SERVER INITIALIZATION
// ============================================================================

const isCharger = process.env.SERVICE_ROLE === 'charger' || process.env.START_MONOLITH === 'true';

/**
 * HTTP server for OCPP WebSocket endpoint
 * Only initialized if running as charger or monolith
 */
const ocppHttpServer = isCharger ? createServer((req, res) => {
  // Optional debug endpoint to forward arbitrary OCPP calls to the charger.
  // Gated behind OCPP_DEBUG_API for security (full charger control).
  if (OCPP_DEBUG_API && req.method === 'POST' && req.url === '/debug/ocpp') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // Guard against oversized payloads (basic DoS protection).
      if (body.length > 64 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const action = String(parsed.action ?? '').trim();
        const payload = parsed.payload ?? {};
        if (!action) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "action" field.' }));
          return;
        }
        if (!chargerWs || chargerWs.readyState !== chargerWs.OPEN) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No charger connected.' }));
          return;
        }
        const chargePointId = chargerState.chargePointId ?? 'UNKNOWN';
        const callId = sendOcppCall(chargerWs, chargePointId, action, payload, 'debug-api');
        res.writeHead(callId ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: callId ? 'sent' : 'failed',
          callId: callId ?? null,
          chargePointId,
          action,
          note: 'Charger response is logged asynchronously (check service logs).',
        }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Use WebSocket OCPP endpoint.' }));
}) : null;

/**
 * WebSocket server for OCPP 1.6 protocol
 * Only initialized if HTTP server exists
 */
const ocppWss = ocppHttpServer ? new WebSocketServer({
  server: ocppHttpServer,
  handleProtocols: (protocols) => {
    if (protocols.has('ocpp1.6')) {
      return 'ocpp1.6';
    }
    return false;
  },
}) : null;

// ============================================================================
// CHARGER STATE TRACKING
// ============================================================================

/**
 * Active charger WebSocket connection
 * Only one active connection allowed at a time
 */
let chargerWs: WebSocket | null = null;

/**
 * Flag indicating an API stop request is pending
 * Used to distinguish between API-initiated stops and charger-initiated stops
 */
let pendingApiStopRequest = false;

// Cooldown mechanism for consecutive "Other" stop reasons
const STOP_OTHER_COOLDOWN_THRESHOLD = 3;
const STOP_OTHER_COOLDOWN_MS = 60_000;
let consecutiveStopReasonOtherCount = 0;
let stopReasonOtherCooldownUntil = 0;

// ============================================================================
// OCPP MESSAGE TRACKING
// ============================================================================

let callIdCounter = 0;
function generateCallId(): string {
  return String(++callIdCounter);
}

type PendingOcppCall = {
  action: string;
  note?: string;
  sentAt: number;
};

const pendingOcppCallsByChargePoint = new Map<string, Map<string, PendingOcppCall>>();
const lastOcppConfigAtByChargePoint = new Map<string, number>();

let transactionIdCounter = 0;
function generateTransactionId(): number {
  return ++transactionIdCounter;
}

// ============================================================================
// PAYLOAD SANITIZATION
// ============================================================================

/**
 * Sanitize OCPP payloads for safe logging
 * Handles invalid/malformed timestamps that may come from charger after power loss
 * (Huawei SCharger loses RTC, reports timestamp with timezone misalignment)
 *
 * After power loss, charger reports SecurityEventNotification with incorrectly formatted
 * timestamp (e.g. "17:11:31.000Z" for local time in UTC+2). This causes "Invalid Date"
 * when serialized. This function replaces invalid timestamps with server's current time.
 */
function sanitizePayloadForLogging(payload: any): any {
  try {
    // Use JSON replacer to safely handle invalid Dates
    const sanitized = JSON.parse(JSON.stringify(payload, (_key, value) => {
      // If value is a Date object and it's invalid, replace with current time
      if (value instanceof Date && isNaN(value.getTime())) {
        return new Date().toISOString();
      }
      // If value is a string that looks like a timestamp but is invalid, replace it
      if (typeof value === 'string' && /^\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(value)) {
        try {
          const parsed = new Date(value);
          if (isNaN(parsed.getTime())) {
            // Invalid ISO-like timestamp, replace with current time
            return new Date().toISOString();
          }
        } catch {
          return new Date().toISOString();
        }
      }
      return value;
    }));
    return sanitized;
  } catch (err) {
    // If anything fails, return the original payload
    return payload;
  }
}

// ============================================================================
// OCPP CALL MANAGEMENT
// ============================================================================

function rememberPendingOcppCall(chargePointId: string, uniqueId: string, action: string, note?: string): void {
  const map = pendingOcppCallsByChargePoint.get(chargePointId) ?? new Map<string, PendingOcppCall>();
  map.set(uniqueId, {
    action,
    note,
    sentAt: Date.now(),
  });
  pendingOcppCallsByChargePoint.set(chargePointId, map);
}

function consumePendingOcppCall(chargePointId: string, uniqueId: string): PendingOcppCall | undefined {
  const map = pendingOcppCallsByChargePoint.get(chargePointId);
  if (!map) return undefined;

  const pending = map.get(uniqueId);
  if (!pending) return undefined;

  map.delete(uniqueId);
  if (map.size === 0) {
    pendingOcppCallsByChargePoint.delete(chargePointId);
  }
  return pending;
}

function sendOcppCall(
  ws: WebSocket,
  chargePointId: string,
  action: string,
  payload: Record<string, any>,
  note?: string,
): string | undefined {
  if (ws.readyState !== ws.OPEN) {
    return undefined;
  }
  const uniqueId = generateCallId();
  const frame: OcppCall = [2, uniqueId, action, payload];
  ws.send(JSON.stringify(frame));
  rememberPendingOcppCall(chargePointId, uniqueId, action, note);
  console.log(`[${chargePointId}] → ${action}${note ? ` (${note})` : ''} [id=${uniqueId}]`);
  return uniqueId;
}

// ============================================================================
// OCPP CONFIGURATION & HELPERS
// ============================================================================

interface OcppConfigurationKey {
  key: string;
  readonly: boolean;
  value?: string;
}

interface GetConfigurationResult {
  configurationKey: OcppConfigurationKey[];
  unknownKey?: string[];
}

const chargingScheduleRateUnitByChargePoint = new Map<string, 'A' | 'W'>();

/**
 * Normalize a charging rate unit from various string formats
 * Supports: 'A', 'Amp', 'Amps', 'Current', 'W', 'Watt', 'Watts', 'Power'
 */
function normalizeChargingRateUnit(rawValue?: string): 'A' | 'W' | undefined {
  const value = String(rawValue ?? '').trim().toLowerCase();
  if (!value) return undefined;

  if (value === 'a' || value === 'amp' || value === 'amps' || value === 'current') {
    return 'A';
  }
  if (value === 'w' || value === 'watt' || value === 'watts' || value === 'power') {
    return 'W';
  }
  if (value.includes('power')) return 'W';
  if (value.includes('current') || value.includes('amp')) return 'A';
  return undefined;
}

/**
 * Get the preferred charging rate unit for a charger
 * Priority: env config > charger reported config > default (Amps)
 *
 * CHARGER-SPECIFIC NOTES:
 * - CP001 (wallbox charger): ChargingScheduleAllowedChargingRateUnit = 'Power'
 *   Always returns 'W' for this charger. Do NOT use 'A' (Amps) as the rate unit.
 * - CP001 also reports: ConnectorSwitch3to1PhaseSupported = false
 *   This means dynamic phase switching is NOT available, limiting solar load-balancing options.
 */
function getPreferredProbeRateUnit(chargePointId: string): 'A' | 'W' {
  if (OCPP_SMART_PROBE_RATE_UNIT === 'w' || OCPP_SMART_PROBE_RATE_UNIT === 'power') {
    return 'W';
  }
  if (OCPP_SMART_PROBE_RATE_UNIT === 'a' || OCPP_SMART_PROBE_RATE_UNIT === 'current') {
    return 'A';
  }
  return chargingScheduleRateUnitByChargePoint.get(chargePointId) ?? 'A';
}

/**
 * Log GetConfiguration response from charger
 * Updates cached charging rate unit based on charger capabilities
 */
function logGetConfigurationResult(chargePointId: string, result: GetConfigurationResult): void {
  const keys = result.configurationKey;
  console.log(`[${chargePointId}] [CONFIG] GetConfiguration → ${keys.length} key(s) reported by charger:`);
  for (const entry of keys) {
    const ro = entry.readonly ? ' [readonly]' : '';
    console.log(`[${chargePointId}] [CONFIG]   ${entry.key}${ro} = ${entry.value ?? '<unset>'}`);

    if (entry.key === 'ChargingScheduleAllowedChargingRateUnit') {
      const units = String(entry.value ?? '')
        .split(',')
        .map((part) => normalizeChargingRateUnit(part))
        .filter((part): part is 'A' | 'W' => part !== undefined);

      if (units.includes('W')) {
        chargingScheduleRateUnitByChargePoint.set(chargePointId, 'W');
      } else if (units.includes('A')) {
        chargingScheduleRateUnitByChargePoint.set(chargePointId, 'A');
      }
      const preferred = getPreferredProbeRateUnit(chargePointId);
      console.log(
        `[${chargePointId}] [CONFIG]   Effective probe unit=${preferred} (env=${OCPP_SMART_PROBE_RATE_UNIT}, reported=${entry.value ?? '<unset>'})`,
      );
    }
  }
  if (result.unknownKey && result.unknownKey.length > 0) {
    console.log(`[${chargePointId}] [CONFIG]   Unknown keys requested: ${result.unknownKey.join(', ')}`);
  }
}

// ============================================================================
// SMART CHARGING PROBE
// ============================================================================

const SMART_CHARGING_CONFIG_KEYS = [
  'SupportedFeatureProfiles',  // Verify if charger supports Smart Charging via profile array
  'ChargeProfileMaxStackLevel',  // OCPP 1.6 standard key (correct spelling: no 'ing')
  'ChargingScheduleAllowedChargingRateUnit',  // Determine if charger uses 'A' or 'W' for limits
  'ChargingScheduleMaxPeriods',  // Maximum number of charging periods per schedule
  'MaxChargingProfilesInstalled',  // Maximum number of profiles charger can store
  'ConnectorSwitch3to1PhaseSupported',  // Check if charger supports dynamic phase switching
];

function requestSmartChargingConfiguration(ws: WebSocket, chargePointId: string): void {
  sendOcppCall(
    ws,
    chargePointId,
    'GetConfiguration',
    { key: SMART_CHARGING_CONFIG_KEYS },
    'smart-charging capability keys',
  );
}

/**
 * Send a charging profile probe to charger
 * Used to discover and test charger's smart charging capabilities
 */
function sendSetChargingProfileProbe(
  ws: WebSocket,
  chargePointId: string,
  profilePurpose: 'ChargePointMaxProfile' | 'TxDefaultProfile' | 'TxProfile',
  targetAmps: number,
  targetWatts: number,
  stackLevel: number,
  transactionId?: number,
): void {
  const profileId = Math.floor(Date.now() % 1_000_000);
  const sanitizedStackLevel = Math.max(0, Math.min(999, Math.round(stackLevel)));
  const preferredRateUnit = getPreferredProbeRateUnit(chargePointId);

  // CRITICAL: ChargingRateUnit MUST match charger's ChargingScheduleAllowedChargingRateUnit
  // CP001 requires "W" (Watts), not "A" (Amps). Using wrong unit will cause profile rejection.
  const minWatts = Math.round(GREEN_MIN_CHARGING_AMPS * GREEN_GRID_VOLTAGE);
  const maxWatts = Math.round(GREEN_MAX_CHARGING_AMPS * GREEN_GRID_VOLTAGE);
  const sanitizedLimitA = Math.max(GREEN_MIN_CHARGING_AMPS, Math.min(GREEN_MAX_CHARGING_AMPS, Math.round(targetAmps)));
  const sanitizedLimitW = Math.max(minWatts, Math.min(maxWatts, Math.round(targetWatts)));
  const limitValue = preferredRateUnit === 'W' ? sanitizedLimitW : sanitizedLimitA;

  const payload: Record<string, any> = {
    connectorId: profilePurpose === 'ChargePointMaxProfile' ? 0 : 1,
    csChargingProfiles: {
      chargingProfileId: profileId,
      stackLevel: sanitizedStackLevel,
      chargingProfilePurpose: profilePurpose,
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        chargingRateUnit: preferredRateUnit,
        chargingSchedulePeriod: [
          {
            startPeriod: 0,
            limit: limitValue,
          },
        ],
      },
    },
  };

  if (profilePurpose === 'TxProfile' && transactionId !== undefined) {
    payload.csChargingProfiles.transactionId = transactionId;
  }

  const detail =
    profilePurpose === 'TxProfile'
      ? `probe ${profilePurpose} limit=${limitValue}${preferredRateUnit} stack=${sanitizedStackLevel} txId=${transactionId ?? 'none'}`
      : `probe ${profilePurpose} limit=${limitValue}${preferredRateUnit} stack=${sanitizedStackLevel}`;

  sendOcppCall(ws, chargePointId, 'SetChargingProfile', payload, detail);
}

/**
 * Run smart charging capability probe
 * Called on connection to discover charger's supported features
 */
function runSmartChargingProbe(ws: WebSocket, chargePointId: string, trigger: string): void {
  console.log(`[${chargePointId}] [PROBE] Running smart-charging probe (trigger=${trigger})`);
  requestSmartChargingConfiguration(ws, chargePointId);
  sendSetChargingProfileProbe(
    ws,
    chargePointId,
    'ChargePointMaxProfile',
    OCPP_SMART_PROBE_CP_MAX_AMPS,
    OCPP_SMART_PROBE_CP_MAX_WATTS,
    OCPP_SMART_PROBE_STACK_LEVEL,
  );

  if (chargerState.transactionId !== undefined) {
    sendSetChargingProfileProbe(
      ws,
      chargePointId,
      'TxProfile',
      OCPP_SMART_PROBE_TX_AMPS,
      OCPP_SMART_PROBE_TX_WATTS,
      1,
      chargerState.transactionId,
    );
  } else {
    console.log(`[${chargePointId}] [PROBE] TxProfile probe skipped (no active transactionId yet)`);
  }
}

/**
 * Configure charger telemetry settings (meter sampling)
 * Uses debouncing to avoid excessive configuration changes
 */
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

// ============================================================================
// CHARGER CONTROL ACTIONS
// ============================================================================

/**
 * Check if charger is ready to receive commands
 * Dashboard role only checks if ws is defined (no direct control)
 * Charger role requires active WebSocket connection
 */
function canSendToCharger(): boolean {
  const isDashboardRole = process.env.SERVICE_ROLE === 'dashboard';
  if (isDashboardRole) return true;
  return Boolean(chargerWs && chargerWs.readyState === (chargerWs.OPEN ?? 1));
}

/**
 * Send RemoteStartTransaction to charger
 * Initiates a charging transaction
 */
function sendRemoteStartTransaction(targetAmpsForProfile?: number): boolean {
  if (!canSendToCharger() || !chargerWs) {
    return false;
  }

  const payload: Record<string, any> = {
    connectorId: 1,
    idTag: 'Dashboard',
  };

  // If charging amps are provided and smart charging is enabled, embed the profile
  // directly in the RemoteStartTransaction to avoid back-to-back OCPP messages.
  // This is the standard OCPP 1.6 pattern for atomic profile + start operations.
  if (targetAmpsForProfile !== undefined && OCPP_SMART_CHARGING_ENABLED) {
    const chargePointId = chargerState.chargePointId || 'CP?';
    const preferredRateUnit = getPreferredProbeRateUnit(chargePointId);
    const limitValue =
      preferredRateUnit === 'W'
        ? Math.round(targetAmpsForProfile * GREEN_GRID_VOLTAGE)
        : Math.round(targetAmpsForProfile);

    payload.chargingProfile = {
      chargingProfileId: 100,
      stackLevel: 1,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        chargingRateUnit: preferredRateUnit,
        chargingSchedulePeriod: [
          {
            startPeriod: 0,
            limit: limitValue,
          },
        ],
      },
    };
  }

  sendOcppCall(chargerWs, chargerState.chargePointId || 'CP?', 'RemoteStartTransaction', payload);
  chargerState.lastUpdate = new Date().toISOString();
  emitCombinedData();
  console.log('[API] → RemoteStartTransaction');
  return true;
}

/**
 * Send RemoteStopTransaction to charger
 * Terminates current charging transaction
 */
function sendRemoteStopTransaction(): boolean {
  if (!canSendToCharger() || !chargerWs) {
    return false;
  }
  const txId = chargerState.transactionId ?? 0;
  sendOcppCall(chargerWs, chargerState.chargePointId || 'CP?', 'RemoteStopTransaction', { transactionId: txId });
  chargerState.lastUpdate = new Date().toISOString();
  emitCombinedData();
  console.log(`[API] → RemoteStopTransaction txId=${txId}`);
  return true;
}

/**
 * Send charging limit (SetChargingProfile) to charger
 * Sets the maximum current/power for the charging transaction
 *
 * DESIGN NOTES:
 * - The ChargingRateUnit MUST match the charger's ChargingScheduleAllowedChargingRateUnit config
 * - CP001 requires "W" (Watts/Power) not "A" (Amps) as the limiting unit
 * - If charger ever returns different ChargingScheduleAllowedChargingRateUnit, update getPreferredProbeRateUnit()
 * - ConnectorSwitch3to1PhaseSupported indicates if dynamic phase-switching is available for load-balancing
 *   CP001 has this disabled (false), so phase count optimization is not possible for this charger
 */
function sendChargingLimit(amps: number): boolean {
  if (!OCPP_SMART_CHARGING_ENABLED) {
    // Original pre-refactor behaviour: no SetChargingProfile, charger uses its own default limit
    return false;
  }
  if (!canSendToCharger() || !chargerWs) {
    return false;
  }
  const chargePointId = chargerState.chargePointId || 'CP?';
  const sanitizedAmps = Math.max(
    GREEN_MIN_CHARGING_AMPS,
    Math.min(GREEN_MAX_CHARGING_AMPS, Math.round(amps)),
  );

  const preferredRateUnit = getPreferredProbeRateUnit(chargePointId);
  const limitValue = preferredRateUnit === 'W' ? Math.round(sanitizedAmps * GREEN_GRID_VOLTAGE) : sanitizedAmps;

  const payload = {
    connectorId: 1,
    csChargingProfiles: {
      chargingProfileId: 100,
      stackLevel: 1,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        chargingRateUnit: preferredRateUnit,
        chargingSchedulePeriod: [
          {
            startPeriod: 0,
            limit: limitValue,
            numberPhases: preferredRateUnit === 'W' ? undefined : 1,
          },
        ],
      },
    },
  };

  sendOcppCall(
    chargerWs,
    chargePointId,
    'SetChargingProfile',
    payload,
    `smart policy TxDefaultProfile limit=${limitValue}${preferredRateUnit}`,
  );
  chargerState.lastRequestedCurrentLimitA = sanitizedAmps;
  chargerState.appliedCurrentLimitA = sanitizedAmps;
  chargerState.lastUpdate = new Date().toISOString();
  emitCombinedData();
  console.log(`[SMART] → SetChargingProfile TxDefaultProfile limit=${sanitizedAmps}A (sent=${limitValue}${preferredRateUnit})`);
  return true;
}

/**
 * Clear charging limit (remove TxDefaultProfile)
 * Allows charger to charge at maximum configured limits
 */
function clearChargingLimit(): boolean {
  if (!canSendToCharger() || !chargerWs) {
    return false;
  }
  const payload = {
    id: 100,  // CRITICAL: Huawei parser requires this field; omitting causes C++ parser crash
    connectorId: 1,
    chargingProfilePurpose: 'TxDefaultProfile',
    stackLevel: 1,
  };
  sendOcppCall(
    chargerWs,
    chargerState.chargePointId || 'CP?',
    'ClearChargingProfile',
    payload,
    'clear TxDefaultProfile',
  );
  chargerState.lastRequestedCurrentLimitA = undefined;
  chargerState.appliedCurrentLimitA = undefined;
  chargerState.lastUpdate = new Date().toISOString();
  emitCombinedData();
  console.log('[SMART] → ClearChargingProfile TxDefaultProfile');
  return true;
}

// ============================================================================
// SMART CHARGING POLICIES
// ============================================================================

/**
 * GREEN charging policy
 * Charges only when solar surplus exceeds minimum threshold
 * Dynamically adjusts based on available solar power
 */
function applyGreenChargingPolicy(): void {
  if (chargerState.chargingMode !== 'GREEN') return;
  if (!chargerState.startRequested) return;
  if (!canSendToCharger()) return;

  const gridNetW = inverterData.gridPower;
  const chargerPowerW = Math.max(0, chargerState.powerW);
  const surplusW = gridNetW + chargerPowerW;

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
  const targetWatts = Math.round(boundedTargetAmps * GREEN_GRID_VOLTAGE);
  const lastSentWatts = lastSent !== undefined ? Math.round(lastSent * GREEN_GRID_VOLTAGE) : null;
  const diffWatts = lastSentWatts !== null ? Math.abs(targetWatts - lastSentWatts) : null;
  const shouldUpdateLimit = lastSent === undefined || (diffWatts !== null && diffWatts > GREEN_HYSTERESIS_WATTS);
  console.log(`[GREEN] cycle: gridNet=${gridNetW}W chargerPower=${chargerPowerW}W surplus=${surplusW}W rawTarget=${rawTargetAmps.toFixed(2)}A bounded=${boundedTargetAmps}A target=${targetWatts}W lastSent=${lastSent ?? 'none'}A lastSentW=${lastSentWatts ?? 'none'} diffW=${diffWatts ?? 'n/a'} thresholdW=${GREEN_HYSTERESIS_WATTS} willUpdate=${shouldUpdateLimit}`);

  if (chargerState.status !== 'Charging') {
    // If we need to start charging, embed the profile directly in RemoteStartTransaction.
    // This avoids back-to-back OCPP messages that would cause buffer overflow in the charger.
    sendRemoteStartTransaction(shouldUpdateLimit ? boundedTargetAmps : undefined);
    if (shouldUpdateLimit) {
      chargerState.lastRequestedCurrentLimitA = boundedTargetAmps;
    }
  } else if (shouldUpdateLimit) {
    // If already charging, send SetChargingProfile as a separate update.
    sendChargingLimit(boundedTargetAmps);
    chargerState.lastRequestedCurrentLimitA = boundedTargetAmps;
  }
}

/**
 * HYBRID charging policy
 * Charges with a minimum baseline even when solar surplus is insufficient
 * Accepts grid power if solar is unavailable
 */
function applyHybridChargingPolicy(): void {
  if (chargerState.chargingMode !== 'HYBRID') return;
  if (!chargerState.startRequested) return;
  if (!canSendToCharger()) return;

  // DEBUG: Log inverterData state to diagnose why gridPower might be 0 or undefined
  if (!inverterData.connected) {
    console.warn('[HYBRID-DEBUG] ⚠️ Inverter not connected, gridPower cannot be read');
  }
  if (inverterData.gridPower === undefined || inverterData.gridPower === null) {
    console.warn('[HYBRID-DEBUG] ⚠️ gridPower is undefined/null. inputPower=' + inverterData.inputPower + ' activePower=' + inverterData.activePower);
  }

  const gridNetW = inverterData.gridPower;
  const chargerPowerW = Math.max(0, chargerState.powerW);
  const surplusW = gridNetW + chargerPowerW;
  const rawTargetAmps = surplusW / GREEN_GRID_VOLTAGE;

  const isStartingSession = chargerState.status !== 'Charging' || chargerPowerW === 0;
  const minimumHybridAmps = isStartingSession
    ? HYBRID_START_MIN_CHARGING_AMPS
    : HYBRID_MIN_CHARGING_AMPS;

  const boundedTargetAmps = Math.max(
    minimumHybridAmps,
    Math.min(GREEN_MAX_CHARGING_AMPS, Math.floor(rawTargetAmps)),
  );

  const lastSent = chargerState.lastRequestedCurrentLimitA;
  const targetWatts = Math.round(boundedTargetAmps * GREEN_GRID_VOLTAGE);
  const lastSentWatts = lastSent !== undefined ? Math.round(lastSent * GREEN_GRID_VOLTAGE) : null;
  const diffWatts = lastSentWatts !== null ? Math.abs(targetWatts - lastSentWatts) : null;
  const shouldUpdateLimit = lastSent === undefined || (diffWatts !== null && diffWatts > GREEN_HYSTERESIS_WATTS);
  console.log(`[HYBRID] cycle: gridNet=${gridNetW}W chargerPower=${chargerPowerW}W surplus=${surplusW}W rawTarget=${rawTargetAmps.toFixed(2)}A min=${minimumHybridAmps}A bounded=${boundedTargetAmps}A target=${targetWatts}W lastSent=${lastSent ?? 'none'}A lastSentW=${lastSentWatts ?? 'none'} diffW=${diffWatts ?? 'n/a'} thresholdW=${GREEN_HYSTERESIS_WATTS} willUpdate=${shouldUpdateLimit}`);

  if (chargerState.status !== 'Charging') {
    // If we need to start charging, embed the profile directly in RemoteStartTransaction.
    // This avoids back-to-back OCPP messages that would cause buffer overflow in the charger.
    console.log(`[HYBRID-FLOW] Starting transaction with profile embedded (targetAmps=${shouldUpdateLimit ? boundedTargetAmps : 'none'})`);
    sendRemoteStartTransaction(shouldUpdateLimit ? boundedTargetAmps : undefined);
    if (shouldUpdateLimit) {
      chargerState.lastRequestedCurrentLimitA = boundedTargetAmps;
    }
  } else if (shouldUpdateLimit) {
    // If already charging, send SetChargingProfile as a separate update.
    sendChargingLimit(boundedTargetAmps);
    chargerState.lastRequestedCurrentLimitA = boundedTargetAmps;
  }
}

/**
 * Apply smart charging policy based on current mode
 * Routes to GREEN or HYBRID implementations
 */
function applySmartChargingPolicy(): void {
  if (chargerState.chargingMode === 'GREEN') {
    applyGreenChargingPolicy();
    return;
  }
  if (chargerState.chargingMode === 'HYBRID') {
    applyHybridChargingPolicy();
  }
}

// ============================================================================
// STATE SYNCHRONIZATION & RECONCILIATION
// ============================================================================

/**
 * Sync charger state into inverter data object
 * Ensures charger fields are available in shared inverterData
 */
function syncChargerIntoInverterData() {
  const role = process.env.SERVICE_ROLE || 'monolith';
  const isMonolith = process.env.START_MONOLITH === 'true' || role === 'monolith';
  const isChargerRole = role === 'charger';
  const isDashboardRole = role === 'dashboard';

  if (isMonolith || isChargerRole) {
    inverterData.carChargePower = Math.max(0, chargerState.powerW);
    inverterData.chargerConnected = chargerState.connected;
    inverterData.chargerCableConnected = chargerState.cableConnected;
    inverterData.chargerStatus = chargerState.status;
    inverterData.chargePointId = chargerState.chargePointId;
    inverterData.chargerLastUpdate = chargerState.lastUpdate;
    inverterData.chargerCurrentLimitA = chargerState.appliedCurrentLimitA ?? null;
  }

  if (isMonolith || isDashboardRole) {
    inverterData.chargingMode = chargerState.chargingMode;
    inverterData.chargerStartRequested = chargerState.startRequested;
  }
}

/**
 * Emit combined data to all listeners
 * Syncs state, persists if needed, emits to Socket.io, saves to disk
 */
function emitCombinedData() {
  const role = process.env.SERVICE_ROLE || 'monolith';
  const isMonolithLocal = process.env.START_MONOLITH === 'true' || (!process.env.SERVICE_ROLE && process.argv[1].endsWith('server.ts')) || (!process.env.SERVICE_ROLE && process.argv[1].endsWith('server.js'));
  const isChargerRole = role === 'charger';
  const isDashboardRole = role === 'dashboard';

  if (isMonolithLocal || isChargerRole || isDashboardRole) {
    syncChargerIntoInverterData();
    if (isMonolithLocal || isChargerRole) {
      persistChargerStateIfChanged();
    }
  }

  // In modular mode, save to disk
  if (!isMonolithLocal) {
    saveLiveState();
  }
}

/**
 * Update service health heartbeat
 * Sends status information to dashboard
 */
function updateServiceHeartbeat(status = 'OK', details?: string) {
  const role = process.env.SERVICE_ROLE || 'monolith';
  inverterData.services[role] = {
    lastHeartbeat: new Date().toISOString(),
    status,
    details
  };
  emitCombinedData();
}

/**
 * Reconcile charger control state with current mode/commands
 * Ensures charger actions match the desired mode (FAST/GREEN/HYBRID)
 * Handles cooldown after consecutive "Other" stop reasons
 */
function reconcileChargerControlState(trigger: string): void {
  const isChargerRole = process.env.SERVICE_ROLE === 'charger';
  const isMonolithLocal = process.env.START_MONOLITH === 'true';
  const isOperational = isChargerRole || isMonolithLocal;

  console.log(
    `[RECON] trigger=${trigger} mode=${chargerState.chargingMode} startRequested=${chargerState.startRequested} connected=${chargerState.connected} status=${chargerState.status} appliedLimitA=${chargerState.appliedCurrentLimitA ?? 'none'} txId=${chargerState.transactionId ?? 'none'}`,
  );

  if (!chargerState.startRequested) {
    if (isOperational && (chargerState.status === 'Charging' || chargerState.status === 'SuspendedEV' || chargerState.status === 'SuspendedEVSE')) {
      console.log('[RECON] Stop requested but charger is active — sending RemoteStopTransaction');
      sendRemoteStopTransaction();
    } else {
      console.log('[RECON] No start requested, reconciliation completed without action');
    }
    return;
  }

  if (Date.now() < stopReasonOtherCooldownUntil) {
    const remainingSecs = Math.ceil((stopReasonOtherCooldownUntil - Date.now()) / 1000);
    console.log(`[RECON] Cooldown active (${remainingSecs}s remaining after ${consecutiveStopReasonOtherCount} consecutive reason=Other stops) – skipping re-arm`);
    return;
  } else if (stopReasonOtherCooldownUntil > 0) {
    console.log(`[RECON] Cooldown expired after ${consecutiveStopReasonOtherCount} consecutive reason=Other stops — resetting counter and retrying`);
    consecutiveStopReasonOtherCount = 0;
    stopReasonOtherCooldownUntil = 0;
  }

  if (!canSendToCharger()) {
    console.log('[RECON] Command armed but charger socket is not ready yet');
    return;
  }

  if (chargerState.status === 'Unavailable') {
    console.log('[RECON] Charger is Unavailable (controlled externally) — skipping control logic');
    return;
  }

  if (chargerState.chargingMode === 'FAST') {
    if (chargerState.status !== 'Charging') {
      console.log('[RECON] FAST mode start — sending max limit and start command');
      sendChargingLimit(GREEN_MAX_CHARGING_AMPS);
      sendRemoteStartTransaction();
    } else {
      console.log('[RECON] FAST mode active and charging, ensuring max limit');
      if (chargerState.appliedCurrentLimitA !== GREEN_MAX_CHARGING_AMPS) {
        sendChargingLimit(GREEN_MAX_CHARGING_AMPS);
      }
    }
    return;
  }

  console.log(`[RECON] Applying smart policy for mode=${chargerState.chargingMode}`);
  applySmartChargingPolicy();
}

// ============================================================================
// OCPP MESSAGE HANDLING
// ============================================================================

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

/**
 * Parse meter power from MeterValues payload
 * Extracts power in Watts from various meter value formats
 */
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

/**
 * Infer cable connection status from charger status string
 * Maps OCPP status values to cable connection state
 */
function inferCableConnectedFromStatus(statusRaw: unknown): boolean | undefined {
  const status = String(statusRaw ?? '').toLowerCase();
  if (status === 'available') {
    return false;
  }
  if (
    status === 'preparing'
    || status === 'charging'
    || status === 'suspendedev'
    || status === 'suspendedevse'
    || status === 'finishing'
  ) {
    return true;
  }
  return undefined;
}

/**
 * Handle OCPP Call messages from charger
 * Processes all OCPP 1.6 actions
 */
function handleOcppCall(
  ws: WebSocket,
  chargePointId: string,
  frame: OcppCall,
) {
  const [, uniqueId, action, payload] = frame;

  // Only log important events, not routine heartbeats
  const importantActions = ['BootNotification', 'StatusNotification', 'Authorize', 'StartTransaction', 'StopTransaction', 'MeterValues'];
  if (importantActions.includes(action)) {
    console.log(`[${chargePointId}] OCPP Call: ${action}`);
  }

  switch (action) {
    case 'BootNotification':
      chargerState.connected = true;
      chargerState.cableConnected = false;
      chargerState.chargePointId = chargePointId;
      chargerState.status = 'Available';
      chargerState.lastUpdate = new Date().toISOString();
      ws.send(JSON.stringify(buildCallResult(uniqueId, {
        currentTime: new Date().toISOString(),
        interval: OCPP_HEARTBEAT_INTERVAL,
        status: 'Accepted',
      })));
      emitCombinedData();
      console.log(`[${chargePointId}] BootNotification accepted`, sanitizePayloadForLogging(payload));
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

    case 'StatusNotification': {
      const previousStatus = chargerState.status;
      chargerState.connected = true;
      chargerState.chargePointId = chargePointId;

      if ((payload.connectorId ?? 1) >= 1) {
        chargerState.status = String(payload.status ?? chargerState.status ?? 'Unknown');
        const inferredCableConnected = inferCableConnectedFromStatus(payload.status);
        if (inferredCableConnected !== undefined) {
          chargerState.cableConnected = inferredCableConnected;
        }
        // Only clear transactionId when the charger is explicitly available or faulted.
        // States like Preparing, SuspendedEVSE, etc. are intermediate states where the
        // transaction remains active. Clearing transactionId in those states causes loss
        // of reference and prevents proper charge control logic.
        if (chargerState.status === 'Available' || chargerState.status === 'Faulted') {
          chargerState.powerW = 0;
          chargerState.transactionId = undefined;
        }
      }
      chargerState.lastUpdate = new Date().toISOString();
      ws.send(JSON.stringify(buildCallResult(uniqueId, {})));
      emitCombinedData();
      console.log(`[${chargePointId}] StatusNotification`, sanitizePayloadForLogging(payload));

      if (previousStatus === 'Unavailable' && chargerState.status !== 'Unavailable' && chargerState.startRequested) {
        console.log(`[${chargePointId}] Charger recovered from Unavailable → triggering reconciliation`);
        reconcileChargerControlState('UnavailableRecovered');
      }
      return;
    }
    case 'MeterValues': {
      const power = parseMeterPower(payload);
      const oldPowerW = chargerState.powerW;
      if (Number.isFinite(power)) {
        chargerState.powerW = Math.max(0, Number(power));
      }
      if (payload.transactionId !== undefined && payload.transactionId !== null) {
        chargerState.transactionId = Number(payload.transactionId);
      }
      if (chargerState.powerW > 0) {
        chargerState.cableConnected = true;
        chargerState.status = 'Charging';
      } else if (chargerState.transactionId !== undefined) {
        chargerState.cableConnected = true;
        if (chargerState.status === 'Disconnected' || chargerState.status === 'Available') {
          chargerState.status = 'Preparing';
        }
      }
      chargerState.connected = true;
      chargerState.chargePointId = chargePointId;
      chargerState.lastUpdate = new Date().toISOString();
      ws.send(JSON.stringify(buildCallResult(uniqueId, {})));
      emitCombinedData();
      // Always log in HYBRID mode to debug power flow issues
      if (chargerState.chargingMode === 'HYBRID' || !Number.isFinite(power)) {
        console.log(`[${chargePointId}] [HYBRID-METER] MeterValues: powerW=${chargerState.powerW}W (was ${oldPowerW}W), status=${chargerState.status}, txId=${chargerState.transactionId}`);
      }
      if (!Number.isFinite(power)) {
        console.warn(`[${chargePointId}] MeterValues received but power parsing failed. Payload: ${JSON.stringify(payload).substring(0, 200)}`);
      }
      return;
    }

    case 'StartTransaction':
      chargerState.connected = true;
      chargerState.cableConnected = true;
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
      console.log(`[${chargePointId}] StartTransaction accepted, assigned txId=${chargerState.transactionId}`, sanitizePayloadForLogging(payload));
      if (chargerState.chargingMode === 'HYBRID') {
        console.log(`[${chargePointId}] [HYBRID-START] Transaction started. Awaiting MeterValues with powerW > 0...`);
      }
      return;

    case 'StopTransaction': {
      chargerState.status = 'Available';
      chargerState.startRequested = pendingApiStopRequest ? false : chargerState.startRequested;
      chargerState.transactionId = undefined;
      chargerState.powerW = 0;
      chargerState.appliedCurrentLimitA = undefined;
      chargerState.lastRequestedCurrentLimitA = undefined;
      chargerState.lastUpdate = new Date().toISOString();
      pendingApiStopRequest = false;
      ws.send(JSON.stringify(buildCallResult(uniqueId, { idTagInfo: { status: 'Accepted' } })));
      emitCombinedData();
      console.log(`[${chargePointId}] StopTransaction`, sanitizePayloadForLogging(payload));

      if (chargerState.startRequested) {
        const stopReason: string = payload?.reason ?? 'unknown';
        if (stopReason === 'Other') {
          consecutiveStopReasonOtherCount++;
          if (consecutiveStopReasonOtherCount >= STOP_OTHER_COOLDOWN_THRESHOLD) {
            stopReasonOtherCooldownUntil = Date.now() + STOP_OTHER_COOLDOWN_MS;
            console.warn(
              `[${chargePointId}] StopTransaction(reason=Other) #${consecutiveStopReasonOtherCount} – cooldown active for ${STOP_OTHER_COOLDOWN_MS / 1000}s. ` +
              `Will not re-arm until ${new Date(stopReasonOtherCooldownUntil).toISOString()}`,
            );
            return;
          }
        } else {
          consecutiveStopReasonOtherCount = 0;
          stopReasonOtherCooldownUntil = 0;
        }

        if (stopReason === 'Local') {
          console.log(`[${chargePointId}] StopTransaction(reason=Local) -> skipping immediate re-arm; waiting for periodic smart loop`);
          return;
        }
        console.log(`[${chargePointId}] StopTransaction received without API stop request -> keeping smart mode armed (reason=${stopReason}, consecutiveOther=${consecutiveStopReasonOtherCount})`);
        console.log(`[${chargePointId}] Skipping immediate re-arm to allow charger relays to settle. Periodic control loop will re-arm in ${GREEN_CONTROL_LOOP_MS}ms.`);
        // NOTE: Do NOT call reconcileChargerControlState here. Immediately re-sending RemoteStartTransaction
        // causes a relay race condition in the Huawei charger (electromechanical contactors cannot toggle
        // state faster than ~100-200ms). Instead, let the periodic control loop re-arm the charger.
      }
      return;
    }

    case 'SecurityEventNotification':
    case 'DiagnosticsStatusNotification':
    case 'FirmwareStatusNotification':
      chargerState.lastUpdate = new Date().toISOString();
      ws.send(JSON.stringify(buildCallResult(uniqueId, {})));
      emitCombinedData();
      console.log(`[${chargePointId}] ${action}`, sanitizePayloadForLogging(payload));
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

// ============================================================================
// WEBSOCKET SERVER EVENT HANDLERS
// ============================================================================

if (ocppWss) {
  ocppWss.on('connection', (ws, req) => {
    const requestPath = req.url ?? '/';
    if (!requestPath.startsWith(`${OCPP_PATH_PREFIX}/`)) {
      console.warn(`Rejected OCPP path: ${requestPath}`);
      ws.close(1008, 'Invalid OCPP path');
      return;
    }

    const chargePointId = requestPath.split('/').pop() ?? 'Unknown';

    if (chargerWs && chargerWs !== ws && chargerWs.readyState === chargerWs.OPEN) {
      console.warn(`[${chargePointId}] Closing previous OCPP socket to keep a single active connection`);
      chargerWs.close(1000, 'Replaced by newer connection');
    }

    chargerState.connected = true;
    chargerState.chargePointId = chargePointId;
    chargerState.lastUpdate = new Date().toISOString();
    chargerWs = ws;
    emitCombinedData();

    console.log(`OCPP connection opened for ${chargePointId} (${req.socket.remoteAddress ?? 'unknown'})`);
    sendOcppCall(ws, chargePointId, 'GetConfiguration', {}, 'full configuration snapshot on connect');
    requestSmartChargingConfiguration(ws, chargePointId);

    // Smart charging probe is now manual-only via /api/charger/probe-smart endpoint.
    // Removed automatic probe on connect to prevent collision with charger firmware
    // during startup/recovery (especially post power-loss).

    if (!OCPP_SMART_CHARGING_ENABLED) {
      // Wipe any charging profiles left over from previous smart-charging sessions.
      // CRITICAL FIX: Must send explicit fields (id, connectorId, chargingProfilePurpose)
      // because Huawei's C++ parser crashes on empty payload. Omitting any field causes parser to fail.
      // See: Huawei charger parser expects specific keys at lines 38, 46, 54, 64
      const clearAllPayload = {
        id: 100,  // Must be explicitly set (not omitted)
        connectorId: 0,  // 0 = applies to all connectors (removes all profiles)
        chargingProfilePurpose: 'TxDefaultProfile',  // Must be present
      };
      sendOcppCall(ws, chargePointId, 'ClearChargingProfile', clearAllPayload, 'clear ALL charging profiles (smart charging disabled)');
    }

    reconcileChargerControlState('WebSocketConnected');

    ws.on('message', (raw) => {
      if (ws !== chargerWs) return;
      try {
        const parsed = JSON.parse(raw.toString());
        if (!Array.isArray(parsed) || parsed.length < 3) return;

        const messageType = parsed[0];

        if (messageType === 2) {
          handleOcppCall(ws, chargePointId, parsed as OcppCall);
        } else if (messageType === 3) {
          const uniqueId = String(parsed[1]);
          const callResult = parsed[2];
          const pending = consumePendingOcppCall(chargePointId, uniqueId);
          if (pending) {
            const elapsedMs = Date.now() - pending.sentAt;
            console.log(
              `[${chargePointId}] ← CallResult for ${pending.action}${pending.note ? ` (${pending.note})` : ''} [id=${uniqueId}] after ${elapsedMs}ms`,
            );
          }
          if (callResult && Array.isArray(callResult.configurationKey)) {
            logGetConfigurationResult(chargePointId, callResult as GetConfigurationResult);
          } else {
            console.log(`[${chargePointId}] ← CallResult:`, JSON.stringify(callResult, null, 2));
          }
        } else if (messageType === 4) {
          const uniqueId = String(parsed[1]);
          const pending = consumePendingOcppCall(chargePointId, uniqueId);
          if (pending) {
            console.warn(
              `[${chargePointId}] ← CallError for ${pending.action}${pending.note ? ` (${pending.note})` : ''} [id=${uniqueId}]`,
            );
          }
          console.warn(`[${chargePointId}] ← CallError:`, JSON.stringify(parsed, null, 2));
        }
      } catch (error) {
        console.error(`[${chargePointId}] Could not parse OCPP frame`, error);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`OCPP connection closed for ${chargePointId} (${code}) ${reason.toString()}`);
      if (chargerWs === ws) {
        chargerWs = null;
        chargerState.connected = false;
        chargerState.cableConnected = false;
        chargerState.lastUpdate = new Date().toISOString();
        emitCombinedData();
        pendingOcppCallsByChargePoint.delete(chargePointId);
      }
    });

    ws.on('error', (error) => {
      console.error(`OCPP socket error for ${chargePointId}:`, error);
    });
  });
}

// ============================================================================
// SERVICE STARTUP
// ============================================================================

/**
 * Start the charger service
 * Sets up OCPP server, restores state, starts smart charging policy loop
 * Exported for use by main entry point
 */
export async function startChargerService() {
  console.log('🚀 Starting Charger Service (OCPP)...');

  // In modular mode, restore state and start polling
  const isModular = process.env.SERVICE_ROLE && process.env.SERVICE_ROLE !== 'monolith' && !process.env.START_MONOLITH;
  if (isModular) {
    console.log('[INIT] Modular mode detected, restoring charger state and starting live-state polling');
    restorePersistedChargerState();
    loadLiveState();
    setInterval(loadLiveState, 1000);
  }

  // Start smart charging policy loop
  setInterval(() => {
    applySmartChargingPolicy();
  }, GREEN_CONTROL_LOOP_MS);

  // Send health heartbeat
  setInterval(() => {
    const status = chargerState.connected ? 'OK' : 'Disconnected';
    const details = chargerState.connected ? `CP: ${chargerState.chargePointId}` : 'Waiting for connection';
    updateServiceHeartbeat(status, details);
  }, 10000);

  // Start OCPP server
  if (ocppHttpServer) {
    ocppHttpServer.on('error', (error) => {
      console.error(`OCPP server failed on ${OCPP_HOST}:${OCPP_PORT}`, error);
    });
    ocppHttpServer.listen(OCPP_PORT, OCPP_HOST, () => {
      console.log(`OCPP server listening on ws://${OCPP_HOST}:${OCPP_PORT}${OCPP_PATH_PREFIX}/<chargePointId>`);
    });
  }
}

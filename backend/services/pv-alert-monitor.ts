export type PvAlertType = 'pv_disconnected' | 'pv_reconnected' | 'pv_string_loss';

export interface PvAlertEvent {
  type: PvAlertType;
  reason: string;
  confirmedAt: number;
  pendingSince: number;
  durationMs: number;
  sample: PvStatusSample;
  conditions: {
    connectionStatusIsFresh: boolean;
    connectionStatusAgeMs: number;
    stringLossAlarmIsFresh: boolean;
    stringLossAlarmAgeMs: number;
    inverterIsStandby: boolean;
    daylightEvidence: boolean;
  };
  thresholds: Omit<PvAlertMonitorConfig, 'standbyStatuses'> & {
    standbyStatuses: readonly number[];
  };
}

export interface PvAlertMonitorConfig {
  startupGraceMs: number;
  disconnectConfirmMs: number;
  reconnectConfirmMs: number;
  stringLossConfirmMs: number;
  statusMaxAgeMs: number;
  standbyStatuses: readonly number[];
  daylightMinPvVoltageV: number;
}

export interface PvStatusSample {
  now: number;
  inverterStatus: number;
  connectionStatus: boolean;
  connectionStatusReadAt: number;
  stringLossAlarm: boolean;
  stringLossAlarmReadAt: number;
  inputPowerW?: number;
  activePowerW?: number;
  pv1VoltageV?: number;
  pv1CurrentA?: number;
  pv2VoltageV?: number;
  pv2CurrentA?: number;
}

export function hasDaylightEvidence(sample: PvStatusSample, minimumPvVoltageV: number): boolean {
  const solarReadings = [
    sample.inputPowerW,
    sample.activePowerW,
    sample.pv1VoltageV,
    sample.pv1CurrentA,
    sample.pv2VoltageV,
    sample.pv2CurrentA,
  ];

  if (!solarReadings.some(value => Number.isFinite(value))) return true;

  return (
    (sample.inputPowerW ?? 0) > 0
    || (sample.activePowerW ?? 0) > 0
    || (sample.pv1VoltageV ?? 0) >= minimumPvVoltageV
    || (sample.pv2VoltageV ?? 0) >= minimumPvVoltageV
    || (sample.pv1CurrentA ?? 0) > 0
    || (sample.pv2CurrentA ?? 0) > 0
  );
}

export class PvAlertMonitor {
  private readonly startedAt: number;
  private previousConnectionStatus?: boolean;
  private previousStringLossAlarm?: boolean;
  private disconnectionPendingSince = 0;
  private reconnectionPendingSince = 0;
  private stringLossPendingSince = 0;
  private disconnectionAlerted = false;
  private stringLossAlerted = false;

  constructor(
    private readonly config: PvAlertMonitorConfig,
    startedAt: number = Date.now(),
  ) {
    this.startedAt = startedAt;
  }

  evaluate(sample: PvStatusSample): PvAlertEvent[] {
    const events: PvAlertEvent[] = [];
    const connectionIsFresh = this.isFresh(sample.now, sample.connectionStatusReadAt);
    const stringAlarmIsFresh = this.isFresh(sample.now, sample.stringLossAlarmReadAt);

    if (sample.now - this.startedAt < this.config.startupGraceMs) {
      this.synchronizeObservedState(sample, connectionIsFresh, stringAlarmIsFresh);
      return events;
    }

    this.evaluateConnection(sample, connectionIsFresh, events);
    this.evaluateStringAlarm(sample, stringAlarmIsFresh, events);
    return events;
  }

  private isFresh(now: number, readAt: number): boolean {
    return readAt > 0 && now >= readAt && now - readAt <= this.config.statusMaxAgeMs;
  }

  private isStandby(status: number): boolean {
    return this.config.standbyStatuses.includes(status);
  }

  private synchronizeObservedState(
    sample: PvStatusSample,
    connectionIsFresh: boolean,
    stringAlarmIsFresh: boolean,
  ): void {
    if (connectionIsFresh) this.previousConnectionStatus = sample.connectionStatus;
    if (stringAlarmIsFresh) this.previousStringLossAlarm = sample.stringLossAlarm;
  }

  private evaluateConnection(
    sample: PvStatusSample,
    connectionIsFresh: boolean,
    events: PvAlertEvent[],
  ): void {
    if (!connectionIsFresh) {
      this.disconnectionPendingSince = 0;
      this.reconnectionPendingSince = 0;
      return;
    }

    const changed = this.previousConnectionStatus !== undefined
      && sample.connectionStatus !== this.previousConnectionStatus;
    this.previousConnectionStatus = sample.connectionStatus;
    const daylightEvidence = hasDaylightEvidence(sample, this.config.daylightMinPvVoltageV);

    if (changed) {
      if (sample.connectionStatus) {
        this.disconnectionPendingSince = 0;
        if (this.disconnectionAlerted) this.reconnectionPendingSince = sample.now;
      } else {
        this.reconnectionPendingSince = 0;
      }
    }

    if (
      !sample.connectionStatus
      && !this.disconnectionAlerted
      && this.disconnectionPendingSince === 0
      && !this.isStandby(sample.inverterStatus)
      && daylightEvidence
    ) {
      this.disconnectionPendingSince = sample.now;
    }

    if (sample.connectionStatus || !daylightEvidence) {
      this.disconnectionPendingSince = 0;
    }

    if (
      !sample.connectionStatus
      && this.disconnectionPendingSince > 0
      && sample.now - this.disconnectionPendingSince >= this.config.disconnectConfirmMs
    ) {
      const pendingSince = this.disconnectionPendingSince;
      this.disconnectionAlerted = true;
      this.disconnectionPendingSince = 0;
      events.push(this.buildEvent(
        'pv_disconnected',
        'PV connection remained disconnected for the configured confirmation period',
        sample,
        pendingSince,
      ));
    }

    if (
      sample.connectionStatus
      && this.reconnectionPendingSince > 0
      && sample.now - this.reconnectionPendingSince >= this.config.reconnectConfirmMs
    ) {
      const pendingSince = this.reconnectionPendingSince;
      this.disconnectionAlerted = false;
      this.reconnectionPendingSince = 0;
      events.push(this.buildEvent(
        'pv_reconnected',
        'PV connection remained restored for the configured confirmation period',
        sample,
        pendingSince,
      ));
    }
  }

  private evaluateStringAlarm(
    sample: PvStatusSample,
    stringAlarmIsFresh: boolean,
    events: PvAlertEvent[],
  ): void {
    if (!stringAlarmIsFresh) {
      this.stringLossPendingSince = 0;
      return;
    }

    const changed = this.previousStringLossAlarm !== undefined
      && sample.stringLossAlarm !== this.previousStringLossAlarm;
    this.previousStringLossAlarm = sample.stringLossAlarm;

    if (changed && !sample.stringLossAlarm) {
      this.stringLossPendingSince = 0;
      this.stringLossAlerted = false;
    }

    if (sample.stringLossAlarm && !this.stringLossAlerted && this.stringLossPendingSince === 0) {
      this.stringLossPendingSince = sample.now;
    }

    if (!sample.stringLossAlarm) {
      this.stringLossPendingSince = 0;
    }

    if (
      sample.stringLossAlarm
      && this.stringLossPendingSince > 0
      && sample.now - this.stringLossPendingSince >= this.config.stringLossConfirmMs
    ) {
      const pendingSince = this.stringLossPendingSince;
      this.stringLossAlerted = true;
      this.stringLossPendingSince = 0;
      events.push(this.buildEvent(
        'pv_string_loss',
        'Huawei alarm 2015 remained active for the configured confirmation period',
        sample,
        pendingSince,
      ));
    }
  }

  private buildEvent(
    type: PvAlertType,
    reason: string,
    sample: PvStatusSample,
    pendingSince: number,
  ): PvAlertEvent {
    return {
      type,
      reason,
      confirmedAt: sample.now,
      pendingSince,
      durationMs: sample.now - pendingSince,
      sample: { ...sample },
      conditions: {
        connectionStatusIsFresh: this.isFresh(sample.now, sample.connectionStatusReadAt),
        connectionStatusAgeMs: sample.now - sample.connectionStatusReadAt,
        stringLossAlarmIsFresh: this.isFresh(sample.now, sample.stringLossAlarmReadAt),
        stringLossAlarmAgeMs: sample.now - sample.stringLossAlarmReadAt,
        inverterIsStandby: this.isStandby(sample.inverterStatus),
        daylightEvidence: hasDaylightEvidence(sample, this.config.daylightMinPvVoltageV),
      },
      thresholds: {
        ...this.config,
        standbyStatuses: [...this.config.standbyStatuses],
      },
    };
  }
}

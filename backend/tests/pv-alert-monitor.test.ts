import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PvAlertMonitor,
  type PvAlertEvent,
  type PvAlertMonitorConfig,
  type PvStatusSample,
} from '../services/pv-alert-monitor.js';

const STARTED_AT = 1_000;
const config: PvAlertMonitorConfig = {
  startupGraceMs: 100,
  disconnectConfirmMs: 300,
  reconnectConfirmMs: 100,
  stringLossConfirmMs: 100,
  statusMaxAgeMs: 50,
  standbyStatuses: [0, 1, 2, 3],
};

function sample(
  now: number,
  overrides: Partial<PvStatusSample> = {},
): PvStatusSample {
  return {
    now,
    inverterStatus: 512,
    connectionStatus: true,
    connectionStatusReadAt: now,
    stringLossAlarm: false,
    stringLossAlarmReadAt: now,
    ...overrides,
  };
}

function collect(
  monitor: PvAlertMonitor,
  samples: PvStatusSample[],
): PvAlertEvent[] {
  return samples.flatMap(current => monitor.evaluate(current));
}

function eventTypes(events: PvAlertEvent[]): string[] {
  return events.map(event => event.type);
}

describe('PvAlertMonitor', () => {
  test('suppresses observations during startup grace period', () => {
    const monitor = new PvAlertMonitor(config, STARTED_AT);
    const events = collect(monitor, [
      sample(1_010, { connectionStatus: false, stringLossAlarm: true }),
      sample(1_099, { connectionStatus: false, stringLossAlarm: true }),
    ]);

    assert.deepEqual(events, []);
  });

  test('does not report normal sunset or an entire night in standby', () => {
    const monitor = new PvAlertMonitor(config, STARTED_AT);
    const samples = [sample(1_100)];

    for (let now = 1_110; now <= 20_000; now += 37) {
      samples.push(sample(now, {
        inverterStatus: now % 4,
        connectionStatus: false,
      }));
    }

    assert.deepEqual(eventTypes(collect(monitor, samples)), []);
  });

  test('rejects a transient daytime connection drop', () => {
    const monitor = new PvAlertMonitor(config, STARTED_AT);
    const events = collect(monitor, [
      sample(1_100),
      sample(1_110, { connectionStatus: false }),
      sample(1_250, { connectionStatus: false }),
      sample(1_260),
      sample(1_500),
    ]);

    assert.deepEqual(eventTypes(events), []);
  });

  test('reports one persistent daytime connection loss', () => {
    const monitor = new PvAlertMonitor(config, STARTED_AT);
    const events = collect(monitor, [
      sample(1_100),
      sample(1_110, { connectionStatus: false }),
      sample(1_300, { inverterStatus: 2, connectionStatus: false }),
      sample(1_410, { inverterStatus: 2, connectionStatus: false }),
      sample(2_000, { inverterStatus: 2, connectionStatus: false }),
    ]);

    assert.deepEqual(eventTypes(events), ['pv_disconnected']);
    assert.equal(events[0].durationMs, 300);
    assert.equal(events[0].sample.inverterStatus, 2);
    assert.equal(events[0].conditions.connectionStatusIsFresh, true);
    assert.equal(events[0].thresholds.disconnectConfirmMs, 300);
  });

  test('requires fresh continuous readings for confirmation', () => {
    const monitor = new PvAlertMonitor(config, STARTED_AT);
    const events = collect(monitor, [
      sample(1_100),
      sample(1_110, { connectionStatus: false }),
      sample(1_500, { connectionStatus: false, connectionStatusReadAt: 1_110 }),
      sample(1_510, { connectionStatus: false }),
      sample(1_800, { connectionStatus: false }),
      sample(1_810, { connectionStatus: false }),
    ]);

    assert.deepEqual(eventTypes(events), ['pv_disconnected']);
  });

  test('reports recovery only after a confirmed loss and stable recovery', () => {
    const monitor = new PvAlertMonitor(config, STARTED_AT);
    const events = collect(monitor, [
      sample(1_100),
      sample(1_110),
      sample(1_250),
      sample(1_300, { connectionStatus: false }),
      sample(1_600, { connectionStatus: false }),
      sample(1_610),
      sample(1_650, { connectionStatus: false }),
      sample(1_660),
      sample(1_760),
      sample(2_000),
    ]);

    assert.deepEqual(eventTypes(events), ['pv_disconnected', 'pv_reconnected']);
  });

  test('rejects a transient string-loss alarm', () => {
    const monitor = new PvAlertMonitor(config, STARTED_AT);
    const events = collect(monitor, [
      sample(1_100),
      sample(1_110, { stringLossAlarm: true }),
      sample(1_150, { stringLossAlarm: true }),
      sample(1_160),
      sample(1_500),
    ]);

    assert.deepEqual(eventTypes(events), []);
  });

  test('reports a persistent string-loss alarm once per incident', () => {
    const monitor = new PvAlertMonitor(config, STARTED_AT);
    const events = collect(monitor, [
      sample(1_100),
      sample(1_110, { stringLossAlarm: true }),
      sample(1_210, { stringLossAlarm: true }),
      sample(1_500, { stringLossAlarm: true }),
      sample(1_510),
      sample(1_520, { stringLossAlarm: true }),
      sample(1_620, { stringLossAlarm: true }),
    ]);

    assert.deepEqual(eventTypes(events), ['pv_string_loss', 'pv_string_loss']);
  });
});

/**
 * Statistics Module
 * Handles InfluxDB queries and historical statistics calculations
 */

import { InfluxDB, Point } from '@influxdata/influxdb-client';
import fs from 'fs';
import path from 'path';
import {
  INFLUX_URL,
  INFLUX_TOKEN,
  INFLUX_ORG,
  INFLUX_BUCKET,
  HISTORY_DIR,
} from '../config/constants.js';

/**
 * InfluxDB client initialized only if token is configured
 */
export const influxClient = INFLUX_TOKEN ? new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN }) : null;

/**
 * InfluxDB write API for telemetry points
 */
export const influxWriteApi = influxClient ? influxClient.getWriteApi(INFLUX_ORG, INFLUX_BUCKET, 'ms') : null;

/**
 * Query InfluxDB for aggregated statistics over a time range
 *
 * @param rangeStart - ISO 8601 start time
 * @param rangeStop - ISO 8601 stop time
 * @returns Promise with production, consumption, export, import, and selfConsumption in kWh
 *
 * @example
 * const stats = await queryInfluxStats('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z');
 * // { production: 15.5, consumption: 8.2, export: 7.3, import: 0, selfConsumption: 7.5 }
 */
export async function queryInfluxStats(rangeStart: string, rangeStop: string) {
  if (!influxClient) return null;
  const queryApi = influxClient.getQueryApi(INFLUX_ORG);

  const fluxQuery = `
    import "math"
    from(bucket: "${INFLUX_BUCKET}")
      |> range(start: ${rangeStart}, stop: ${rangeStop})
      |> filter(fn: (r) => r["_field"] == "inputPower" or r["_field"] == "consumption" or r["_field"] == "gridPower")
      |> integral(unit: 1h)
      |> pivot(rowKey:["_start"], columnKey: ["_field"], valueColumn: "_value")
  `;

  return new Promise((resolve, reject) => {
    let result = { production: 0, consumption: 0, export: 0, import: 0, selfConsumption: 0 };
    queryApi.queryRows(fluxQuery, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row);
        const prod = (o.inputPower ?? 0);
        const cons = (o.consumption ?? 0);
        const grid = (o.gridPower ?? 0);

        result.production = prod / 1000;
        result.consumption = cons / 1000;
        result.export = grid > 0 ? grid / 1000 : 0;
        result.import = grid < 0 ? Math.abs(grid) / 1000 : 0;
        result.selfConsumption = Math.max(0, result.production - result.export);
      },
      error(error) { reject(error); },
      complete() { resolve(result); },
    });
  });
}

/**
 * Calculate daily statistics from historical JSONL file
 *
 * @param date - ISO date string (YYYY-MM-DD)
 * @returns Promise with production, consumption, export, import, and selfConsumption in kWh
 *
 * @example
 * const stats = await calculateStatsForDate('2026-05-10');
 * // { production: 15.5, consumption: 8.2, export: 7.3, import: 0, selfConsumption: 7.5 }
 */
export async function calculateStatsForDate(date: string) {
  const filePath = path.join(HISTORY_DIR, `${date}.jsonl`);
  if (!fs.existsSync(filePath)) {
    return { production: 0, consumption: 0, export: 0, import: 0, selfConsumption: 0 };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);

  let totalProduction = 0;
  let totalConsumption = 0;
  let totalExport = 0;
  let totalImport = 0;
  let lastTime: number | null = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const currentTime = new Date(entry.time).getTime();

      if (lastTime !== null) {
        const deltaHours = (currentTime - lastTime) / (1000 * 3600);

        totalProduction += (entry.inputPower ?? 0) * deltaHours;
        totalConsumption += (entry.consumption ?? 0) * deltaHours;

        const gridPower = entry.gridPower ?? 0;
        if (gridPower > 0) {
          totalExport += gridPower * deltaHours;
        } else {
          totalImport += Math.abs(gridPower) * deltaHours;
        }
      }
      lastTime = currentTime;
    } catch (e) {
      continue;
    }
  }

  const prodKwh = totalProduction / 1000;
  const consKwh = totalConsumption / 1000;
  const exportKwh = totalExport / 1000;
  const importKwh = totalImport / 1000;
  const selfConsumptionKwh = Math.max(0, prodKwh - exportKwh);

  return {
    production: prodKwh,
    consumption: consKwh,
    export: exportKwh,
    import: importKwh,
    selfConsumption: selfConsumptionKwh
  };
}

/**
 * Write a telemetry point to InfluxDB
 * Guard check ensures only the collector service writes to InfluxDB
 *
 * @param data - Object containing telemetry fields
 * @internal
 */
export function writeToInflux(data: any) {
  const isCollector = process.env.SERVICE_ROLE === 'collector' || process.env.START_MONOLITH === 'true';
  if (!influxWriteApi || !isCollector) return; // Guard para evitar escrituras desde contenedores sin rol colector

  try {
    const point = new Point('telemetry')
      .tag('model', data.model)
      .tag('serial', data.serialNumber)
      .floatField('activePower', data.activePower)
      .floatField('inputPower', data.inputPower)
      .floatField('houseLoad', data.houseLoad)
      .floatField('gridPower', data.gridPower)
      .floatField('batteryPower', data.batteryPower)
      .floatField('batterySOC', data.batterySOC)
      .floatField('pv1Voltage', data.pv1Voltage)
      .floatField('pv1Current', data.pv1Current)
      .floatField('pv2Voltage', data.pv2Voltage)
      .floatField('pv2Current', data.pv2Current)
      .floatField('consumption', data.consumption)
      .floatField('temperature', data.temperature);

    influxWriteApi.writePoint(point);
  } catch (error) {
    console.error('Error writing to InfluxDB:', error);
  }
}

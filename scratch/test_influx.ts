
import { InfluxDB } from '@influxdata/influxdb-client';

const INFLUX_URL = 'http://localhost:8086';
const INFLUX_TOKEN = 'my-super-secret-token'; // We'll need to get this or use env
const INFLUX_ORG = 'huawei-dashboard';
const INFLUX_BUCKET = 'telemetry';

async function test() {
  const client = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN || 'test' });
  const queryApi = client.getQueryApi(INFLUX_ORG);

  const rangeStart = "-24h";
  const rangeStop = "now()";

  const fluxQuery = `
    import "math"
    from(bucket: "${INFLUX_BUCKET}")
      |> range(start: ${rangeStart}, stop: ${rangeStop})
      |> filter(fn: (r) => r["_field"] == "inputPower" or r["_field"] == "consumption" or r["_field"] == "gridPower")
      |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> map(fn: (r) => ({
          _time: r._time,
          production: if exists r.inputPower then r.inputPower else 0.0,
          consumption: if exists r.consumption then r.consumption else 0.0,
          gridPower: if exists r.gridPower then r.gridPower else 0.0
      }))
      |> map(fn: (r) => ({
          _time: r._time,
          production: r.production,
          consumption: r.consumption,
          grid_export: if r.gridPower > 0.0 then r.gridPower else 0.0,
          grid_import: if r.gridPower < 0.0 then math.abs(x: r.gridPower) else 0.0
      }))
      |> aggregateWindow(every: 1h, fn: mean)
  `;

  console.log('Running Query...');
  try {
    await new Promise((resolve, reject) => {
      queryApi.queryRows(fluxQuery, {
        next(row, tableMeta) {
          const o = tableMeta.toObject(row);
          console.log('Row:', o);
        },
        error(error) { reject(error); },
        complete() { resolve(true); },
      });
    });
    console.log('Query finished successfully!');
  } catch (err) {
    console.error('Query FAILED:', err);
  }
}

test();

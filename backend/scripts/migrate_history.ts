import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { InfluxDB, Point } from '@influxdata/influxdb-client';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const HISTORY_DIR = path.resolve(__dirname, '../../storage/history');

// InfluxDB Config
const INFLUX_URL = process.env.INFLUX_URL || 'http://localhost:8086';
const INFLUX_TOKEN = process.env.INFLUX_TOKEN || 'my-super-secret-token';
const INFLUX_ORG = process.env.INFLUX_ORG || 'huawei-dashboard';
const INFLUX_BUCKET = process.env.INFLUX_BUCKET || 'telemetry';

if (!INFLUX_TOKEN) {
  console.error('Error: INFLUX_TOKEN is required for migration.');
  process.exit(1);
}

const influxClient = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
const writeApi = influxClient.getWriteApi(INFLUX_ORG, INFLUX_BUCKET, 'ms');

async function migrate() {
  console.log('🚀 Starting history migration to InfluxDB...');
  
  if (!fs.existsSync(HISTORY_DIR)) {
    console.error(`History directory not found at: ${HISTORY_DIR}`);
    return;
  }

  const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl'));
  console.log(`Found ${files.length} history files.`);

  let totalPoints = 0;

  for (const file of files) {
    const filePath = path.join(HISTORY_DIR, file);
    console.log(`Processing ${file}...`);
    
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        const timestamp = new Date(data.time);
        
        if (isNaN(timestamp.getTime())) continue;

        const point = new Point('telemetry')
          .tag('model', data.model || 'Unknown')
          .tag('serial', data.serialNumber || 'Unknown')
          .floatField('activePower', data.power ?? data.activePower ?? 0)
          .floatField('inputPower', data.inputPower ?? 0)
          .floatField('consumption', data.consumption ?? 0)
          .floatField('gridPower', data.gridPower ?? 0)
          .floatField('batterySOC', data.batterySOC ?? 0)
          .timestamp(timestamp);

        writeApi.writePoint(point);
        totalPoints++;

        // Flush every 1000 points to avoid memory issues
        if (totalPoints % 1000 === 0) {
          await writeApi.flush();
          console.log(`  Uploaded ${totalPoints} points...`);
        }
      } catch (e) {
        console.warn(`  Failed to parse line in ${file}:`, e);
      }
    }
  }

  try {
    await writeApi.close();
    console.log(`✅ Migration complete! Total points uploaded: ${totalPoints}`);
  } catch (e) {
    console.error('Error closing InfluxDB Write API:', e);
  }
}

migrate().catch(console.error);

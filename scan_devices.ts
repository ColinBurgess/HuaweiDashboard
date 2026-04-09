import net from 'net';
// @ts-ignore
import { client as ModbusClient } from 'jsmodbus';

const HOST = '192.168.1.140';
const PORT = 502;

function u16ToStr(registers: any): string {
  const regs = Array.isArray(registers) ? registers : Array.from(registers as Uint8Array);
  const buffer = Buffer.alloc(regs.length * 2);
  regs.forEach((reg, i) => buffer.writeUInt16BE(reg as number, i * 2));
  return buffer.toString('ascii').replace(/\0/g, '').trim();
}

async function checkId(id: number) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const client = new ModbusClient.TCP(socket, id);
    socket.setTimeout(1500);
    
    socket.on('connect', async () => {
      try {
        // Read Model Name (30000, 15 regs)
        const res = await client.readHoldingRegisters(30000, 15);
        const model = u16ToStr(res.response.body.values);
        resolve({ id, success: true, model });
      } catch (e: any) {
        resolve({ id, success: false, error: e.message });
      } finally {
        socket.destroy();
      }
    });
    
    socket.on('error', (err) => resolve({ id, success: false, error: err.message }));
    socket.on('timeout', () => resolve({ id, success: false, error: 'Timeout' }));
    socket.connect({ host: HOST, port: PORT });
  });
}

async function run() {
  console.log(`--- ESCANEO DE DISPOSITIVOS (IDs 1-20) en ${HOST} ---`);
  
  const results = [];
  // Scan in parallel (batches) or sequence. Sequence is safer for PLC/Dongles.
  for (let id = 1; id <= 20; id++) {
    const result: any = await checkId(id);
    if (result.success) {
      console.log(`✅ ID ${id}: ENCONTRADO -> Modelo: "${result.model}"`);
    } else {
      // Solo loggear si no es un simple timeout para no saturar
      if (result.error !== 'Timeout') {
        // console.log(`ℹ️ ID ${id}: Error (${result.error})`);
      }
    }
  }
  
  process.exit(0);
}

run();

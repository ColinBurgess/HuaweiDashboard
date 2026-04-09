import net from 'net';
// @ts-ignore
import { client as ModbusClient } from 'jsmodbus';

const HOST = '192.168.1.142';
const PORT = 502;
const ID = 1;

function u16ToStr(registers: any): string {
  const regs = Array.isArray(registers) ? registers : Array.from(registers as Uint8Array);
  const buffer = Buffer.alloc(regs.length * 2);
  regs.forEach((reg, i) => buffer.writeUInt16BE(reg as number, i * 2));
  return buffer.toString('ascii').replace(/\0/g, '').trim();
}

async function run() {
  const ids = [1, 16, 2];
  for (const id of ids) {
    console.log(`Probando ID ${id} en ${HOST}...`);
    const success: any = await new Promise((resolve) => {
      const socket = new net.Socket();
      const client = new ModbusClient.TCP(socket, id);
      socket.setTimeout(2000);
      
      socket.on('connect', async () => {
        try {
          const res = await client.readHoldingRegisters(30015, 10); // SN is usually safe
          resolve({ success: true, value: u16ToStr(res.response.body.values) });
        } catch (e: any) {
          resolve({ success: false, error: e.message });
        } finally {
          socket.destroy();
        }
      });
      
      socket.on('error', (err) => resolve({ success: false, error: err.message }));
      socket.on('timeout', () => resolve({ success: false, error: 'Timeout' }));
      socket.connect({ host: HOST, port: PORT });
    });

    if (success.success) {
      console.log(`✅ ¡EXITO! ID ${id} respondió con SN: ${success.value}`);
      break;
    } else {
      console.log(`❌ ID ${id} falló: ${success.error}`);
    }
  }
  process.exit(0);
}


run();

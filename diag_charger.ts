import net from 'net';
// @ts-ignore
import { client as ModbusClient } from 'jsmodbus';

const HOST = '192.168.1.140';
const PORT = 502;

async function testQuery(id: number, reg: number) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const client = new ModbusClient.TCP(socket, id);
    socket.setTimeout(3000);
    
    socket.on('connect', async () => {
      try {
        const res = await client.readHoldingRegisters(reg, 2);
        resolve({ id, reg, success: true, values: res.response.body.values });
      } catch (e: any) {
        resolve({ id, reg, success: false, error: e.message });
      } finally {
        socket.destroy();
      }
    });
    
    socket.on('error', (err) => resolve({ id, reg, success: false, error: err.message }));
    socket.on('timeout', () => resolve({ id, reg, success: false, error: 'Timeout' }));
    socket.connect({ host: HOST, port: PORT });
  });
}

async function run() {
  console.log("--- DIAGNÓSTICO DETALLADO ---");
  
  // 1. Probar registro que SI funciona en la app (Meter) para confirmar conexión
  console.log("Probando Meter (ID 1, Reg 37113)...");
  console.log(await testQuery(1, 37113));

  // 2. Probar Cargador en ID 1 (Nuevos registros)
  console.log("\nProbando Cargador en ID 1 (Reg 38230)...");
  console.log(await testQuery(1, 38230));

  // 3. Probar Cargador en ID 16 (Registros estándar)
  console.log("\nProbando Cargador en ID 16 (Reg 38255)...");
  console.log(await testQuery(16, 38255));

  // 4. Probar Cargador en ID 16 (Nuevos registros)
  console.log("\nProbando Cargador en ID 16 (Reg 38230)...");
  console.log(await testQuery(16, 38230));

  process.exit(0);
}

run();

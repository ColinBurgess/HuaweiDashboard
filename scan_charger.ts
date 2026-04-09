import net from 'net';
// @ts-ignore
import { client as ModbusClient } from 'jsmodbus';

const HOST = '192.168.1.140';
const PORTS = [502, 6607];
const TEST_IDS = [1, 16];
const REGS_TO_TEST = [37113, 38230, 38255]; 

async function scan() {
  for (const port of PORTS) {
    console.log(`--- Escaneando Puerto ${port} ---`);
    for (const id of TEST_IDS) {
      for (const reg of REGS_TO_TEST) {
        const socket = new net.Socket();
        const client = new ModbusClient.TCP(socket, id);
        
        const outcome = await new Promise((resolve) => {
          socket.setTimeout(2000);
          
          socket.on('connect', async () => {
            try {
              const res = await client.readHoldingRegisters(reg, 2);
              resolve({ success: true, value: res.response.body.values[0], reg, port, id });
            } catch (e: any) {
              resolve({ success: false, error: e.message, reg, port, id });
            } finally {
              socket.destroy();
            }
          });
          
          socket.on('error', (err) => {
            resolve({ success: false, error: err.message, reg, port, id });
            socket.destroy();
          });
          
          socket.on('timeout', () => {
            resolve({ success: false, error: 'Timeout', reg, port, id });
            socket.destroy();
          });
          
          socket.connect({ host: HOST, port: port });
        });
        
        const result = outcome as any;
        if (result.success) {
          console.log(`✅ PORT ${result.port} | ID ${result.id} | REG ${result.reg}: RESPUESTA! Valor: ${result.value}`);
        } else {
          // console.log(`❌ PORT ${result.port} | ID ${result.id} | REG ${result.reg}: ${result.error}`);
        }
      }
    }
  }


  
  process.exit(0);
}

scan();

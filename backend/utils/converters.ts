/**
 * Modbus Data Conversion Utilities
 * Pure functions for converting Modbus register values to standard units
 */

/**
 * Convert an array of 16-bit registers to an ASCII string
 * Reads big-endian U16 values and concatenates their ASCII bytes
 *
 * @param registers - Array of U16 register values or Uint8Array
 * @returns Trimmed ASCII string with null characters removed
 *
 * @example
 * u16ToStr([0x4875, 0x6177, 0x6569]) // "Huawei"
 */
export function u16ToStr(registers: any): string {
  const regs = Array.isArray(registers) ? registers : Array.from(registers as Uint8Array);
  const buffer = Buffer.alloc(regs.length * 2);

  regs.forEach((reg: number, i: number) => {
    buffer.writeUInt16BE(reg as number, i * 2);
  });

  return buffer.toString('ascii').replace(/\0/g, '').trim();
}

/**
 * Convert two consecutive 16-bit registers to a signed 32-bit integer
 * Registers are read in big-endian order
 *
 * @param registers - Array of at least 2 U16 register values or Uint8Array
 * @returns Signed 32-bit integer
 *
 * @example
 * i32FromRegs([0x0000, 0x03E8]) // 1000
 * i32FromRegs([0xFFFF, 0xFC18]) // -1000
 */
export function i32FromRegs(registers: any): number {
  const buffer = Buffer.alloc(4);
  const regs = Array.isArray(registers) ? registers : Array.from(registers as Uint8Array);

  buffer.writeUInt16BE(regs[0] as number, 0);
  buffer.writeUInt16BE(regs[1] as number, 2);

  return buffer.readInt32BE(0);
}

/**
 * Convert two consecutive 16-bit registers to an unsigned 32-bit integer
 * Registers are read in big-endian order
 *
 * @param registers - Array of at least 2 U16 register values or Uint8Array
 * @returns Unsigned 32-bit integer
 *
 * @example
 * u32FromRegs([0x0000, 0x03E8]) // 1000
 * u32FromRegs([0xFFFF, 0xFFFF]) // 4294967295
 */
export function u32FromRegs(registers: any): number {
  const buffer = Buffer.alloc(4);
  const regs = Array.isArray(registers) ? registers : Array.from(registers as Uint8Array);

  buffer.writeUInt16BE(regs[0] as number, 0);
  buffer.writeUInt16BE(regs[1] as number, 2);

  return buffer.readUInt32BE(0);
}

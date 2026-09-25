import { deflateSync } from "node:zlib";

/** Deterministic noisy pixels make a valid, poorly compressible native fixture. */
export function syntheticPng(width = 768, height = 768): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data]); let crc = -1;
    for (const byte of payload) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const header = Buffer.alloc(4), tail = Buffer.alloc(4); header.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ -1) >>> 0);
    return Buffer.concat([header, payload, tail]);
  };
  const pixels = Buffer.alloc(height * (1 + width * 3));
  let random = 1;
  for (let y = 0; y < height; y++) for (let x = 1; x <= width * 3; x++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    pixels[y * (width * 3 + 1) + x] = random >>> 24;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

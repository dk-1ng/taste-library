import { deflateSync } from "node:zlib";
import { createSeededRandom } from "./random.js";

export type Rgb = readonly [number, number, number];

/** Deterministic RGB pixel data (noise over a gradient), row-major, 3 bytes per pixel. */
function pixels(width: number, height: number, seed: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`Invalid image size ${width}x${height}`);
  }
  const rng = createSeededRandom(seed);
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      data[i] = Math.floor((x / width) * 192) + rng.int(64);
      data[i + 1] = Math.floor((y / height) * 192) + rng.int(64);
      data[i + 2] = rng.int(256);
    }
  }
  return data;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** A valid 8-bit RGB PNG of the given size; the same arguments always give the same pixels (the compressed bytes are stable only within one Node version). */
export function makePng(width: number, height: number, seed = 1): Buffer {
  const rgb = pixels(width, height, seed);
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height); // filter byte 0 at the start of each row
  for (let y = 0; y < height; y++) {
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/** A valid 24-bit BMP of the given size; the same arguments always give the same bytes. */
export function makeBmp(width: number, height: number, seed = 1): Buffer {
  const rgb = pixels(width, height, seed);
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + rowSize * height);
  out.write("BM", 0, "latin1");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(rowSize * height, 34);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize; // BMP rows are stored bottom-up
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      out[row + x * 3] = rgb[i + 2] as number; // BGR order
      out[row + x * 3 + 1] = rgb[i + 1] as number;
      out[row + x * 3 + 2] = rgb[i] as number;
    }
  }
  return out;
}

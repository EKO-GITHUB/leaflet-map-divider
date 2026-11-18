// A minimal PNG codec for the tests: 8-bit RGBA output, and input of 8-bit greyscale, grey+alpha, RGB or RGBA,
// non-interlaced, any filter. Enough for the fixtures and for tiles a canvas encodes as PNG; WebP tiles need a real
// decoder.
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { createDeflate, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts: Uint8Array[]) {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) crc = CRC_TABLE[(crc ^ part[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32([head.subarray(4), data]), 0);
  return Buffer.concat([head, data, tail]);
}

function ihdr(width: number, height: number) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // bit depth
  data[9] = 6; // colour type RGBA; compression, filter and interlace stay 0
  return chunk("IHDR", data);
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function predictor(type: number, a: number, b: number, c: number) {
  switch (type) {
    case 0:
      return 0;
    case 1:
      return a;
    case 2:
      return b;
    case 3:
      return (a + b) >> 1;
    case 4:
      return paeth(a, b, c);
    default:
      throw new Error(`unknown PNG filter ${type}`);
  }
}

export interface EncodeOptions {
  /** Filter per row: a fixed type 0-4, or "cycle" (row y gets y % 5, to exercise every filter). Default 0. */
  filter?: number | "cycle";
}

/** Encodes RGBA pixels (width * height * 4 bytes) as a PNG. */
export function encode_png(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  options: EncodeOptions = {},
) {
  if (rgba.length !== width * height * 4) throw new Error(`expected ${width * height * 4} bytes, got ${rgba.length}`);
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const type = options.filter === "cycle" ? y % 5 : (options.filter ?? 0);
    const start = y * stride;
    raw[y * (stride + 1)] = type;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[start + i - 4] : 0;
      const b = y > 0 ? rgba[start - stride + i] : 0;
      const c = y > 0 && i >= 4 ? rgba[start - stride + i - 4] : 0;
      raw[y * (stride + 1) + 1 + i] = (rgba[start + i] - predictor(type, a, b, c)) & 0xff;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    ihdr(width, height),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Streams an RGBA PNG (filter 0) to a file row by row, so a large fixture never sits in memory whole. */
export async function write_png_file(path: string, width: number, height: number, row: (y: number) => Uint8Array) {
  const file = createWriteStream(path);
  const write = async (data: Uint8Array) => {
    if (!file.write(data)) await once(file, "drain");
  };
  await write(SIGNATURE);
  await write(ihdr(width, height));

  const deflate = createDeflate({ level: 6 });
  const idat_done = (async () => {
    for await (const data of deflate) await write(chunk("IDAT", data as Buffer));
  })();
  const filter_byte = new Uint8Array([0]);
  for (let y = 0; y < height; y++) {
    deflate.write(filter_byte);
    // copy: the caller may reuse its row buffer while zlib still holds this one
    if (!deflate.write(Buffer.from(row(y)))) await once(deflate, "drain");
  }
  deflate.end();
  await idat_done;

  await write(chunk("IEND", new Uint8Array(0)));
  file.end();
  await once(file, "finish");
}

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decode_png(png: Uint8Array): DecodedImage {
  const buffer = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const color = data[9];
      const interlace = data[12];
      channels = CHANNELS[color] ?? 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) {
        throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${color}, interlace ${interlace}`);
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (channels === 0) throw new Error("PNG has no IHDR");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)];
    const row_start = y * (stride + 1) + 1;
    const start = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[start + i - channels] : 0;
      const b = y > 0 ? pixels[start - stride + i] : 0;
      const c = y > 0 && i >= channels ? pixels[start - stride + i - channels] : 0;
      pixels[start + i] = (raw[row_start + i] + predictor(type, a, b, c)) & 0xff;
    }
  }

  if (channels === 4) return { width, height, data: pixels };
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    const grey = channels <= 2;
    data[p * 4] = pixels[s];
    data[p * 4 + 1] = grey ? pixels[s] : pixels[s + 1];
    data[p * 4 + 2] = grey ? pixels[s] : pixels[s + 2];
    data[p * 4 + 3] = channels === 2 ? pixels[s + 1] : channels === 4 ? pixels[s + 3] : 255;
  }
  return { width, height, data };
}

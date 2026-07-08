// Minimal lossless PNG encoder for 8/16-bit grayscale data rasters.
// Bytes go in, the same bytes come out of any decoder — no colourspace
// machinery anywhere (sharp's grey16 conversion turned out to be
// colorimetric, i.e. lossy for data). Adaptive None/Sub/Up filtering +
// node zlib level 9 gets libpng-class compression on smooth rasters.

import { deflateSync, crc32 } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])) >>> 0, 0);
  return Buffer.concat([head, payload, crcBuf]);
}

/**
 * Encode a grayscale raster as PNG.
 * @param {Uint8Array|Uint16Array} data row-major, top row first
 * @param {number} width  @param {number} height
 * @returns {Buffer} PNG bytes (colour type 0, depth 8 or 16)
 */
export function encodeGrayPNG(data, width, height) {
  const depth = data.BYTES_PER_ELEMENT * 8;
  const bpp = depth / 8;
  const stride = width * bpp;

  // raw scanlines, 16-bit big-endian per PNG spec
  const raw = Buffer.alloc(height * stride);
  if (depth === 8) {
    raw.set(data);
  } else {
    for (let i = 0; i < data.length; i++) {
      raw[i * 2] = data[i] >> 8;
      raw[i * 2 + 1] = data[i] & 0xff;
    }
  }

  // adaptive per-row filter: None / Sub / Up, smallest sum of |signed bytes|
  const filtered = Buffer.alloc(height * (stride + 1));
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;
    let bestType = 0;
    let bestSum = Infinity;
    let bestBytes = row;
    for (const type of [0, 1, 2]) {
      if (type === 2 && !prev) continue;
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const v = type === 0 ? row[i]
          : type === 1 ? (row[i] - (i >= bpp ? row[i - bpp] : 0)) & 0xff
          : (row[i] - prev[i]) & 0xff;
        candidate[i] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestType = type;
        bestBytes = Buffer.from(type === 0 ? row : candidate);
      }
    }
    filtered[y * (stride + 1)] = bestType;
    bestBytes.copy(filtered, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;  // bit depth
  ihdr[9] = 0;      // colour type: grayscale
  // compression 0, filter 0, interlace 0 already zeroed

  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

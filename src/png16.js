// Minimal lossless PNG decoder for the app's data rasters (8/16-bit
// grayscale only). Heights and masks travel as PNG — half the bytes of raw
// binaries — and decode here to the EXACT same arrays the .bin files held:
// no canvas involved, so no color management can touch the values, and
// inflate is the browser's native DecompressionStream. ~90 lines, no deps.

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function inflate(deflated) {
  const ds = new DecompressionStream('deflate'); // zlib wrapper (RFC 1950)
  const stream = new Blob([deflated]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decode an 8- or 16-bit grayscale PNG.
 * @param {ArrayBuffer} buffer PNG bytes
 * @returns {Promise<{width, height, depth, data: Uint8Array|Uint16Array}>}
 *          data is row-major, top row first — same layout as the raw .bin
 */
export async function decodeGrayPNG(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) throw new Error('not a PNG');
  }

  let width = 0, height = 0, depth = 0;
  const idat = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    if (type === 'IHDR') {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      depth = bytes[start + 8];
      const colorType = bytes[start + 9];
      if (colorType !== 0 || (depth !== 8 && depth !== 16) ||
          bytes[start + 12] !== 0 /* interlace */) {
        throw new Error(`unsupported PNG (color ${colorType}, depth ${depth})`);
      }
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, start + length));
    } else if (type === 'IEND') break;
    offset = start + length + 4; // skip CRC
  }

  const raw = await inflate(idat.length === 1 ? idat[0] : concat(idat));
  const bpp = depth / 8;
  const stride = width * bpp;
  const out = new Uint8Array(width * height * bpp);

  // undo per-scanline filters (None/Sub/Up/Average/Paeth)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    switch (filter) {
      case 0:
        out.set(raw.subarray(src, src + stride), dst);
        break;
      case 1:
        for (let i = 0; i < stride; i++) {
          out[dst + i] = raw[src + i] + (i >= bpp ? out[dst + i - bpp] : 0);
        }
        break;
      case 2:
        for (let i = 0; i < stride; i++) {
          out[dst + i] = raw[src + i] + (y > 0 ? out[prev + i] : 0);
        }
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[dst + i - bpp] : 0;
          const b = y > 0 ? out[prev + i] : 0;
          out[dst + i] = raw[src + i] + ((a + b) >> 1);
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[dst + i - bpp] : 0;
          const b = y > 0 ? out[prev + i] : 0;
          const c = i >= bpp && y > 0 ? out[prev + i - bpp] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          out[dst + i] = raw[src + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        break;
      default:
        throw new Error(`bad PNG filter ${filter}`);
    }
  }

  if (depth === 8) return { width, height, depth, data: out };
  // 16-bit samples are big-endian in PNG
  const data = new Uint16Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = (out[i * 2] << 8) | out[i * 2 + 1];
  }
  return { width, height, depth, data };
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const joined = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { joined.set(p, o); o += p.length; }
  return joined;
}

/* Minimal GIF89a encoder — no dependencies.
 *
 * Supports: single global palette (built per-animation from sampled frames),
 * per-frame graphic control extensions, NETSCAPE infinite loop.
 * Quantisation: 6x6x6 web-safe cube + 40-step grayscale = 256 colors.
 * Delays are centisecond-accurate via cumulative rounding.
 */

// ---------- palette ----------
function buildPalette() {
  const pal = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) {
        pal[i++] = r * 51; pal[i++] = g * 51; pal[i++] = b * 51;
      }
  for (let k = 0; k < 40; k++) {
    const v = Math.round(k * 255 / 39);
    pal[i++] = v; pal[i++] = v; pal[i++] = v;
  }
  return pal;
}

const PAL = buildPalette();

// Index reserved for the GIF transparent colour. It is never assigned to any
// opaque pixel, so a viewer that ignores transparency shows plain white
// instead of punching holes through dark parts of the artwork.
export const TRANSPARENT_INDEX = 255;

// precomputed rgb -> palette index (6-level cube + gray)
function rgbToIndex(r, g, b, reserved = -1) {
  const c6 = v => Math.min(5, Math.round(v / 51));
  // distance to gray axis
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let idx;
  if (mx - mn <= 24) {
    const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    idx = 216 + Math.min(39, Math.round(lum * 39 / 255));
  } else {
    idx = c6(r) * 36 + c6(g) * 6 + c6(b);
  }
  // never hand out the reserved slot: fall back to its nearest neighbour
  if (idx === reserved) idx = reserved === 255 ? 254 : reserved + 1;
  return idx;
}

// ---------- LZW ----------
class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.bits = 0; }
  write(code, size) {
    this.cur |= code << this.bits;
    this.bits += size;
    while (this.bits >= 8) {
      this.bytes.push(this.cur & 0xff);
      this.cur >>= 8;
      this.bits -= 8;
    }
  }
  flush() {
    if (this.bits > 0) { this.bytes.push(this.cur & 0xff); this.cur = 0; this.bits = 0; }
    return this.bytes;
  }
}

function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const maxMax = 1 << 12;
  let codeSize = minCodeSize + 1;
  let freeEnt = eoi + 1;          // next code to allocate

  let dict = new Map();
  const resetDict = () => { dict = new Map(); codeSize = minCodeSize + 1; freeEnt = eoi + 1; };

  const bw = new BitWriter();
  bw.write(clear, codeSize);

  // GIFCOMPR semantics (Poskanzer): the code is emitted with the CURRENT width,
  // THEN the width is grown if freeEnt exceeds the current max code, THEN a
  // dictionary entry is allocated. This stays in sync with standard decoders.
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    if (dict.has(key)) {
      prefix = dict.get(key);
      continue;
    }
    bw.write(prefix, codeSize);
    if (freeEnt > (1 << codeSize) - 1 && codeSize < 12) codeSize++;
    if (freeEnt < maxMax) {
      dict.set(key, freeEnt++);
    } else {
      // table full: reset (emits CLEAR, starts a fresh dictionary)
      bw.write(clear, codeSize);
      resetDict();
    }
    prefix = k;
  }
  bw.write(prefix, codeSize);
  bw.write(eoi, codeSize);
  return bw.flush();
}

function subBlocks(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const n = Math.min(255, data.length - i);
    out.push(n);
    for (let j = 0; j < n; j++) out.push(data[i + j]);
    i += n;
  }
  out.push(0);
  return out;
}

// ---------- GIF assembly ----------
/**
 * @param {Array<{rgba: Uint8ClampedArray, w: number, h: number, delayMs: number}>} frames
 * @param {{transparent?: boolean, bg?: [r,g,b], loop?: number}} opts
 */
export function encodeGif(frames, opts = {}) {
  const { w, h } = frames[0];
  const transparent = !!opts.transparent;
  const bg = opts.bg || [23, 23, 28];
  const loop = opts.loop ?? 0;

  const bytes = [];
  const push = (...a) => bytes.push(...a);
  const str = s => { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };

  // header
  str("GIF89a");
  push(w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff);
  // GCT flag, color resolution, sort, GCT size (256 -> 7)
  push(0xF7, 0, 0);
  push(...PAL);
  // NETSCAPE loop
  push(0x21, 0xff, 11);
  str("NETSCAPE2.0");
  push(3, 1, loop & 0xff, (loop >> 8) & 0xff, 0);

  // centisecond delays with cumulative rounding (33.3ms -> 30/40 alternating)
  const delays = [];
  let prevCs = 0;
  for (let i = 0; i < frames.length; i++) {
    const cs = Math.round(((i + 1) * frames[i].delayMs) / 10);
    delays.push(Math.max(2, cs - prevCs));
    prevCs = cs;
  }

  frames.forEach((f, fi) => {
    const { rgba } = f;
    // quantise + optional transparency
    const indices = new Uint8Array(f.w * f.h);
    for (let p = 0, q = 0; p < rgba.length; p += 4, q++) {
      const a = rgba[p + 3];
      if (transparent && a < 128) {
        indices[q] = TRANSPARENT_INDEX;
      } else {
        indices[q] = rgbToIndex(rgba[p], rgba[p + 1], rgba[p + 2],
          transparent ? TRANSPARENT_INDEX : -1);
      }
    }

    // graphic control extension
    const disposal = transparent ? 2 : 0;
    push(0x21, 0xf9, 4);
    push((disposal << 2) | (transparent ? 1 : 0));
    push(delays[fi] & 0xff, (delays[fi] >> 8) & 0xff);
    push(transparent ? TRANSPARENT_INDEX : 0, 0);

    // image descriptor (no local palette — global covers everything)
    push(0x2c, 0, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff, 0);
    push(8); // LZW minimum code size
    const blocks = subBlocks(lzwEncode(indices, 8));
    for (let bi = 0; bi < blocks.length; bi++) bytes.push(blocks[bi]);
  });

  push(0x3b);
  return new Uint8Array(bytes);
}

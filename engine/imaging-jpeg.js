const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
  54, 47, 55, 62, 63,
]);

const IDCT = (() => {
  const t = new Float64Array(64);
  for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) t[x * 8 + u] = (u === 0 ? Math.sqrt(1 / 8) : Math.sqrt(2 / 8)) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return t;
})();

export class JpegError extends Error {
  constructor(message, code = 'decode') {
    super(message);
    this.code = code;
  }
}

function buildHuffman(counts, symbols) {
  const lookup = new Uint16Array(512);
  const maxcode = new Int32Array(18).fill(-1);
  const mincode = new Int32Array(17);
  const valptr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    mincode[len] = code;
    valptr[len] = k;
    for (let i = 0; i < counts[len - 1]; i++) {
      if (len <= 9) {
        const shift = 9 - len;
        const base = code << shift;
        for (let j = 0; j < 1 << shift; j++) lookup[base + j] = (len << 8) | symbols[k];
      }
      code++;
      k++;
    }
    maxcode[len] = counts[len - 1] ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { lookup, maxcode, mincode, valptr, symbols };
}

function idctBlock(src, at, qt, out, tmp) {
  for (let v = 0; v < 8; v++) {
    const row = at + v * 8;
    let zero = true;
    for (let u = 1; u < 8; u++) if (src[row + u] !== 0) { zero = false; break; }
    if (zero) {
      const dc = src[row] * qt[v * 8] * IDCT[0];
      for (let x = 0; x < 8; x++) tmp[v * 8 + x] = dc;
      continue;
    }
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) {
        const c = src[row + u];
        if (c !== 0) s += IDCT[x * 8 + u] * c * qt[v * 8 + u];
      }
      tmp[v * 8 + x] = s;
    }
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += IDCT[y * 8 + v] * tmp[v * 8 + x];
      out[y * 8 + x] = s + 128;
    }
  }
}

const clamp8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0);

export function pickScale(width, height, needWidth, needHeight) {
  for (const s of [8, 4, 2]) {
    if (Math.floor(width / s) >= needWidth && Math.floor(height / s) >= needHeight) return s;
  }
  return 1;
}

export function decodeJpeg(data, { maxPixels = Infinity, needWidth = Infinity, needHeight = Infinity, maxCoefBytes = 40 * 1024 * 1024, expectWidth = null, expectHeight = null } = {}) {
  const end = data.length;
  if (end < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new JpegError('not a JPEG');
  const qtables = [];
  const dcTables = [];
  const acTables = [];
  let frame = null;
  let adobe = null;
  let jfif = false;
  let restart = 0;
  let pos = 2;
  let ready = false;
  let streaming = false;
  let scale = 1;
  let bs = 8;
  const blockOut = new Float64Array(64);
  const tmp = new Float64Array(64);

  const u16 = (o) => (data[o] << 8) | data[o + 1];

  function setupFrame(progressive) {
    if (frame) throw new JpegError('more than one frame');
    const precision = data[pos + 4];
    const height = u16(pos + 5);
    const width = u16(pos + 7);
    const count = data[pos + 9];
    if (precision !== 8) throw new JpegError('only 8-bit JPEGs are supported', 'unsupported');
    if (!width || !height || !count || count > 4) throw new JpegError('bad frame header');
    if (width * height > maxPixels) throw new JpegError('too many pixels', 'pixels');
    if ((expectWidth != null && width !== expectWidth) || (expectHeight != null && height !== expectHeight)) throw new JpegError('JPEG sizes disagree', 'pixels');
    const comps = [];
    let maxH = 1;
    let maxV = 1;
    for (let i = 0; i < count; i++) {
      const o = pos + 10 + i * 3;
      const h = data[o + 1] >> 4;
      const v = data[o + 1] & 15;
      if (!h || !v || h > 4 || v > 4) throw new JpegError('bad sampling factors');
      comps.push({ id: data[o], h, v, tq: data[o + 2] & 3, pred: 0 });
      maxH = Math.max(maxH, h);
      maxV = Math.max(maxV, v);
    }
    const mcusPerLine = Math.ceil(width / (8 * maxH));
    const mcusPerColumn = Math.ceil(height / (8 * maxV));
    for (const c of comps) {
      c.blocksPerLine = Math.ceil((Math.ceil(width / 8) * c.h) / maxH);
      c.blocksPerColumn = Math.ceil((Math.ceil(height / 8) * c.v) / maxV);
      c.bplMcu = mcusPerLine * c.h;
      c.bpcMcu = mcusPerColumn * c.v;
    }
    frame = { width, height, comps, maxH, maxV, mcusPerLine, mcusPerColumn, progressive };
    scale = pickScale(width, height, needWidth, needHeight);
    bs = 8 / scale;
  }

  function allocate(scanCount) {
    streaming = !frame.progressive && scanCount === frame.comps.length;
    let total = 0;
    for (const c of frame.comps) {
      c.ringRows = streaming ? (frame.comps.length === 1 ? 1 : c.v) : c.bpcMcu;
      total += c.bplMcu * c.ringRows * 64 * 2;
    }
    if (total > maxCoefBytes) throw new JpegError('too much memory needed', 'memory');
    for (const c of frame.comps) {
      c.coefs = new Int16Array(c.bplMcu * c.ringRows * 64);
      c.pw = c.bplMcu * bs;
      c.ph = c.bpcMcu * bs;
      c.plane = new Uint8Array(c.pw * c.ph).fill(128);
    }
    ready = true;
  }

  function flushRow(c, blockRow) {
    const qt = qtables[c.tq];
    if (!qt) throw new JpegError('missing quantization table');
    const ring = (blockRow % c.ringRows) * c.bplMcu * 64;
    const plane = c.plane;
    const pw = c.pw;
    const y0 = blockRow * bs;
    for (let col = 0; col < c.bplMcu; col++) {
      const at = ring + col * 64;
      const x0 = col * bs;
      if (scale === 8) {
        plane[y0 * pw + x0] = clamp8(c.coefs[at] * qt[0] / 8 + 128);
      } else {
        idctBlock(c.coefs, at, qt, blockOut, tmp);
        if (scale === 1) {
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) plane[(y0 + y) * pw + x0 + x] = clamp8(blockOut[y * 8 + x]);
        } else {
          const area = scale * scale;
          for (let y = 0; y < bs; y++) {
            for (let x = 0; x < bs; x++) {
              let s = 0;
              for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) s += blockOut[(y * scale + yy) * 8 + x * scale + xx];
              plane[(y0 + y) * pw + x0 + x] = clamp8(s / area);
            }
          }
        }
      }
      if (streaming) c.coefs.fill(0, at, at + 64);
    }
  }

  function decodeScan(scanComps, ss, se, ah, al) {
    let bitBuf = 0;
    let bitCnt = 0;
    let eobrun = 0;
    const fill = () => {
      while (bitCnt <= 24) {
        let b = 0;
        if (pos < end) {
          b = data[pos];
          if (b === 0xff) {
            const next = data[pos + 1];
            if (next === 0) pos += 2;
            else b = 0;
          } else pos++;
        }
        bitBuf = (bitBuf << 8) | b;
        bitCnt += 8;
      }
    };
    const bits = (n) => {
      if (n === 0) return 0;
      if (bitCnt < n) fill();
      bitCnt -= n;
      return (bitBuf >>> bitCnt) & ((1 << n) - 1);
    };
    const bit = () => {
      if (bitCnt < 1) fill();
      bitCnt--;
      return (bitBuf >>> bitCnt) & 1;
    };
    const extend = (v, s) => (v < 1 << (s - 1) ? v - (1 << s) + 1 : v);
    const huff = (t) => {
      if (bitCnt < 16) fill();
      const p = (bitBuf >>> (bitCnt - 16)) & 0xffff;
      const e = t.lookup[p >>> 7];
      if (e) {
        bitCnt -= e >> 8;
        return e & 255;
      }
      for (let len = 10; len <= 16; len++) {
        const code = p >>> (16 - len);
        if (code <= t.maxcode[len]) {
          bitCnt -= len;
          return t.symbols[t.valptr[len] + code - t.mincode[len]] ?? 0;
        }
      }
      bitCnt -= 16;
      return 0;
    };

    const baseline = (c, z, at) => {
      const t = huff(c.dc);
      const diff = t === 0 ? 0 : extend(bits(t), t);
      c.pred += diff;
      z[at] = c.pred;
      for (let k = 1; k < 64;) {
        const rs = huff(c.ac);
        const s = rs & 15;
        const r = rs >> 4;
        if (s === 0) {
          if (r < 15) break;
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        z[at + ZIGZAG[k]] = extend(bits(s), s);
        k++;
      }
    };
    const dcFirst = (c, z, at) => {
      const t = huff(c.dc);
      const diff = t === 0 ? 0 : extend(bits(t), t);
      c.pred += diff;
      z[at] = c.pred * (1 << al);
    };
    const dcRefine = (c, z, at) => {
      if (bit()) z[at] |= 1 << al;
    };
    const acFirst = (c, z, at) => {
      if (eobrun > 0) { eobrun--; return; }
      for (let k = ss; k <= se;) {
        const rs = huff(c.ac);
        const s = rs & 15;
        const r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            eobrun = bits(r) + (1 << r) - 1;
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        z[at + ZIGZAG[k]] = extend(bits(s), s) * (1 << al);
        k++;
      }
    };
    const acRefine = (c, z, at) => {
      const p1 = 1 << al;
      const m1 = -1 << al;
      let k = ss;
      if (eobrun <= 0) {
        for (; k <= se;) {
          const rs = huff(c.ac);
          const s = rs & 15;
          let r = rs >> 4;
          let value = 0;
          if (s === 0) {
            if (r < 15) {
              eobrun = bits(r) + (1 << r);
              break;
            }
          } else {
            value = bit() ? p1 : m1;
          }
          while (k <= se) {
            const zi = at + ZIGZAG[k];
            if (z[zi] !== 0) {
              if (bit() && (z[zi] & p1) === 0) z[zi] += z[zi] >= 0 ? p1 : m1;
            } else {
              if (r === 0) {
                if (value !== 0) z[zi] = value;
                k++;
                break;
              }
              r--;
            }
            k++;
          }
        }
      }
      if (eobrun > 0) {
        for (; k <= se; k++) {
          const zi = at + ZIGZAG[k];
          if (z[zi] !== 0 && bit() && (z[zi] & p1) === 0) z[zi] += z[zi] >= 0 ? p1 : m1;
        }
        eobrun--;
      }
    };

    let fn = baseline;
    if (frame.progressive) {
      if (ss === 0) fn = ah === 0 ? dcFirst : dcRefine;
      else fn = ah === 0 ? acFirst : acRefine;
    }
    const single = scanComps.length === 1;
    const total = single ? scanComps[0].blocksPerLine * scanComps[0].blocksPerColumn : frame.mcusPerLine * frame.mcusPerColumn;
    const interval = restart || total;
    const offset = (c, row, col) => ((row % c.ringRows) * c.bplMcu + col) * 64;

    for (let m = 0; m < total; m++) {
      if (m > 0 && m % interval === 0) {
        bitCnt = 0;
        bitBuf = 0;
        while (pos + 1 < end && !(data[pos] === 0xff && data[pos + 1] >= 0xd0 && data[pos + 1] <= 0xd7)) {
          if (data[pos] === 0xff && data[pos + 1] !== 0 && data[pos + 1] !== 0xff) break;
          pos++;
        }
        if (pos + 1 < end && data[pos] === 0xff && data[pos + 1] >= 0xd0 && data[pos + 1] <= 0xd7) pos += 2;
        for (const c of scanComps) c.pred = 0;
        eobrun = 0;
      }
      if (single) {
        const c = scanComps[0];
        const row = Math.floor(m / c.blocksPerLine);
        const col = m % c.blocksPerLine;
        fn(c, c.coefs, offset(c, row, col));
        if (streaming && col === c.blocksPerLine - 1) flushRow(c, row);
      } else {
        const mcuRow = Math.floor(m / frame.mcusPerLine);
        const mcuCol = m % frame.mcusPerLine;
        for (const c of scanComps) {
          for (let j = 0; j < c.v; j++) {
            for (let k = 0; k < c.h; k++) fn(c, c.coefs, offset(c, mcuRow * c.v + j, mcuCol * c.h + k));
          }
        }
        if (streaming && mcuCol === frame.mcusPerLine - 1) {
          for (const c of scanComps) for (let j = 0; j < c.v; j++) flushRow(c, mcuRow * c.v + j);
        }
      }
    }
    while (pos + 1 < end) {
      if (data[pos] === 0xff) {
        const n = data[pos + 1];
        if (n !== 0 && n !== 0xff && !(n >= 0xd0 && n <= 0xd7)) break;
      }
      pos++;
    }
  }

  let done = false;
  while (pos + 3 < end && !done) {
    if (data[pos] !== 0xff) { pos++; continue; }
    const marker = data[pos + 1];
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (marker === 0xd9) break;
    const len = u16(pos + 2);
    if (len < 2) throw new JpegError('bad segment length');
    const segEnd = pos + 2 + len;
    if (segEnd > end) throw new JpegError('truncated segment');
    switch (marker) {
      case 0xc0:
      case 0xc1:
      case 0xc2:
        setupFrame(marker === 0xc2);
        break;
      case 0xc4: {
        let o = pos + 4;
        while (o < segEnd) {
          const tc = data[o] >> 4;
          const th = data[o] & 3;
          const counts = data.subarray(o + 1, o + 17);
          let n = 0;
          for (let i = 0; i < 16; i++) n += counts[i];
          const symbols = data.slice(o + 17, o + 17 + n);
          (tc ? acTables : dcTables)[th] = buildHuffman(counts, symbols);
          o += 17 + n;
        }
        break;
      }
      case 0xdb: {
        let o = pos + 4;
        while (o < segEnd) {
          const pq = data[o] >> 4;
          const tq = data[o] & 3;
          const table = new Float64Array(64);
          for (let i = 0; i < 64; i++) table[ZIGZAG[i]] = pq ? u16(o + 1 + i * 2) : data[o + 1 + i];
          qtables[tq] = table;
          o += 1 + (pq ? 128 : 64);
        }
        break;
      }
      case 0xdd:
        restart = u16(pos + 4);
        break;
      case 0xe0:
        if (data[pos + 4] === 0x4a && data[pos + 5] === 0x46 && data[pos + 6] === 0x49 && data[pos + 7] === 0x46) jfif = true;
        break;
      case 0xee:
        if (data[pos + 4] === 0x41 && data[pos + 5] === 0x64 && data[pos + 6] === 0x6f && data[pos + 7] === 0x62 && data[pos + 8] === 0x65) adobe = { transform: data[pos + 15] };
        break;
      case 0xda: {
        if (!frame) throw new JpegError('scan before frame');
        const ns = data[pos + 4];
        const scanComps = [];
        for (let i = 0; i < ns; i++) {
          const id = data[pos + 5 + i * 2];
          const tables = data[pos + 6 + i * 2];
          const c = frame.comps.find((x) => x.id === id);
          if (!c) throw new JpegError('scan names an unknown component');
          c.dc = dcTables[tables >> 4];
          c.ac = acTables[tables & 15];
          c.pred = 0;
          scanComps.push(c);
        }
        const o = pos + 5 + ns * 2;
        const ss = data[o];
        const se = data[o + 1];
        const ah = data[o + 2] >> 4;
        const al = data[o + 2] & 15;
        for (const c of scanComps) {
          if (!c.dc && (!frame.progressive || ss === 0)) throw new JpegError('missing Huffman table');
          if (!c.ac && (!frame.progressive || ss > 0)) throw new JpegError('missing Huffman table');
        }
        if (!ready) allocate(ns);
        pos = segEnd;
        decodeScan(scanComps, ss, se, ah, al);
        if (streaming) done = true;
        continue;
      }
      default:
        if ((marker >= 0xc3 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) throw new JpegError('this kind of JPEG is not supported', 'unsupported');
        break;
    }
    pos = segEnd;
  }
  if (!frame || !ready) throw new JpegError('no picture data');
  if (!streaming) for (const c of frame.comps) for (let r = 0; r < c.bpcMcu; r++) flushRow(c, r);

  const outW = Math.ceil(frame.width / scale);
  const outH = Math.ceil(frame.height / scale);
  const out = new Uint8Array(outW * outH * 3);
  const comps = frame.comps;
  const maps = comps.map((c) => {
    const xs = new Int32Array(outW);
    for (let x = 0; x < outW; x++) xs[x] = Math.min(c.pw - 1, Math.floor((x * c.h) / frame.maxH));
    return xs;
  });
  const rowOf = (c, y) => Math.min(c.ph - 1, Math.floor((y * c.v) / frame.maxV)) * c.pw;
  const n = comps.length;
  const rgbIds = n === 3 && comps[0].id === 0x52 && comps[1].id === 0x47 && comps[2].id === 0x42;
  const transform = n === 3 ? !(adobe && adobe.transform === 0) && !(rgbIds && !jfif) : n === 4 ? !!(adobe && adobe.transform === 2) : false;
  let o = 0;
  for (let y = 0; y < outH; y++) {
    if (n === 1) {
      const p = comps[0].plane;
      const r0 = rowOf(comps[0], y);
      for (let x = 0; x < outW; x++) {
        const v = p[r0 + maps[0][x]];
        out[o++] = v; out[o++] = v; out[o++] = v;
      }
      continue;
    }
    const r = comps.map((c) => rowOf(c, y));
    for (let x = 0; x < outW; x++) {
      const a = comps[0].plane[r[0] + maps[0][x]];
      const b = comps[1].plane[r[1] + maps[1][x]];
      const c2 = n > 2 ? comps[2].plane[r[2] + maps[2][x]] : 128;
      let R = a;
      let G = b;
      let B = c2;
      if (transform) {
        R = a + 1.402 * (c2 - 128);
        G = a - 0.344136 * (b - 128) - 0.714136 * (c2 - 128);
        B = a + 1.772 * (b - 128);
      }
      if (n === 4) {
        const k = comps[3].plane[r[3] + maps[3][x]];
        R = (clamp8(R) * k) / 255;
        G = (clamp8(G) * k) / 255;
        B = (clamp8(B) * k) / 255;
      } else if (n === 2) {
        R = a; G = a; B = a;
      }
      out[o++] = clamp8(R);
      out[o++] = clamp8(G);
      out[o++] = clamp8(B);
    }
  }
  return { width: outW, height: outH, channels: 3, data: out, scale, sourceWidth: frame.width, sourceHeight: frame.height, progressive: frame.progressive };
}

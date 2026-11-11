import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineApp } from '../engine/apps.js';
import { card } from '../engine/ui.js';
import { friendly, looksLikeFeatureOff } from '../engine/errors.js';

const ID = 'studio';
const ICON = '🎬';

const MAX_CAPTION = 300;
const MAX_LINES = 6;
const MAX_DOWNLOAD = 15 * 1024 * 1024;
const MAX_OUTPUT = Math.floor(9.5 * 1024 * 1024);
const MAX_SIDE = 4096;
const MAX_SECONDS = 12;
const MIN_CAPTION_WIDTH = 240;
const MAX_UPSCALED_HEIGHT = 2048;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 8000;
const REPROBE_MS = 5 * 60_000;
const MAX_REDIRECTS = 3;
const CONCURRENCY = 2;
const QUEUE_LIMIT = 20;
const COOLDOWN_MS = 10_000;
const FILES_PER_MINUTE = 20;
const WINDOW_MS = 60_000;
const USER_LIMIT = 5000;
const MAX_PIXELS = MAX_SIDE * MAX_SIDE;
const ANIMATED_AREA = 480 * 640;
const OUTPUT_STOP = MAX_OUTPUT + 1024 * 1024;
const RENDER_THREADS = 2;
const MAX_PATH_LENGTH = 512;
const STALE_MS = 15 * 60_000;
const STALE_NAME = /^yapos-studio-(?:[0-9a-f]{16}-)?[A-Za-z0-9]{6}$/;
const BURST_LIMIT = 5;
const BURST_MS = 10_000;

export const PASSES = [{ maxWidth: 480, fps: 15 }, { maxWidth: 320, fps: 10 }];
export const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
export const ALLOWED_HOSTS = ['files.yapper.website', 'www.yapin.gg'];
export const FONT_CANDIDATES = [
  'C:/Windows/Fonts/impact.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Impact.ttf',
];

const DEMUXERS = { png: 'png_pipe', jpg: 'jpeg_pipe', gif: 'gif', webp: 'webp_pipe' };
const ORIENT_FILTERS = { 2: ['hflip'], 3: ['hflip', 'vflip'], 4: ['vflip'], 5: ['transpose=0'], 6: ['transpose=1'], 7: ['transpose=3'], 8: ['transpose=2'] };
const FILE_NAMES = { caption: 'caption.gif', gif: 'image.gif' };

const HOW_SERVER = 'Send a picture and type `!caption your text` in the same message, or reply to a picture with `!caption your text`. `!gif` works the same way and just makes a GIF.';
const HOW_DM = 'Send me a picture with `caption your text` (or just `gif`) in the same message.';
const HOW_LIMITS = 'PNG, JPG, GIF and WebP up to 15 MB. Animated GIFs stay animated.';

export function findFont(env = process.env, exists = fs.existsSync) {
  const own = env.YAPOS_FONT;
  if (own && exists(own)) return own;
  return FONT_CANDIDATES.find((f) => exists(f)) || null;
}

export function fontFactor(fontFile) {
  const name = String(fontFile || '').toLowerCase();
  if (name.includes('impact')) return 0.86;
  if (name.includes('arial')) return 1;
  if (name.includes('dejavu')) return 1.15;
  return 1.1;
}

function glyphUnits(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x2e80) return 1.05;
  if (code > 0x7e) return 0.7;
  if (" .,:;!|'`ijl".includes(ch)) return 0.3;
  if ('ftrI()[]{}-"*/\\1'.includes(ch)) return 0.4;
  if ('mwMW@%'.includes(ch)) return 0.92;
  if (ch >= 'a' && ch <= 'z') return 0.58;
  if (ch >= '0' && ch <= '9') return 0.58;
  return 0.74;
}

function parseFont(buf) {
  const tag = buf.toString('latin1', 0, 4);
  if (buf.readUInt32BE(0) !== 0x00010000 && tag !== 'true' && tag !== 'OTTO') return null;
  const u16 = (o) => buf.readUInt16BE(o);
  const tables = {};
  for (let i = 0; i < u16(4); i++) tables[buf.toString('latin1', 12 + i * 16, 16 + i * 16)] = buf.readUInt32BE(20 + i * 16);
  if (!tables.head || !tables.hhea || !tables.hmtx || !tables.cmap) return null;
  const unitsPerEm = u16(tables.head + 18);
  const metricCount = u16(tables.hhea + 34);
  if (!unitsPerEm || !metricCount) return null;
  const advance = (glyph) => u16(tables.hmtx + 4 * Math.min(glyph, metricCount - 1)) / unitsPerEm;
  let sub = 0;
  for (let i = 0; i < u16(tables.cmap + 2) && !sub; i++) {
    const rec = tables.cmap + 4 + i * 8;
    const at = tables.cmap + buf.readUInt32BE(rec + 4);
    if (u16(at) === 4 && (u16(rec) === 0 || (u16(rec) === 3 && u16(rec + 2) === 1))) sub = at;
  }
  if (!sub) return null;
  const span = u16(sub + 6);
  const ends = sub + 14;
  const starts = ends + span + 2;
  const deltas = starts + span;
  const ranges = deltas + span;
  const widths = new Map();
  for (let s = 0; s < span; s += 2) {
    const end = Math.min(u16(ends + s), 0xfffe);
    const range = u16(ranges + s);
    for (let c = u16(starts + s); c <= end; c++) {
      const raw = range ? u16(ranges + s + range + (c - u16(starts + s)) * 2) : c;
      const glyph = range && !raw ? 0 : (raw + u16(deltas + s)) & 0xffff;
      if (glyph) widths.set(c, advance(glyph));
    }
  }
  return { widths, missing: advance(0) };
}

const metricsCache = new Map();
export function fontMetrics(fontFile) {
  if (!fontFile) return null;
  if (!metricsCache.has(fontFile)) {
    let parsed = null;
    try { parsed = parseFont(fs.readFileSync(fontFile)); } catch { parsed = null; }
    metricsCache.set(fontFile, parsed);
  }
  return metricsCache.get(fontFile);
}

export function measureText(text, fontSize, fontFile = null) {
  const metrics = fontMetrics(fontFile);
  let units = 0;
  if (metrics) for (const ch of String(text)) units += metrics.widths.get(ch.codePointAt(0)) ?? metrics.missing;
  else for (const ch of String(text)) units += glyphUnits(ch) * fontFactor(fontFile);
  return units * fontSize;
}

export const fontSizeFor = (width) => Math.max(12, Math.min(64, Math.round(width / 10.5)));
export const minFontSizeFor = (width) => Math.max(10, Math.round(width / 22));

export function cleanCaption(text) {
  const cleaned = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE0E\uFE0F\uFEFF]/g, '')
    .split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim()).filter(Boolean).join('\n');
  const points = [...cleaned];
  if (points.length <= MAX_CAPTION) return { text: cleaned, trimmed: false };
  return { text: `${points.slice(0, MAX_CAPTION - 1).join('').trimEnd()}…`, trimmed: true };
}

export function drawable(text, fontFile = null, metrics = fontMetrics(fontFile)) {
  const clean = String(text ?? '');
  if (!metrics) return clean;
  const kept = [...clean].filter((ch) => ch === '\n' || ch === ' ' || metrics.widths.has(ch.codePointAt(0))).join('');
  return kept.split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim()).filter(Boolean).join('\n');
}

function breakWord(word, fits) {
  const parts = [];
  let cur = '';
  for (const ch of word) {
    if (cur && !fits(cur + ch)) { parts.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function wrapAt(text, fits) {
  const lines = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const word of para.split(' ').filter(Boolean)) {
      const joined = cur ? `${cur} ${word}` : word;
      if (fits(joined)) { cur = joined; continue; }
      if (cur) lines.push(cur);
      if (fits(word)) { cur = word; continue; }
      const parts = breakWord(word, fits);
      cur = parts.pop() || '';
      lines.push(...parts);
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

export function wrapText(text, { width = 480, fontFile = null, maxLines = MAX_LINES, fontSize = null, measure = (s, size) => measureText(s, size, fontFile) } = {}) {
  const clean = cleanCaption(text).text;
  const margin = Math.max(4, Math.round(width * 0.04));
  const avail = Math.max(8, width - margin * 2);
  const min = minFontSizeFor(width);
  let size = fontSize || fontSizeFor(width);
  let lines = [];
  for (;;) {
    const at = size;
    lines = wrapAt(clean, (s) => measure(s, at) <= avail);
    if (lines.length <= maxLines || size <= min) break;
    size = Math.max(min, Math.floor(size * 0.88));
  }
  let truncated = false;
  if (lines.length > maxLines) {
    truncated = true;
    lines = lines.slice(0, maxLines);
    let last = [...lines[maxLines - 1]];
    while (last.length > 1 && measure(`${last.join('')}…`, size) > avail) last.pop();
    lines[maxLines - 1] = `${last.join('').trimEnd()}…`;
  }
  for (let k = 0.6; !truncated && lines.length > 1 && k < 1; k += 0.05) {
    const tighter = wrapAt(clean, (s) => measure(s, size) <= avail * k);
    if (tighter.length === lines.length && tighter.join(' ') === lines.join(' ')) { lines = tighter; break; }
  }
  const lineHeight = Math.round(size * 1.18);
  const pad = Math.round(size * 0.45);
  const capHeight = Math.round(size * 0.78);
  const count = Math.max(1, lines.length);
  const raw = pad + capHeight + (count - 1) * lineHeight + pad;
  const barHeight = raw + (raw % 2);
  const baselines = lines.map((_, i) => pad + capHeight + i * lineHeight);
  return { lines, fontSize: size, lineHeight, barHeight, baselines, margin, truncated };
}

export function filterPath(p, windows = process.platform === 'win32') {
  const plain = windows ? String(p).replace(/\\/g, '/') : String(p);
  const optionLevel = plain.replace(/([\\':])/g, '\\$1');
  return optionLevel.replace(/([\\'[\],;])/g, '\\$1');
}

export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG' && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const head = buf.toString('latin1', 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function exifOrientation(buf, start, end) {
  try {
    if (buf.toString('latin1', start, start + 6) !== 'Exif\0\0') return 1;
    const tiff = start + 6;
    const order = buf.toString('latin1', tiff, tiff + 2);
    if (order !== 'II' && order !== 'MM') return 1;
    const le = order === 'II';
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const ifd = tiff + u32(tiff + 4);
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > end) return 1;
      if (u16(entry) === 0x0112) {
        const v = u16(entry + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
  } catch {
    return 1;
  }
  return 1;
}

function jpegSize(buf) {
  let i = 2;
  let orientation = 1;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (marker === 0xe1) orientation = exifOrientation(buf, i + 4, Math.min(buf.length, i + 2 + len));
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 > buf.length) return null;
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), orientation };
    }
    if (marker === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  const kind = buf.toString('latin1', 12, 16);
  if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1, animated: !!(buf[20] & 0x02) };
  return null;
}

export function imageSize(buf, type = sniffImage(buf)) {
  let found = null;
  try {
    if (type === 'png' && buf.length >= 24 && buf.readUInt32BE(8) === 13 && buf.toString('latin1', 12, 16) === 'IHDR') found = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    else if (type === 'gif') found = { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), animated: true };
    else if (type === 'jpg') found = jpegSize(buf);
    else if (type === 'webp') found = webpSize(buf);
  } catch {
    found = null;
  }
  if (!found || !(found.width > 0) || !(found.height > 0)) return null;
  const orientation = found.orientation || 1;
  const turned = orientation >= 5;
  return { width: turned ? found.height : found.width, height: turned ? found.width : found.height, orientation, animated: !!found.animated };
}

export function extensionOf(attachment) {
  const pick = (s) => {
    const base = String(s || '').split(/[?#]/)[0].split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  };
  if (typeof attachment === 'string') return pick(attachment);
  return pick(attachment?.name) || pick(attachment?.path);
}

export function isAllowedUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.hostname) && !u.port && !u.username && !u.password;
}

export function attachmentUrl(filePath) {
  if (typeof filePath !== 'string') return null;
  const p = filePath.trim();
  if (!p || p.length > MAX_PATH_LENGTH) return null;
  if (/[\\\s?#\u0000-\u001F\u007F]/.test(p) || /%(?:2e|2f|5c|00|25)/i.test(p)) return null;
  if (p.startsWith('//') || p.split('/').some((part) => part === '..' || part === '.')) return null;
  const raw = p.startsWith('/') ? `https://www.yapin.gg${p}` : `https://files.yapper.website/attachments/${p}`;
  if (!isAllowedUrl(raw)) return null;
  const u = new URL(raw);
  if (u.search || u.hash) return null;
  if (!p.startsWith('/') && !u.pathname.startsWith('/attachments/')) return null;
  return u.href;
}

export function outputSize({ width, height, maxWidth = PASSES[0].maxWidth, minWidth = 0, maxArea = Infinity }) {
  const floorEven = (n) => Math.max(2, Math.floor(n / 2) * 2);
  const roundEven = (n) => Math.max(2, Math.round(n / 2) * 2);
  let w = Math.min(width, maxWidth);
  const floor = Math.min(minWidth, maxWidth, Math.floor((width * MAX_UPSCALED_HEIGHT) / height));
  if (w < floor) w = floor;
  if ((w * w * height) / width > maxArea) w = Math.floor(Math.sqrt((maxArea * width) / height));
  w = floorEven(w);
  return { width: w, height: roundEven((height * w) / width) };
}

export function buildArgs(job) {
  const w = job.outWidth;
  const h = job.outHeight;
  const chain = [...(ORIENT_FILTERS[job.orientation] || [])];
  if (job.animated) chain.push(`fps=fps='min(${job.fps},source_fps)'`);
  chain.push(`scale=${w}:${h}:flags=lanczos`);
  if (job.kind === 'caption') {
    const bar = job.layout.barHeight;
    const font = filterPath(job.fontFile);
    chain.push('format=rgba', `pad=${w}:${h + bar}:0:${bar}:color=white`);
    job.lineFiles.forEach((file, i) => {
      chain.push(`drawtext=fontfile=${font}:textfile=${filterPath(file)}:expansion=none:fontsize=${job.layout.fontSize}:fontcolor=black:x=(w-text_w)/2:y=${job.layout.baselines[i]}-ascent`);
    });
  }
  const graph = `[0:v]${chain.join(',')},split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=sierra2_4a[o]`;
  const limit = job.animated ? ['-t', String(job.seconds)] : [];
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-filter_complex_threads', String(RENDER_THREADS),
    '-protocol_whitelist', 'file', '-max_pixels', String(MAX_PIXELS), '-threads', String(RENDER_THREADS),
    '-noautorotate', ...limit, '-f', DEMUXERS[job.type], '-i', job.input,
    '-filter_complex', graph, '-map', '[o]', '-an', '-sn', '-dn',
    ...(job.animated ? limit : ['-frames:v', '1']),
    '-fs', String(OUTPUT_STOP), '-loop', '0', '-f', 'gif', job.output,
  ];
}

export function parseDm(content) {
  const text = String(content ?? '').trim();
  const help = /^[/!]?studio(?:\s+help)?$/i.exec(text);
  if (help) return { kind: 'help', text: '' };
  const m = /^[/!]?(caption|gif)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!m) return null;
  return { kind: m[1].toLowerCase(), text: (m[2] || '').trim() };
}

function runProcess(bin, args, { cwd, timeoutMs, children = null }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    children?.add(child);
    try { if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { child.priorityKept = true; }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stderr?.on('data', (d) => { if (stderr.length < 4000) stderr += String(d).slice(0, 4000 - stderr.length); });
    child.on('error', (e) => { clearTimeout(timer); children?.delete(child); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      children?.delete(child);
      if (timedOut) { const e = new Error('ffmpeg timed out'); e.timedOut = true; reject(e); return; }
      if (code !== 0) { const e = new Error(`ffmpeg exited with ${code}`); e.stderr = stderr; reject(e); return; }
      resolve();
    });
  });
}

function probeBinary(bin) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['-version'], { shell: false, windowsHide: true, stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, PROBE_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

function findInTree(dir, depth) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.toLowerCase() === 'bin' && fs.existsSync(path.join(full, 'ffmpeg.exe'))) out.push(path.join(full, 'ffmpeg.exe'));
      else if (depth > 0) out.push(...findInTree(full, depth - 1));
    }
  }
  return out;
}

export function wingetCandidates(env = process.env) {
  const local = env.LOCALAPPDATA;
  if (!local) return [];
  const root = path.join(local, 'Microsoft', 'WinGet');
  const out = [];
  const link = path.join(root, 'Links', 'ffmpeg.exe');
  if (fs.existsSync(link)) out.push(link);
  let packages = [];
  try { packages = fs.readdirSync(path.join(root, 'Packages'), { withFileTypes: true }); } catch { packages = []; }
  for (const p of packages) {
    if (p.isDirectory() && /^gyan\.ffmpeg/i.test(p.name)) out.push(...findInTree(path.join(root, 'Packages', p.name), 3));
  }
  return out;
}

export async function findFfmpeg(env = process.env) {
  if (env.YAPOS_FFMPEG) return (await probeBinary(env.YAPOS_FFMPEG)) ? env.YAPOS_FFMPEG : null;
  if (await probeBinary('ffmpeg')) return 'ffmpeg';
  for (const candidate of wingetCandidates(env)) if (await probeBinary(candidate)) return candidate;
  return null;
}

const unreadable = () => friendly("That file doesn't look like a picture I can read. I work with PNG, JPG, GIF and WebP.", { title: "I couldn't read that picture" });
const tooHeavy = () => friendly('That picture is over 15 MB. Try a smaller one.', { title: 'That picture is too big' });

async function prepareJob({ dir, input, type, size, kind, text, fontFile, pass }) {
  const out = outputSize({ width: size.width, height: size.height, maxWidth: pass.maxWidth, minWidth: kind === 'caption' ? MIN_CAPTION_WIDTH : 0, maxArea: size.animated ? ANIMATED_AREA : Infinity });
  const job = {
    kind, type, dir, input,
    output: path.join(dir, `out-${pass.maxWidth}.gif`),
    outWidth: out.width, outHeight: out.height,
    orientation: size.orientation, animated: size.animated,
    fps: pass.fps, seconds: MAX_SECONDS, maxWidth: pass.maxWidth,
    fontFile: null, layout: null, lineFiles: [],
  };
  if (kind !== 'caption') return job;
  job.fontFile = fontFile;
  job.layout = wrapText(drawable(text, fontFile), { width: out.width, fontFile });
  for (const [i, line] of job.layout.lines.entries()) {
    const file = path.join(dir, `line-${pass.maxWidth}-${i}.txt`);
    await fsp.writeFile(file, line, { encoding: 'utf8', flag: 'wx' });
    job.lineFiles.push(file);
  }
  return job;
}

export async function sweepStale(tmpRoot = os.tmpdir(), now = Date.now(), maxAgeMs = STALE_MS) {
  let removed = 0;
  const entries = await fsp.readdir(tmpRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !STALE_NAME.test(entry.name)) continue;
    const full = path.join(tmpRoot, entry.name);
    const stat = await fsp.lstat(full).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < maxAgeMs) continue;
    await fsp.rm(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).then(() => { removed++; }, () => {});
  }
  return removed;
}

export async function renderImage({ renderer, kind, data, text = '', fontFile = null, tmpRoot = os.tmpdir(), onJob = null }) {
  const type = sniffImage(data);
  if (!type) throw unreadable();
  const size = imageSize(data, type);
  if (!size) throw unreadable();
  if (type === 'webp' && size.animated) throw friendly("I can't read animated WebP pictures yet. Send it as a GIF and I'll keep it moving.", { title: "I couldn't read that picture" });
  if (size.width > MAX_SIDE || size.height > MAX_SIDE) throw friendly(`That picture is ${size.width}×${size.height}. The most I can handle is ${MAX_SIDE}×${MAX_SIDE}.`, { title: 'That picture is too big' });
  const dir = await fsp.mkdtemp(path.join(tmpRoot, `yapos-studio-${randomBytes(8).toString('hex')}-`));
  try {
    const input = path.join(dir, `in.${type}`);
    await fsp.writeFile(input, data, { flag: 'wx' });
    for (const pass of PASSES) {
      const job = await prepareJob({ dir, input, type, size, kind, text, fontFile, pass });
      onJob?.(job);
      await renderer(job);
      const stat = await fsp.lstat(job.output).catch(() => null);
      if (!stat?.isFile() || !stat.size) throw new Error('the renderer made no output');
      if (stat.size > MAX_OUTPUT) continue;
      const out = await fsp.readFile(job.output);
      if (sniffImage(out) !== 'gif') throw new Error('the renderer output is not a GIF');
      return out;
    }
    throw friendly('Even shrunk down, that GIF comes out over 9.5 MB. Try a shorter or smaller picture.', { title: 'That GIF is too large' });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

const states = new WeakMap();
function stateOf(engine) {
  let st = states.get(engine);
  if (!st) {
    st = {
      fetch: (...a) => globalThis.fetch(...a),
      renderer: null, ffmpeg: null, probing: null, probedAt: 0, font: undefined,
      running: 0, waiting: [], users: new Map(), sends: [], sent: [], bursts: new Map(), jobs: new Set(), children: new Set(),
      limits: { downloadMs: DOWNLOAD_TIMEOUT_MS, renderMs: FFMPEG_TIMEOUT_MS },
      counts: { done: 0, failed: 0, refused: 0 },
    };
    states.set(engine, st);
  }
  return st;
}

function detect(engine) {
  const st = stateOf(engine);
  st.probedAt = Date.now();
  st.probing = findFfmpeg().then((found) => {
    const changed = found !== st.ffmpeg || !st.reported;
    st.ffmpeg = found;
    if (changed) {
      st.reported = true;
      if (found) engine.log.info(`[studio] ffmpeg is ready (${found})`);
      else engine.log.warn('[studio] ffmpeg was not found, so Studio cannot make GIFs. Install ffmpeg (or set YAPOS_FFMPEG to its path) and restart.');
    }
    return found;
  }).catch(() => null);
  return st.probing;
}

async function ffmpegReady(engine) {
  const st = stateOf(engine);
  if (st.renderer) return true;
  if (!st.probing) detect(engine);
  let found = await st.probing;
  if (!found && Date.now() - st.probedAt > REPROBE_MS) found = await detect(engine);
  return !!found;
}

function fontOf(st) {
  if (st.font === undefined || (st.font && !fs.existsSync(st.font))) st.font = findFont();
  return st.font;
}

async function readLimited(res, maxBytes, signal) {
  if (!res.body?.getReader) throw new Error('the download has no readable body');
  const reader = res.body.getReader();
  const stop = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error('the download was stopped');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('the download was stopped');
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooHeavy();
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
  }
  return Buffer.concat(chunks, total);
}

async function download(engine, url) {
  const st = stateOf(engine);
  const failed = () => friendly("I couldn't download that picture. Try sending it again.", { title: "I couldn't get the picture" });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), st.limits.downloadMs);
  const stopped = new Promise((_, reject) => { ac.signal.addEventListener('abort', () => reject(new Error('the download was stopped')), { once: true }); });
  stopped.catch(() => {});
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedUrl(current)) throw friendly("I only download pictures from Yapin' itself.", { title: "I couldn't get the picture" });
      const res = await Promise.race([st.fetch(current, { redirect: 'manual', signal: ac.signal, credentials: 'omit', referrerPolicy: 'no-referrer' }), stopped]);
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        res.body?.cancel?.().catch(() => {});
        if (!next) throw failed();
        current = new URL(next, current).href;
        continue;
      }
      if (!res.ok) throw failed();
      const declared = Number(res.headers.get('content-length'));
      if (declared > MAX_DOWNLOAD) throw tooHeavy();
      return await readLimited(res, MAX_DOWNLOAD, ac.signal);
    }
    throw failed();
  } catch (e) {
    if (e?.friendly) throw e;
    engine.log.debug('[studio] download failed', e?.message);
    if (ac.signal.aborted) throw friendly('Downloading that picture took too long. Try again in a moment.', { title: "I couldn't get the picture" });
    throw failed();
  } finally {
    clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
  }
}

function defaultRenderer(engine) {
  const st = stateOf(engine);
  return (job) => runProcess(st.ffmpeg, buildArgs(job), { cwd: job.dir, timeoutMs: st.limits.renderMs, children: st.children });
}

function renderProblem(engine, e) {
  if (e?.friendly) return e;
  engine.log.warn('[studio] render failed:', e?.message || e, e?.stderr ? `\n${String(e.stderr).trim()}` : '');
  if (e?.timedOut) return friendly('That one took too long to make, so I stopped. Try a smaller or shorter picture.', { title: 'That took too long' });
  if (e?.code === 'ENOENT') return friendly("My GIF maker (ffmpeg) isn't available right now. The bot's owner needs to install it.", { title: "Studio isn't ready" });
  return friendly("I couldn't turn that picture into a GIF. It may be damaged, or a kind I can't read. Try another one.", { title: "That didn't work" });
}

function produce(engine, { kind, data, text, tmpRoot, onJob }) {
  const st = stateOf(engine);
  return renderImage({ renderer: st.renderer || defaultRenderer(engine), kind, data, text, fontFile: kind === 'caption' ? fontOf(st) : null, tmpRoot, onJob });
}

function ownAttachments(src) {
  if (Array.isArray(src.attachments) && src.attachments.length) {
    return src.attachments.filter((a) => a?.path).map((a) => ({ path: a.path, name: a.name || null, size: a.size ?? null, width: a.width ?? null, height: a.height ?? null }));
  }
  if (typeof src.attachment === 'string' && src.attachment) return [{ path: src.attachment, name: null }];
  return [];
}

async function findImage(ctx) {
  const src = ctx.source;
  let list = ownAttachments(src);
  let replied = false;
  if (!list.length && src.reply_to_id && ctx.channelId) {
    replied = true;
    const target = await ctx.bot.message(ctx.channelId, src.reply_to_id).catch(() => null);
    if (target?.attachment_path) list = [{ path: target.attachment_path, name: target.attachment_name || null }];
  }
  const image = list.find((a) => IMAGE_TYPES.includes(extensionOf(a))) || list[0] || null;
  return { image, replied };
}

const howTo = (ctx) => (ctx.serverId ? HOW_SERVER : HOW_DM);

function howToCard() {
  const body = [
    'Turn a picture into a captioned GIF, or just into a GIF.',
    '',
    `**In a server:** ${HOW_SERVER}`,
    `**In my DMs:** ${HOW_DM}`,
    '',
    `-# ${HOW_LIMITS} Captions can be up to ${MAX_CAPTION} characters.`,
  ].join('\n');
  return card({ title: `${ICON} Studio`, body, color: 'games' });
}

const showHowTo = (ctx) => ctx.ephemeral({ embeds: [howToCard()] });

async function tell(ctx, err) {
  try {
    await ctx.warn(err.title || "Couldn't do that", err.message);
  } catch (e) {
    ctx.engine.log.debug('[studio] could not show a message', e?.message);
  }
}

function pump(st) {
  while (st.running < CONCURRENCY && st.waiting.length) {
    st.running++;
    st.waiting.shift()();
  }
}

function enqueue(st, task) {
  const position = st.running >= CONCURRENCY ? st.waiting.length + 1 : 0;
  const done = new Promise((resolve) => {
    st.waiting.push(() => {
      Promise.resolve().then(task).catch(() => {}).finally(() => {
        st.running--;
        resolve();
        pump(st);
      });
    });
  });
  st.jobs.add(done);
  done.finally(() => st.jobs.delete(done));
  pump(st);
  return { position, done };
}

function inWindow(list, now) {
  while (list.length && now - list[0] >= WINDOW_MS) list.shift();
  return list.length;
}

const sendsInWindow = (st, now) => inWindow(st.sends, now);

function pruneUsers(st, now) {
  if (st.users.size <= USER_LIMIT) return;
  for (const [k, u] of st.users) if (!u.busy && now - u.last > COOLDOWN_MS) st.users.delete(k);
}

function burst(st, userId, now) {
  if (st.bursts.size > USER_LIMIT) {
    for (const [k, b] of st.bursts) if (now - b.since >= BURST_MS) st.bursts.delete(k);
    if (st.bursts.size > USER_LIMIT) st.bursts.clear();
  }
  let b = st.bursts.get(userId);
  if (!b || now - b.since >= BURST_MS) { b = { since: now, count: 0 }; st.bursts.set(userId, b); }
  b.count++;
  return b.count - BURST_LIMIT;
}

const seconds = (ms) => { const s = Math.max(1, Math.ceil(ms / 1000)); return `${s} second${s === 1 ? '' : 's'}`; };
const atLimit = (list, now) => friendly(`Yapin' lets me send ${FILES_PER_MINUTE} files a minute and I've used them up. Try again in ${seconds(list[0] + WINDOW_MS - now)}.`, { title: 'The Studio is at its limit' });
const filesOff = () => friendly("Yapin' hasn't switched on file sending for bots here yet, so I can't send GIFs in this place. It works wherever Yapin' has turned it on.", { title: "I can't send files here yet" });

function refusal(engine, ctx, kind, image, caption) {
  const st = stateOf(engine);
  const now = Date.now();
  const ext = extensionOf(image);
  if (ext && !IMAGE_TYPES.includes(ext)) return friendly(`I can only work with pictures (PNG, JPG, GIF or WebP)${/^[a-z0-9]{1,8}$/.test(ext) ? `, not .${ext} files` : ''}.`, { title: "That isn't a picture" });
  if (Number(image.size) > MAX_DOWNLOAD) return tooHeavy();
  if (Number(image.width) > MAX_SIDE || Number(image.height) > MAX_SIDE) return friendly(`That picture is ${image.width}×${image.height}. The most I can handle is ${MAX_SIDE}×${MAX_SIDE}.`, { title: 'That picture is too big' });
  if (!attachmentUrl(image.path)) return friendly("I can't find where that picture lives. Try sending it again.", { title: "I couldn't get the picture" });
  if (kind === 'caption' && !caption.text) return friendly(`Tell me what to write. ${howTo(ctx)}`, { title: 'What should the caption say?' });
  if (kind === 'caption' && !drawable(caption.text, fontOf(st))) return friendly("My caption font can't write those characters (emoji and some alphabets are missing from it). Try plain letters and numbers.", { title: "I can't write that caption" });
  if (kind === 'caption' && !st.renderer && !fontOf(st)) return friendly("I don't have a font to write captions with. The bot's owner can point me at one by setting YAPOS_FONT to a .ttf file. `gif` still works.", { title: 'No caption font' });
  if (engine.caps.state(ctx.serverId, 'files') === false) return filesOff();
  const user = st.users.get(ctx.userId);
  if (user?.busy) return friendly("I'm still working on your last one. I'll take the next when it's done.", { title: 'One at a time' });
  if (user && now - user.last < COOLDOWN_MS) return friendly(`Give me ${seconds(COOLDOWN_MS - (now - user.last))} before the next one.`, { title: 'Just a moment' });
  if (sendsInWindow(st, now) >= FILES_PER_MINUTE) return atLimit(st.sends, now);
  if (inWindow(st.sent, now) >= FILES_PER_MINUTE) return atLimit(st.sent, now);
  if (st.waiting.length >= QUEUE_LIMIT) return friendly('The Studio is busy right now. Try again in a minute.', { title: 'The Studio is busy' });
  return null;
}

async function deliver(ctx, kind, data, note) {
  const { engine, serverId } = ctx;
  const st = stateOf(engine);
  const now = Date.now();
  if (inWindow(st.sent, now) >= FILES_PER_MINUTE) {
    await tell(ctx, atLimit(st.sent, now));
    return false;
  }
  st.sent.push(now);
  try {
    await ctx.reply({ content: note, files: [{ name: FILE_NAMES[kind], data }] });
    if (engine.caps.state(serverId, 'files') !== true) engine.caps.mark(serverId, 'files', true);
    return true;
  } catch (e) {
    engine.log.debug('[studio] sending the file failed', e?.message);
    if (looksLikeFeatureOff(e)) {
      engine.caps.mark(serverId, 'files', false, e?.message);
      await tell(ctx, filesOff());
    } else if (e?.status === 400) {
      await tell(ctx, friendly("Yapin' didn't accept the GIF I made. Try another picture.", { title: "I couldn't send the GIF" }));
    } else {
      await ctx.fail(e, { action: 'send the GIF', target: 'here', perm: 'attach_files' });
    }
    return false;
  }
}

async function work(ctx, kind, image, caption) {
  const { engine } = ctx;
  const st = stateOf(engine);
  let ok = false;
  try {
    const data = await download(engine, attachmentUrl(image.path));
    let gif;
    try {
      gif = await produce(engine, { kind, data, text: caption.text });
    } catch (e) {
      throw renderProblem(engine, e);
    }
    ok = await deliver(ctx, kind, gif, caption.trimmed ? `I trimmed your caption to ${MAX_CAPTION} characters.` : '');
  } catch (e) {
    if (e?.friendly) await tell(ctx, e);
    else await ctx.fail(e);
  } finally {
    st.counts[ok ? 'done' : 'failed']++;
    st.users.set(ctx.userId, { busy: false, last: Date.now() });
  }
}

async function request(ctx, kind, rawText) {
  const { engine } = ctx;
  const st = stateOf(engine);
  if (ctx.kind === 'command') {
    return ctx.info(kind === 'caption' ? 'How to caption a picture' : 'How to make a GIF', `Commands picked from the / menu can't carry a picture, so type it in chat instead.\n${HOW_SERVER}\n\n-# ${HOW_LIMITS}`);
  }
  const over = burst(st, ctx.userId, Date.now());
  if (over > 0) {
    st.counts.refused++;
    if (over === 1) await tell(ctx, friendly("You're sending these faster than I can keep up. Give me a few seconds.", { title: 'Slow down a little' }));
    return null;
  }
  const { image, replied } = await findImage(ctx);
  if (!image) {
    const title = replied ? 'That message has no picture' : 'I need a picture';
    return tell(ctx, friendly(`${howTo(ctx)}\n\n-# ${HOW_LIMITS}`, { title }));
  }
  if (!(await ffmpegReady(engine))) {
    st.counts.refused++;
    return tell(ctx, friendly("Studio needs a program called ffmpeg, and it isn't installed on the computer I run on. The bot's owner needs to install ffmpeg and restart me.", { title: "Studio isn't ready" }));
  }
  const caption = kind === 'caption' ? cleanCaption(rawText) : { text: '', trimmed: false };
  const problem = refusal(engine, ctx, kind, image, caption);
  if (problem) {
    st.counts.refused++;
    return tell(ctx, problem);
  }
  const now = Date.now();
  pruneUsers(st, now);
  st.sends.push(now);
  st.users.set(ctx.userId, { busy: true, last: now });
  const { position } = enqueue(st, () => work(ctx, kind, image, caption));
  if (position > 0) await ctx.ephemeral(`${ICON} You're #${position} in line. I'll send your GIF as soon as it's ready.`).catch(() => {});
  return null;
}

async function runDm(ctx, msg) {
  const parsed = parseDm(msg.content);
  if (!parsed || parsed.kind === 'help') return showHowTo(ctx);
  return request(ctx, parsed.kind, parsed.text);
}

async function idle(st) {
  while (st.jobs.size) await Promise.allSettled([...st.jobs]);
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Studio',
  icon: ICON,
  description: 'Turn pictures into captioned GIFs.',
  category: 'Fun',
  defaultEnabled: true,

  commands: {
    caption: { description: 'Caption a picture as a GIF: type !caption your text with a picture, or reply to one', run: (ctx) => request(ctx, 'caption', ctx.args) },
    gif: { description: 'Turn a picture into a GIF: type !gif with a picture attached, or reply to one', run: (ctx) => request(ctx, 'gif', '') },
  },

  dm: {
    match: (msg) => !!parseDm(msg?.content),
    run: runDm,
  },

  yap: [
    { words: ['caption', 'meme'], run: (ctx) => request(ctx, 'caption', ctx.args) },
    { words: ['gif'], run: (ctx) => request(ctx, 'gif', '') },
    { words: ['studio'], run: showHowTo },
  ],

  panel: showHowTo,

  services: (engine) => {
    const st = stateOf(engine);
    return {
      setFetch: (fn) => { st.fetch = fn || ((...a) => globalThis.fetch(...a)); },
      setRenderer: (fn) => { st.renderer = fn || null; },
      wrapText: (text, opts = {}) => wrapText(text, { fontFile: fontOf(st), ...opts }),
      buildArgs,
      stats: () => ({
        running: st.running, waiting: st.waiting.length, ...st.counts,
        filesLastMinute: sendsInWindow(st, Date.now()), sentLastMinute: inWindow(st.sent, Date.now()), processes: st.children.size, ffmpeg: st.ffmpeg, font: fontOf(st),
      }),
      ready: () => ffmpegReady(engine),
      setLimits: (limits = {}) => { st.limits = { downloadMs: DOWNLOAD_TIMEOUT_MS, renderMs: FFMPEG_TIMEOUT_MS, ...limits }; },
      sweep: (tmpRoot, now, maxAgeMs) => sweepStale(tmpRoot, now, maxAgeMs),
      produce: (job) => produce(engine, job),
      idle: () => idle(st),
    };
  },

  help: [
    'Type !caption your text with a picture attached, or as a reply to a picture. !gif just converts it.',
    'In my DMs: send a picture with "caption your text" or "gif".',
    `${HOW_LIMITS} One GIF at a time per person.`,
  ],

  init: (engine) => {
    detect(engine);
    sweepStale().then((removed) => { if (removed) engine.log.info(`[studio] cleared ${removed} leftover work folder${removed === 1 ? '' : 's'}`); }).catch(() => {});
  },
  dispose: (engine) => {
    const st = states.get(engine);
    if (st) for (const child of st.children) { try { child.kill('SIGKILL'); } catch { st.children.delete(child); } }
    states.delete(engine);
  },
});

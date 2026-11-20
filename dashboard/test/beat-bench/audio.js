import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function hasFfmpeg() {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export function writeWav(file, pcm, sr) {
  const n = pcm.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  writeFileSync(file, buf);
}

export function readWav(file) {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`not a wav: ${file}`);
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(body + 2), sr: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new Error(`only 16-bit wav is supported: ${file}`);
      const frames = Math.floor(size / (2 * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let v = 0;
        for (let c = 0; c < fmt.channels; c++) v += buf.readInt16LE(body + (i * fmt.channels + c) * 2) / 32768;
        out[i] = v / fmt.channels;
      }
      return { pcm: out, sampleRate: fmt.sr };
    }
    off = body + size + (size % 2);
  }
  throw new Error(`no data chunk: ${file}`);
}

export function encode(wav, out, format) {
  const args = format === 'mp3' ? ['-codec:a', 'libmp3lame', '-b:a', '192k'] : ['-codec:a', 'libvorbis', '-q:a', '5'];
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, ...args, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${out}: ${r.stderr}`);
}

export function decode(file, sr = 44100) {
  if (file.endsWith('.wav')) return readWav(file);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(sr), '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${r.stderr}`);
  const b = r.stdout;
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return { pcm: new Float32Array(ab), sampleRate: sr };
}

export function pickAudio(base, format) {
  const order = format ? [format] : ['mp3', 'ogg', 'wav'];
  for (const f of order) {
    const file = `${base}.${f}`;
    if (!existsSync(file)) continue;
    if (f !== 'wav' && !hasFfmpeg()) continue;
    return file;
  }
  return null;
}

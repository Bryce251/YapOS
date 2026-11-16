import { cachedPack, loadPack, cleanPackCode, PACK_CODE_MAX, PACK_CODE_MIN } from '../admin.js';

export const PACK_STEP_MS = 300;
export const PACK_WAIT_MS = 6000;
export const PACK_WORD_CHARS = 30;
export const PACK_EMOJI = '📦';

const WORD_RE = /^[A-Za-z][A-Za-z' -]*[A-Za-z]$/;

export function packSetting() {
  return { id: 'pack', label: 'Word pack code', type: 'code', max: PACK_CODE_MAX, placeholder: 'Optional', options: [], default: '' };
}

export function packCode(settings) {
  return cleanPackCode(settings && typeof settings.pack === 'string' ? settings.pack : '');
}

export function packStep(api, code) {
  if (!code) return { state: 'none' };
  if (code.length < PACK_CODE_MIN) return { state: 'fail', code };
  const hit = cachedPack(code);
  if (hit) return { state: 'ready', code, pack: hit };
  const mem = api.memory;
  let job = mem.packJob;
  if (!job || job.code !== code) {
    job = { code, since: api.now(), done: false, pack: null };
    mem.packJob = job;
    Promise.resolve()
      .then(() => loadPack(code))
      .then(
        (p) => {
          job.done = true;
          job.pack = p || null;
        },
        () => {
          job.done = true;
        },
      );
  }
  if (job.done) return job.pack ? { state: 'ready', code, pack: job.pack } : { state: 'fail', code };
  if (api.now() - job.since >= PACK_WAIT_MS) return { state: 'fail', code };
  return { state: 'wait', code };
}

export function packFor(api, code) {
  if (!code) return null;
  const mem = api.memory;
  if (mem.pack && mem.pack.code === code) return mem.pack;
  const hit = cachedPack(code);
  if (hit) {
    mem.pack = hit;
    return hit;
  }
  if (!mem.packRetry) {
    mem.packRetry = true;
    Promise.resolve()
      .then(() => loadPack(code))
      .then(
        (p) => {
          if (p && !mem.pack) mem.pack = p;
        },
        () => {},
      );
  }
  return null;
}

export function drawablePackWords(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue;
    const w = raw.replace(/\s+/g, ' ').trim();
    if (!w || w.length > PACK_WORD_CHARS || !WORD_RE.test(w)) continue;
    const key = w.toLowerCase().replace(/[^a-z]/g, '');
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

export function packTrivia(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || typeof t !== 'object' || typeof t.q !== 'string' || typeof t.a !== 'string' || !Array.isArray(t.w)) continue;
    const w = t.w.filter((x) => typeof x === 'string' && x).slice(0, 3);
    const all = new Set([t.a.toLowerCase(), ...w.map((x) => x.toLowerCase())]);
    if (!t.q || !t.a || w.length < 3 || all.size < 4) continue;
    out.push({ q: t.q, a: t.a, w });
  }
  return out;
}

function stream(nonce) {
  let s = ((nonce >>> 0) ^ 0x5bd1e995) >>> 0 || 1;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s >>> 8) & 0xffff;
  };
}

export function hideWord(word, nonce) {
  const next = stream(nonce);
  let out = '';
  for (const ch of String(word)) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) continue;
    out += (code ^ next()).toString(16).padStart(4, '0');
  }
  return out;
}

export function showWord(code, nonce) {
  if (typeof code !== 'string' || !code || code.length % 4 !== 0 || !/^[0-9a-f]+$/.test(code)) return null;
  const next = stream(nonce);
  let out = '';
  for (let i = 0; i < code.length; i += 4) out += String.fromCharCode(parseInt(code.slice(i, i + 4), 16) ^ next());
  return out;
}

export function packNoteText(pk, miss, what = 'words') {
  if (pk && pk.n) return `${PACK_EMOJI} ${pk.n}`;
  if (miss) return `${PACK_EMOJI} Couldn't find word pack ${miss}, so we're using the built-in ${what}.`;
  return '';
}

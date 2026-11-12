import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = '.yapos-probe.json';

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const test = path.join(dir, `.yapos-write-${process.pid}`);
    fs.writeFileSync(test, 'ok');
    fs.rmSync(test, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.code || e?.message || 'unknown' };
  }
}

export function pickDataDir(config, root) {
  const wanted = config.dataPath;
  const first = writable(wanted);
  if (first.ok) return { path: wanted, fellBack: false };
  const fallback = path.join(root, 'data');
  if (path.resolve(fallback) !== path.resolve(wanted) && writable(fallback).ok) {
    return { path: fallback, fellBack: true, wanted, error: first.error };
  }
  return { path: wanted, fellBack: false, error: first.error };
}

export function storageCandidates(root, env = process.env) {
  const list = [
    path.join(root, 'data'),
    path.dirname(root),
    os.homedir(),
    env.HOME,
    '/data',
    '/persist',
    '/storage',
    '/var/data',
    '/mnt/data',
    os.tmpdir(),
  ].filter(Boolean).map((p) => path.resolve(p));
  return [...new Set(list)];
}

export function probeStorage(root, { now = Date.now(), env = process.env, candidates = storageCandidates(root, env) } = {}) {
  const out = [];
  for (const dir of candidates) {
    let exists = false;
    try { exists = fs.statSync(dir).isDirectory(); } catch {}
    if (!exists) { out.push({ dir, state: 'missing' }); continue; }
    const file = path.join(dir, MARKER);
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const next = { first: Number(prev?.first) || now, starts: (Number(prev?.starts) || 0) + 1, root };
    try {
      fs.writeFileSync(file, JSON.stringify(next));
      out.push({ dir, state: 'writable', starts: next.starts, first: next.first, kept: !!prev });
    } catch (e) {
      out.push({ dir, state: prev ? 'read-only, has marker' : 'read-only', error: e?.code });
    }
  }
  return out;
}

export function describeProbe(results, now = Date.now()) {
  const parts = results.filter((r) => r.state !== 'missing').map((r) => {
    if (r.state !== 'writable') return `${r.dir} (${r.state})`;
    const age = Math.max(0, Math.round((now - r.first) / 60_000));
    return `${r.dir} (writable, start ${r.starts}, first seen ${age} min ago)`;
  });
  return `storage check: ${parts.join(' · ') || 'no folders found'}`;
}

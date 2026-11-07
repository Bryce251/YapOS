import { redact } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger({ level = process.env.YAPOS_LOG || 'info', sink = null } = {}) {
  let min = LEVELS[level] ?? 20;
  const seenOnce = new Set();
  const out = (lvl, args) => {
    if (LEVELS[lvl] < min) return;
    const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
    const line = `[${new Date().toISOString().slice(11, 19)}] ${lvl.toUpperCase().padEnd(5)} ${redact(text)}`;
    if (sink) sink(lvl, line);
    else (lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(line);
  };
  return {
    debug: (...a) => out('debug', a),
    info: (...a) => out('info', a),
    warn: (...a) => out('warn', a),
    error: (...a) => out('error', a),
    once: (key, ...a) => { if (seenOnce.has(key)) return; seenOnce.add(key); out('info', a); },
    setLevel: (l) => { min = LEVELS[l] ?? min; },
  };
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

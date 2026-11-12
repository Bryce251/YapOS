import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { redact } from './config.js';

const MAX_BYTES = 5 * 1024 * 1024;

export function teeConsoleToFile(dir, { maxBytes = MAX_BYTES } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'yapos.log');
  const old = path.join(dir, 'yapos.old.log');
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}

  const write = (level, args) => {
    let line = redact(format(...args));
    if (!/^\[\d\d:\d\d:\d\d\]/.test(line)) line = `[${new Date().toISOString().slice(11, 19)}] ${level.padEnd(5)} ${line}`;
    const text = `${new Date().toISOString().slice(0, 10)} ${line}\n`;
    try {
      if (size + text.length > maxBytes) {
        try { fs.rmSync(old, { force: true }); fs.renameSync(file, old); } catch {}
        size = 0;
      }
      fs.appendFileSync(file, text, 'utf8');
      size += Buffer.byteLength(text);
    } catch {}
  };

  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      write(level, args);
    };
  }
  write('INFO', [`---- YapOS starting (pid ${process.pid}) ----`]);
  return file;
}

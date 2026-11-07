import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VERSION = { number: '1.0', name: 'Boot', full: "YapOS 1.0 'Boot'" };

const DEFAULTS = { token: '', verified: false, ownerId: '', dataDir: 'data', gateway: true };

export function loadConfig({ root = ROOT, env = process.env } = {}) {
  let file = {};
  const p = path.join(root, 'config.json');
  if (fs.existsSync(p)) {
    try {
      file = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`config.json isn't valid JSON (${e.message}). Fix it or delete it and use YAPPER_BOT_TOKEN.`);
    }
  }
  const cfg = { ...DEFAULTS, ...file };
  if (env.YAPPER_BOT_TOKEN) cfg.token = env.YAPPER_BOT_TOKEN.trim();
  if (env.YAPOS_VERIFIED) cfg.verified = /^(1|true|yes)$/i.test(env.YAPOS_VERIFIED);
  if (env.YAPOS_OWNER_ID) cfg.ownerId = env.YAPOS_OWNER_ID.trim();
  if (env.YAPOS_DATA_DIR) cfg.dataDir = env.YAPOS_DATA_DIR;
  if (env.YAPOS_GATEWAY) cfg.gateway = !/^(0|false|no|off)$/i.test(env.YAPOS_GATEWAY);
  cfg.dataPath = path.isAbsolute(cfg.dataDir) ? cfg.dataDir : path.join(root, cfg.dataDir);
  if (cfg.token && cfg.token.startsWith('yb_paste')) cfg.token = '';
  return cfg;
}

export function redact(text) {
  return String(text)
    .replace(/yb_[A-Za-z0-9_\-.]+/g, 'yb_[hidden]')
    .replace(/yo_[A-Za-z0-9_\-.]{8,}/g, 'yo_[hidden]')
    .replace(/(\/interactions\/[^/\s]+\/)[^/\s]+/g, '$1[hidden]')
    .replace(/(\/api\/webhooks\/[^/\s]+\/)[^/\s?]+/g, '$1[hidden]');
}

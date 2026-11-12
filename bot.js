import { Bot } from './engine/sdk.js';
import { loadConfig, VERSION } from './engine/config.js';
import { createLogger } from './engine/log.js';
import { createJsonStore, flushOnExit } from './engine/storage.js';
import { createBackups } from './engine/backup.js';
import { createEngine } from './engine/index.js';
import { takeLock } from './engine/lock.js';
import { teeConsoleToFile } from './engine/logfile.js';
import path from 'node:path';

const config = loadConfig();
teeConsoleToFile(path.join(config.dataPath, 'logs'));
const log = createLogger();

if (!config.token) {
  log.error('No bot token found. Set YAPPER_BOT_TOKEN, or copy config.example.json to config.json and paste your token there.');
  process.exit(2);
}

const lock = await takeLock().catch((e) => {
  log.warn(`couldn't check for another running copy (${e.message}); starting anyway`);
  return { ok: true };
});
if (!lock.ok) {
  log.error('YapOS is already running in another window. Only one copy can run at a time, or every command would be answered twice.');
  process.exit(3);
}

const store = createJsonStore({ dir: config.dataPath, log });
flushOnExit(store, log);
createBackups({ dir: config.dataPath, store, log }).start();

const bot = new Bot(config.token, { gateway: config.gateway ? undefined : false });
const engine = createEngine({ bot, config, store, log });

process.on('unhandledRejection', (e) => log.error('unhandled rejection:', e));

bot.on('ready', (me) => {
  log.info(`${VERSION.full} is online as ${me.username}`);
  bot.setStatus('online', 'Type /menu').catch(() => {});
});

let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

await engine.load();
try {
  await bot.start();
} catch (e) {
  if (e?.status !== 401) throw e;
}
if (!stopping) {
  log.error('Yapin\' rejected the bot token. Make a new one in Settings → Developer → your bot → Token and put it in config.json.');
  await store.flush().catch(() => {});
  process.exit(2);
}

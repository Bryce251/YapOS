import { Bot } from './engine/sdk.js';
import { loadConfig, VERSION } from './engine/config.js';
import { createLogger } from './engine/log.js';
import { createJsonStore, flushOnExit } from './engine/storage.js';
import { createEngine } from './engine/index.js';

const log = createLogger();
const config = loadConfig();

if (!config.token) {
  log.error('No bot token found. Set YAPPER_BOT_TOKEN, or copy config.example.json to config.json and paste your token there.');
  process.exit(2);
}

const store = createJsonStore({ dir: config.dataPath, log });
flushOnExit(store, log);

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

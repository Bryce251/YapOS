import { Bot } from './engine/sdk.js';
import { loadConfig, VERSION } from './engine/config.js';
import { createLogger } from './engine/log.js';
import { createJsonStore, flushOnExit } from './engine/storage.js';
import { createEngine } from './engine/index.js';

const log = createLogger();
const config = loadConfig();

if (!config.token) {
  log.error('No bot token found. Set YAPPER_BOT_TOKEN, or copy config.example.json to config.json and paste your token there.');
  process.exit(1);
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

await engine.load();
await bot.start();

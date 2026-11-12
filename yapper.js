// @ts-self-types="./yapper.d.ts"
/**
 * Yapin’ bot SDK, one file, no dependencies. Node 18+, Bun and Deno.
 *
 *   import { Bot } from './yapper.js';
 *   const bot = new Bot(process.env.YAPPER_BOT_TOKEN);
 *   bot.command('ping', 'Check the bot is alive', (msg) => msg.reply('pong'));
 *   bot.on('message', (msg) => { if (msg.mentioned) msg.reply('hi!'); });
 *   bot.on('member_join', async (ev) => {
 *     const [general] = await bot.channels(ev.server_id, { type: 'text' });   // member events have no channel
 *     if (general) bot.send(general.id, `welcome <@${ev.user_id}>`);
 *   });
 *   bot.command('info', 'A card', (msg) => msg.reply('', { embeds: [new Embed().title('Hi').description('**Embeds** work').color('#5865f2')] }));
 *   bot.command('vote', 'Buttons', (msg) => msg.reply('Pizza?', { components: [new Row(Button.success('Yes', 'vote:yes'), Button.danger('No', 'vote:no'))] }));
 *   bot.onButton(/^vote:/, (i) => i.ephemeral(`You picked ${i.custom_id.slice(5)}`));
 *   await bot.loadCogs('./cogs');   // optional: more commands from cogs/*.js (see Cog below)
 *   bot.start();
 *
 * Nothing to host: the bot fetches its own events from Yapin’ (long polling), so it runs on your PC.
 * Verified bots can also run on Yapin’s bot hosting, which passes the token in process.env.YAPPER_BOT_TOKEN.
 * Docs: https://www.yapin.gg/developers
 */
/** SDK version, stamped from public/sdk/version.json by scripts/sdk-build.mjs (same as the npm package "yapin"). */
export const VERSION = '1.7.0';
/** Embeds, buttons and rows can be builders or plain objects. */
/** Message flag for Components V2 layouts (IS_COMPONENTS_V2, 1 << 15). */
export const IS_COMPONENTS_V2 = 1 << 15;

// ---- what is this? Every object from the API and gateway has "object": 'user', 'channel', 'role' … ----
const isKind = (x, kind) => !!x && typeof x === 'object' && x.object === kind;
/** A user (or bot) profile. */
export function isUser(x) { return isKind(x, 'user'); }
/** A server member (a profile with nickname, roles, joined_at). */
export function isMember(x) { return isKind(x, 'member'); }
/** A server. */
export function isServer(x) { return isKind(x, 'server'); }
/** A text or voice channel. */
export function isChannel(x) { return isKind(x, 'channel'); }
/** A thread or forum post. */
export function isThread(x) { return isKind(x, 'thread'); }
/** A category. */
export function isCategory(x) { return isKind(x, 'category'); }
/** A role. */
export function isRole(x) { return isKind(x, 'role'); }
/** A message. */
export function isMessage(x) { return isKind(x, 'message'); }
const plain = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
const list = (v) => (v === undefined ? undefined : v === null ? null : [].concat(v).map(plain));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isForm = (b) => typeof FormData !== 'undefined' && b instanceof FormData;
/** One file for send({ files }): a path (Node), a Blob/File, or { name, data } with bytes, a Blob or a string. */
async function filePart(f) {
  if (typeof f === 'string') {
    const fs = await import('node:fs/promises');
    return { name: f.split(/[\\/]/).pop(), blob: new Blob([await fs.readFile(f)]) };
  }
  if (typeof Blob !== 'undefined' && f instanceof Blob) return { name: f.name || 'file', blob: f };
  if (f && typeof f === 'object' && typeof f.name === 'string' && f.data != null) {
    return { name: f.name, blob: f.data instanceof Blob ? f.data : new Blob([f.data], f.type ? { type: f.type } : {}) };
  }
  throw new Error('A file is a path, a Blob/File, or { name: "card.png", data: bytes }');
}
/** `{ messages, authors }` from the API → the messages, each with its `author` (null if the account is gone). */
const withAuthors = (out) => {
  const by = new Map((out.authors || []).map((a) => [a.id, a]));
  return (out.messages || []).map((m) => ({ ...m, author: by.get(m.author_id) ?? null }));
};
/** a > b for "1.10.0" style versions. */
const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
let versionChecked = false;
/**
 * Once per process: one line when the server knows a newer SDK (GET /version, no token). Never throws, never waits
 * for the bot. YAPPER_NO_UPDATE_CHECK=1 (or log: false) turns it off.
 */
async function checkVersion(base, log) {
  if (versionChecked || !log || globalThis.process?.env?.YAPPER_NO_UPDATE_CHECK) return;
  versionChecked = true;
  try {
    const res = await fetch(`${base}/version`, { headers: { 'user-agent': `yapper-sdk/${VERSION}` }, signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined });
    const latest = res.ok ? (await res.json())?.sdk?.js : null;
    if (typeof latest === 'string' && newer(latest, VERSION)) console.warn(`[yapper] SDK ${VERSION} is behind the latest ${latest}: npm install yapin@latest, or download https://www.yapin.gg/sdk/yapper.js again`);
  } catch { /* offline or an older server: no warning */ }
}
/** Wait before retry number n (1, 2, …): 1s, 2s, 4s … up to 30s, with some jitter so many bots don't sync up. */
const backoff = (n) => Math.min(30_000, 1000 * 2 ** (n - 1)) * (0.75 + Math.random() * 0.5);
/**
 * Encrypted calls (connectVoice): the bot's half of the app's key handoff. Our P-256 public key goes in the
 * participant attribute `e2ee`; everyone who has one gets our media key over the data channel (topic yapper-e2ee),
 * sealed with AES-GCM under the ECDH secret the two of us share and bound to "<from>|<to>|<index>". The bot hears
 * nobody, so it never needs anyone's key back, only to answer when someone sends theirs (they may have missed ours).
 */
async function handOutVoiceKey(room, subtle, mediaKey) {
  const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const me = room.localParticipant.identity;
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  const myPub = b64(await subtle.exportKey('raw', pair.publicKey));
  const shared = new Map();
  const sent = new Map();
  let stopped = false;
  const sendTo = async (p, pub) => {
    const theirPub = p?.attributes?.e2ee || pub;
    if (stopped || !theirPub || p.identity === me || sent.get(p.identity) === theirPub) return;
    sent.set(p.identity, theirPub);
    try {
      let k = shared.get(theirPub);
      if (!k) {
        const their = await subtle.importKey('raw', unb64(theirPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        k = await subtle.deriveKey({ name: 'ECDH', public: their }, pair.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
        shared.set(theirPub, k);
      }
      const iv = (globalThis.crypto ?? (await import('node:crypto')).webcrypto).getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${me}|${p.identity}|0`) }, k, mediaKey);
      const msg = JSON.stringify({ i: 0, iv: b64(iv), ct: b64(ct), k: myPub });
      await room.localParticipant.publishData(new TextEncoder().encode(msg), { reliable: true, topic: 'yapper-e2ee', destination_identities: [p.identity] });
    } catch {
      sent.delete(p.identity); // muted by a moderator (no data permission) or a bad key: try again on the next change
    }
  };
  const onPeer = (p) => { void sendTo(p); };
  const onAttrs = (_changed, p) => { void sendTo(p); };
  const onData = (payload, who, _kind, topic) => {
    if (topic !== 'yapper-e2ee' || !who) return;
    try { const m = JSON.parse(new TextDecoder().decode(payload)); if (typeof m.k === 'string') { sent.delete(who.identity); void sendTo(who, m.k); } } catch { /* not ours */ }
  };
  room.on('participantConnected', onPeer).on('participantAttributesChanged', onAttrs).on('dataReceived', onData);
  await room.localParticipant.setAttributes({ e2ee: myPub });
  for (const p of room.remoteParticipants.values()) void sendTo(p);
  return {
    stop() {
      stopped = true;
      room.off('participantConnected', onPeer).off('participantAttributesChanged', onAttrs).off('dataReceived', onData);
    },
  };
}
/** A class made with `extends Cog` (not Cog itself). Checked by a flag, so a second copy of yapper.js still works. */
const isCogClass = (c) => typeof c === 'function' && c.yapperCog === true && !Object.hasOwn(c, 'yapperCog');
/** Marks an error with the cog (and command or event) it came from, so the log says where it broke. */
const tagError = (e, owner, where) => {
  const err = e instanceof Error ? e : new Error(String(e));
  if (err.cog === undefined) { try { err.cog = owner.name; if (where) err.where = where; } catch { /* frozen error */ } }
  return err;
};
/** Runs fn with `self` as this and tags anything it throws with the cog. */
const tagged = (owner, fn, self, where) => async (x) => { try { return await fn.call(self, x); } catch (e) { throw tagError(e, owner, where); } };
const COMMAND_LIMIT = 100;

/**
 * Finds a cog file or folder. Relative paths are tried next to your main file first (the one you ran with
 * `node bot.js`), then in the folder you ran node in. Also takes absolute paths and file:// URLs.
 * Returns { abs, url, label }; url is what import() wants, also on Windows.
 */
async function locate(target) {
  const [{ pathToFileURL, fileURLToPath }, path, fs] = await Promise.all([import('node:url'), import('node:path'), import('node:fs')]);
  const raw = target instanceof URL ? target.href : String(target ?? '');
  let tries;
  if (/^file:/i.test(raw)) tries = [fileURLToPath(raw)];
  else if (path.isAbsolute(raw)) tries = [raw];
  else {
    const main = typeof process !== 'undefined' && process.argv?.[1] ? path.dirname(path.resolve(process.argv[1])) : null;
    tries = [...new Set([main && path.resolve(main, raw), path.resolve(process.cwd(), raw)].filter(Boolean))];
  }
  // 'cogs/fun' works too: try .js and .mjs.
  const found = tries.flatMap((p) => (/\.m?js$/i.test(p) ? [p] : [p, `${p}.js`, `${p}.mjs`])).find((p) => fs.existsSync(p));
  if (!found) throw new Error(`Can't find ${raw} (looked at ${tries.join(' and ')})`);
  const rel = path.relative(process.cwd(), found);
  const label = (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : found).split(path.sep).join('/');
  return { abs: found, url: pathToFileURL(found).href, label };
}

export class Bot {
  /**
   * @param {string} token from Settings → Developer
   * @param {{ base?: string, gateway?: string | false, prefixes?: string[], log?: boolean, ignoreBots?: boolean }} [opts]
   *   `ignoreBots` (default true): skip messages from other bots and webhooks (`msg.author_bot`), so two bots can't
   *   reply to each other forever. Pass false to get them too.
   *   `gateway`: where events come from over a WebSocket (default wss://rt.yapper.website/bot). Used when the runtime
   *   has WebSocket built in (Node 22+, Bun, Deno) and the gateway is on for this bot; otherwise, or if the socket
   *   keeps failing, events come from the long poll as before. Pass false to always long-poll.
   */
  constructor(token, opts = {}) {
    if (!token || !String(token).startsWith('yb_')) throw new Error('Pass your bot token (starts with yb_). Get one in Settings → Developer.');
    this.token = String(token).trim();
    // YAPPER_API_URL: set by bot hosting (usable anywhere) to point at another API host. The default is our own API
    // host; if it can't be reached the SDK uses the website's address for 10 minutes (same API, same token).
    const chosen = opts.base || globalThis.process?.env?.YAPPER_API_URL;
    this.base = (chosen || 'https://bots.yapper.website/api/bot/v1').replace(/\/$/, '');
    // Hosted bots get our host through YAPPER_API_URL: they keep the fallback too; any other chosen base doesn't.
    this._fallback = chosen && this.base !== 'https://bots.yapper.website/api/bot/v1' ? null : 'https://www.yapin.gg/api/bot/v1';
    this._fallbackUntil = 0;
    this.gateway = opts.gateway === false || typeof globalThis.WebSocket !== 'function' ? null : (opts.gateway || 'wss://rt.yapper.website/bot');
    this.prefixes = opts.prefixes || ['/', '!'];
    this.log = opts.log !== false;
    // Most seconds one call spends waiting out 429s / "busy" 503s in total before it throws (err.retryAfter says how
    // long was left). Three 10 s waits with 50% jitter used to hold an edit for up to 45 s.
    this.maxRetryWait = Number.isFinite(opts.maxRetryWait) ? Math.max(0, opts.maxRetryWait) : 30;
    this._cfWarned = false;
    this.ignoreBots = opts.ignoreBots !== false;
    this.handlers = {};
    this.commands = new Map();
    this.buttons = [];
    this.last = 0;
    this.running = false;
    this.me = null;
    /** Loaded cogs by name ('fun' for cogs/fun.js). */
    this.cogs = new Map();
    this._pending = new Set();
    this._registered = false;
    this._dirty = false;
    this._syncTimer = null;
    this._version = 0;
    this._ws = null;
    this._gwRequests = false;
    this._gwPending = new Map();
    this._gwNext = 0;
  }

  /**
   * Listen for an event: "message", "command", "dm_message", "member_join", "member_leave", "reaction_add", "reaction_remove",
   * "voice_join", "voice_leave", "invite_create", "invite_delete", "interaction", "channel_create", "channel_update",
   * "channel_delete", "thread_create", "thread_update", "thread_delete", "category_create", "category_update",
   * "category_delete", "test", "ready", "error".
   * Channel, thread and category events are in testing (flag bot_api_round2): their data is the channel object.
   * member_join also has invite_code and inviter_id when known (bots with Manage Server).
   * dm_message is someone DMing the bot: a message with msg.reply / msg.say that answer in the DM, and msg.dm = true.
   */
  on(event, fn) { (this.handlers[event] ||= []).push(fn); return this; }

  /**
   * Someone DMed the bot: `bot.onDm((msg) => msg.reply('hi!'))`. msg has id, channel_id (the DM), author_id, author,
   * content, attachment / attachments, reply_to_id, created_at, is_dm (true), dm_channel_id. Only DMs with this bot ever come in. Same as on('dm_message').
   */
  onDm(fn) { return this.on('dm_message', fn); }

  /**
   * Someone reacted to a message this bot sent (in a server channel it can see, or in its DMs), or took the reaction off:
   * `bot.onReactionOnMine((r) => r.added && r.emoji === '👍' && …)`. r has message_id, channel_id, server_id (null in a DM),
   * user_id, username, emoji, added (true for reaction_add, false for reaction_remove), is_dm and dm_channel_id (in a DM) and type.
   */
  onReactionOnMine(fn) { const w = mineOnly(this, fn); return this.on('reaction_add', w).on('reaction_remove', w); }

  /** Register a command. People type /name or !name; the composer suggests it. */
  command(name, description, fn) { return this.#addCommand(name, description, fn, null, null); }

  #addCommand(name, description, fn, owner, check) {
    if (typeof description === 'function') { fn = description; description = ''; }
    const n = String(name).toLowerCase().replace(/^[/!]/, '');
    if (!/^[a-z0-9_-]{1,32}$/.test(n)) throw new Error(`Bad command name "${name}": letters, numbers, - and _ only`);
    if (typeof fn !== 'function') throw new Error(`Command /${n} needs a function to run`);
    const old = this.commands.get(n);
    // Same name twice in the main file just replaces it (as it always did). Across cogs that's a mistake: say where.
    if (old && old.owner !== owner && (old.owner || owner)) {
      const where = (o) => (o ? o.label : 'your main file');
      throw new Error(`Command /${n} is in both ${where(old.owner)} and ${where(owner)}. Rename one of them.`);
    }
    if (!old && this.commands.size >= COMMAND_LIMIT) throw new Error(`Up to ${COMMAND_LIMIT} commands per bot, /${n} is one too many`);
    this.commands.set(n, { description: String(description || '').slice(0, 100), fn, owner, check });
    if (owner) owner.cmds.add(n);
    this.#syncSoon();
    return this;
  }

  /**
   * Handle clicks on buttons with this custom_id (a string, or a RegExp like /^vote:/).
   * `fn(i)` gets the click: i.custom_id, i.user_id, i.username, i.message_id, i.channel_id and
   * i.reply(text, opts) / i.ephemeral(text, opts) / i.update({ content, embeds, components }) / i.ack().
   * Answer within 3 seconds or the person sees "This interaction failed"; you then have 15 minutes for more answers.
   */
  onButton(customId, fn) { this.buttons.push({ match: customId, fn, owner: null }); return this; }
  /**
   * Handle picks in your select menus with this custom_id (string or RegExp). `i.values` is the list of picked values.
   * Answer like a click: i.reply / i.ephemeral / i.update / i.ack, or open a form with i.showModal(modal).
   * `bot.onSelect('food', (i) => i.ephemeral(`You picked ${i.values.join(', ')}`))`. In testing (flag bot_selects).
   */
  onSelect(customId, fn) { this.buttons.push({ match: customId, fn, owner: null, kind: 'select' }); return this; }
  /**
   * Handle your modals being sent back, by the modal's custom_id (string or RegExp). `i.values` maps each input's
   * custom_id to its answer: text for a text box, a list for a select menu. Answer with i.reply / i.ephemeral / i.ack
   * (or i.update when the modal came from a click). In testing (flag bot_modals).
   */
  onModal(customId, fn) { this.buttons.push({ match: customId, fn, owner: null, kind: 'modal_submit' }); return this; }

  // ---- cogs: split a bot into files ----
  /**
   * Load a cog file: `await bot.load('./cogs/fun.js')`. The path is relative to your main file (or the folder
   * you run node in), or a URL like `new URL('./cogs/fun.js', import.meta.url)`. The file either has
   * `export default function setup(bot) { bot.command(…) }` (or `export function setup(bot)`), or exports
   * Cog classes (`export class Fun extends Cog { … }`), which are made for you. Its name is the file name: 'fun'.
   * Loaded after start()? Its commands are sent to Yapin’ a second later.
   */
  load(file) { return this.#track(this.#loadFile(file, 0)); }

  /** Load every .js / .mjs file in a folder, A to Z. Files starting with _ are skipped (handy for helpers). Returns the names. */
  loadCogs(dir = './cogs') {
    return this.#track((async () => {
      const { abs } = await locate(dir);
      const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      const files = (await fs.readdir(abs, { withFileTypes: true }))
        .filter((d) => d.isFile() && /\.m?js$/i.test(d.name) && !/^[_.]/.test(d.name))
        .map((d) => d.name).sort();
      const names = [];
      for (const f of files) names.push(await this.#loadFile(path.join(abs, f), 0));
      return names;
    })());
  }

  /** Add a cog made in code: `await bot.addCog(new Fun(bot))` or `bot.addCog(Fun)`. Its name is its class name. */
  addCog(cog) {
    return this.#track((async () => {
      const owner = this.#owner(null, null);
      if (isCogClass(cog)) cog = new cog(this.#scoped(owner));
      if (!cog || typeof cog !== 'object') throw new Error('addCog needs a cog, like bot.addCog(new Fun(bot))');
      owner.name = String((typeof cog.name === 'string' && cog.name) || cog.constructor?.name || 'cog');
      owner.label = `cog ${owner.name}`;
      if (this.cogs.has(owner.name)) throw new Error(`A cog called "${owner.name}" is already loaded`);
      this.cogs.set(owner.name, owner);
      try { await this.#mountCog(owner, cog); } catch (e) { this.#drop(owner); this.cogs.delete(owner.name); throw e; }
      this.#syncSoon();
      return cog;
    })());
  }

  /** Take a cog out again: its commands, buttons and listeners are gone, and cogUnload() runs. `bot.unload('fun')`. */
  async unload(name) {
    const owner = this.#findCog(name);
    this.cogs.delete(owner.name);
    await this.#teardown(owner);
    this.#drop(owner);
    this.#syncSoon();
    return owner.name;
  }

  /**
   * Unload a cog and load its file again, fresh from disk: edit cogs/fun.js, then `await bot.reload('fun')`, no restart.
   * If the new version fails to load, the old one is put back and the error is thrown.
   * (Files the cog imports itself are not re-read; restart for those.)
   * @see https://www.yapin.gg/developers/api/bot#put-commands
   */
  async reload(name) {
    const owner = this.#findCog(name);
    if (!owner.file) throw new Error(`"${owner.name}" wasn't loaded from a file, so it can't be reloaded`);
    await this.unload(owner.name);
    try { return await this.#loadFile(owner.file, ++this._version); } catch (e) {
      await this.#loadFile(owner.file, owner.version).catch(() => {});
      throw e;
    }
  }

  #track(p) {
    this._pending.add(p);
    const done = () => this._pending.delete(p);
    p.then(done, done);
    return p;
  }

  #findCog(name) {
    const key = String(name ?? '');
    const owner = this.cogs.get(key) || this.cogs.get(key.replace(/^.*[\\/]/, '').replace(/\.m?js$/i, ''));
    if (!owner) throw new Error(`No cog called "${key}" is loaded${this.cogs.size ? ` (loaded: ${[...this.cogs.keys()].join(', ')})` : ''}`);
    return owner;
  }

  #owner(name, file) {
    return { name, file, label: name, version: 0, cmds: new Set(), evs: [], instances: [], check: null, teardown: null };
  }

  async #loadFile(file, version) {
    const { abs, url, label } = await locate(file);
    const name = label.replace(/^.*\//, '').replace(/\.m?js$/i, '');
    if (this.cogs.has(name)) throw new Error(`A cog called "${name}" is already loaded (${this.cogs.get(name).label}). To load it again: bot.reload('${name}')`);
    const owner = this.#owner(name, abs);
    owner.label = label;
    owner.version = version;
    this.cogs.set(name, owner);
    try {
      const mod = await import(version ? `${url}?v=${version}` : url);
      const setup = typeof mod.setup === 'function' ? mod.setup : typeof mod.default === 'function' && !isCogClass(mod.default) ? mod.default : null;
      if (setup) {
        if (typeof mod.check === 'function') owner.check = tagged(owner, mod.check, undefined, 'check');
        if (typeof mod.teardown === 'function') owner.teardown = mod.teardown;
        await setup(this.#scoped(owner));
      } else {
        const classes = [...new Set(Object.values(mod))].filter(isCogClass);
        if (!classes.length) throw new Error('it has no setup(bot) function and no Cog class. Add one of them');
        for (const C of classes) await this.#mountCog(owner, new C(this.#scoped(owner)));
      }
    } catch (e) {
      this.#drop(owner);
      this.cogs.delete(name);
      const err = new Error(`Couldn't load ${label}: ${e?.message || e}`, { cause: e });
      if (e?.stack) err.stack = `${err.message}\n${String(e.stack).split('\n').slice(1).join('\n')}`;
      throw err;
    }
    this.#syncSoon();
    if (this.log && this.running) console.log(`[yapper] loaded ${name}`);
    return name;
  }

  /** Registers what a Cog instance declares: commands, buttons, on, check, then runs cogLoad(). */
  async #mountCog(owner, cog) {
    if (!cog.bot || cog.bot === this) cog.bot = this.#scoped(owner);
    const check = typeof cog.check === 'function' ? tagged(owner, cog.check, cog, 'check') : null;
    for (const [n, c] of Object.entries(cog.commands || {})) {
      const run = typeof c === 'function' ? c : c?.run;
      if (typeof run !== 'function') throw new Error(`command "${n}" needs a run function: { description: '…', run: (msg) => … }`);
      this.#addCommand(n, typeof c === 'function' ? '' : c.description, tagged(owner, run, cog, `/${n}`), owner, check);
    }
    for (const [prefix, fn] of Object.entries(cog.buttons || {})) {
      if (typeof fn !== 'function') throw new Error(`button "${prefix}" needs a function`);
      // The key is the start of the custom_id: 'vote:' matches 'vote:yes' and 'vote:no'.
      const match = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      this.buttons.push({ match, fn: tagged(owner, fn, cog, `button ${prefix}`), owner });
    }
    for (const [event, fns] of Object.entries(cog.on || {})) {
      for (const fn of [].concat(fns)) {
        if (typeof fn !== 'function') throw new Error(`on.${event} needs a function`);
        const w = tagged(owner, fn, cog, event);
        this.on(event, w);
        owner.evs.push([event, w]);
      }
    }
    owner.instances.push(cog);
    if (typeof cog.cogLoad === 'function') await cog.cogLoad();
  }

  /**
   * The bot a cog's setup gets: the real bot, except command / on / onButton remember which cog added them
   * (so unload can take them out and errors say which cog broke).
   */
  #scoped(owner) {
    const bot = this;
    let proxy;
    const own = {
      command(name, description, fn) {
        if (typeof description === 'function') { fn = description; description = ''; }
        bot.#addCommand(name, description, typeof fn === 'function' ? tagged(owner, fn, undefined, `/${String(name).replace(/^[/!]/, '')}`) : fn, owner, owner.check);
        return proxy;
      },
      on(event, fn) {
        const w = tagged(owner, fn, undefined, event);
        bot.on(event, w);
        owner.evs.push([event, w]);
        return proxy;
      },
      onButton(customId, fn) {
        bot.buttons.push({ match: customId, fn: tagged(owner, fn, undefined, `button ${customId}`), owner });
        return proxy;
      },
      // So a cog's listeners come off again on unload.
      onDm(fn) { return own.on('dm_message', fn); },
      onReactionOnMine(fn) { const w = mineOnly(bot, fn); own.on('reaction_add', w); return own.on('reaction_remove', w); },
    };
    proxy = new Proxy(bot, {
      get(t, k) {
        if (Object.hasOwn(own, k)) return own[k];
        const v = Reflect.get(t, k);
        return typeof v === 'function' && k !== 'constructor' ? v.bind(t) : v;
      },
    });
    return proxy;
  }

  async #teardown(owner) {
    const hooks = owner.instances.filter((c) => typeof c.cogUnload === 'function').map((c) => () => c.cogUnload());
    if (owner.teardown) hooks.push(() => owner.teardown(this.#scoped(owner)));
    for (const h of hooks) { try { await h(); } catch (e) { await this.fail(tagError(e, owner, 'unload')); } }
  }

  /** Removes everything a cog registered. New arrays, so an event being handled right now isn't disturbed. */
  #drop(owner) {
    for (const n of owner.cmds) if (this.commands.get(n)?.owner === owner) this.commands.delete(n);
    this.buttons = this.buttons.filter((b) => b.owner !== owner);
    for (const [event, fn] of owner.evs) if (this.handlers[event]) this.handlers[event] = this.handlers[event].filter((f) => f !== fn);
    owner.cmds.clear();
    owner.evs = [];
  }

  #commandList() { return [...this.commands].map(([name, c]) => ({ name, description: c.description })); }

  /** Commands changed after start(): send the new list to Yapin’ once things settle (a second later). */
  #syncSoon() {
    if (!this.running) return;
    if (!this._registered) { this._dirty = true; return; }
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      const commands = this.#commandList();
      this.api('PUT', '/commands', { commands, interactions: true }).then(
        () => { if (this.log) console.log(`[yapper] commands updated (${commands.length})`); },
        (e) => this.fail(e),
      );
    }, 1000);
  }

  /**
   * Raw API call. `api('GET', '/servers')`, `api('POST', '/channels/<id>/messages', { content: 'hi' })`.
   * A 429 that says how long to wait (Retry-After), or a 503 "Yapin’ is busy", is waited out and retried,
   * up to 3 times and `maxRetryWait` seconds in total (30 by default; nothing was sent, so that's safe).
   * Other errors throw an Error with `.status` (and `.retryAfter` in seconds on 429).
   */
  async api(method, path, body, { timeout = 30_000, retries = 3 } = {}) {
    let waited = 0;
    let gatewayRetried = false;
    for (let attempt = 0; ; attempt++) {
      // Over the gateway socket when it says so (flag bot_gateway_requests): no new HTTPS request per call. Files and
      // the event feed always go over HTTPS. A socket that drops before answering: a GET is asked again over HTTPS,
      // anything else throws (it may have gone through), like a network error would.
      let status, out, isJson, retryHeader;
      const gw = this._gwRequests && this._ws?.readyState === 1 && !isForm(body) && !/^\/events(?:[/?]|$)/.test(path)
        ? await this.#viaGateway(method, path, body, timeout) : null;
      if (gw?.lost && method !== 'GET') {
        const err = new Error(`${method} ${path}: the gateway connection dropped before the answer`);
        err.status = 0;
        throw err;
      }
      if (gw && !gw.lost) {
        status = gw.status; out = gw.body && typeof gw.body === 'object' ? gw.body : {}; isJson = true; retryHeader = 0;
      } else {
        const onFallback = this._fallback && Date.now() < this._fallbackUntil;
        const base = onFallback ? this._fallback : this.base;
        let res;
        try {
          res = await fetch(base + path, {
            method,
            // FormData (files) sets its own multipart content type, with the boundary.
            headers: { authorization: `Bot ${this.token}`, ...(isForm(body) ? {} : { 'content-type': 'application/json' }), 'user-agent': `yapper-sdk/${VERSION}` },
            body: body === undefined ? undefined : isForm(body) ? body : JSON.stringify(body),
            // A dead connection shouldn't hang the bot forever.
            signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeout) : undefined,
          });
        } catch (e) {
          // Our API host unreachable: the website's address for 10 minutes. A GET is asked again there at once;
          // anything else isn't (it may have gone through), the next call goes there.
          if (!this._fallback || onFallback || e?.name === 'TimeoutError') throw e;
          this._fallbackUntil = Date.now() + 10 * 60_000;
          if (this.log) console.warn(`[yapper] ${this.base} unreachable, using ${this._fallback} for 10 minutes`);
          if (method === 'GET' && attempt < retries) continue;
          throw e;
        }
        if ((res.status === 502 || res.status === 504) && this._fallback && !onFallback) {
          this._fallbackUntil = Date.now() + 10 * 60_000;
          if (this.log) console.warn(`[yapper] ${this.base} answered ${res.status}, using ${this._fallback} for 10 minutes`);
          if (method === 'GET' && attempt < retries) continue;
        }
        isJson = (res.headers.get('content-type') || '').includes('json');
        out = await res.json().catch(() => ({}));
        status = res.status;
        retryHeader = Number(res.headers.get('retry-after')) || 0;
      }
      if (status >= 200 && status < 300) return out;
      // A 502/503/504 from the proxy in front of us (a release swapping copies, a restart): asked once more after 2 s.
      // A 503 means nothing was done, so any call is safe to repeat; a 502/504 may have gone through, so only calls
      // that are safe to repeat (GET, PUT, DELETE) are.
      const ours503 = status === 503 && typeof out.retry_after === 'number';
      const again = status === 503 || ((status === 502 || status === 504) && (method === 'GET' || method === 'PUT' || method === 'DELETE'));
      if (again && !ours503 && !gatewayRetried && attempt < retries) {
        gatewayRetried = true;
        if (this.log) console.warn(`[yapper] ${method} ${path} answered ${status}, trying once more in 2s`);
        await sleep(2000);
        continue;
      }
      // A 429 page that isn't our JSON comes from Cloudflare in front of us: a per-address limit, not a bot limit.
      if (status === 429 && !isJson && !this._cfWarned) {
        this._cfWarned = true;
        console.warn('[yapper] Cloudflare rate limited this machine\'s IP address (not a Yapin\' bot limit). If several bots share this IP, tell us in Yapin\' HQ.');
      }
      // 429: slow down. 503 with retry_after: Yapin’ was busy and nothing was done, so retrying is safe too.
      const busy = status === 503 && typeof out.retry_after === 'number';
      const wait = status === 429 || busy ? retryHeader || out.retry_after || 0 : 0;
      // Jitter of up to 20% so bots don't all come back at once, inside the call's total waiting budget.
      const pause = wait * (1 + Math.random() * 0.2);
      if (wait > 0 && wait <= 60 && attempt < retries && waited + pause <= this.maxRetryWait) {
        if (this.log) console.warn(`[yapper] ${busy ? 'Yapin’ busy' : 'rate limited'}, retrying ${method} ${path} in ${wait}s`);
        waited += pause;
        await sleep(pause * 1000);
        continue;
      }
      const err = new Error(out.error || `${method} ${path} failed (${status})`);
      err.status = status;
      if (wait) err.retryAfter = wait;
      throw err;
    }
  }

  /**
   * Send a message to a channel. Returns the message.
   * `opts.embeds`: up to 5 cards (plain objects or `new Embed()`), content can be '' then. `opts.replyTo`: a message id.
   * `opts.components`: up to 5 rows of up to 5 buttons (`new Row(Button.primary('Go', 'go'))`).
   * `opts.files` (in testing, flag bot_uploads): up to 4 files, each a file path (Node), a Blob/File, or
   * `{ name: 'card.png', data: bytes }`. Pictures, videos, sounds, TXT, PDF, ZIP, 10 MB each, 12 MB in all. Every file becomes its own
   * message (the first one has the text) and is checked before it shows; content can be '' then. Returns the first message.
   * `bot.send(ch, 'Welcome!', { files: [{ name: 'welcome.png', data: png }] })`
   * `opts.stickerId` (in testing, flag stickers): one of the server's stickers as the whole message; content stays ''.
   * @see https://www.yapin.gg/developers/api/messages#post-channels-id-messages
   */
  send(channelId, content, opts = {}) {
    const body = { content: String(content ?? ''), reply_to: opts.replyTo, embeds: list(opts.embeds || undefined), components: list(opts.components || undefined), sticker_id: opts.stickerId };
    const files = opts.files == null ? [] : [].concat(opts.files);
    const sending = files.length ? this.#withFiles(body, files) : Promise.resolve(body);
    return this.#soft(sending.then((b) => this.api('POST', `/channels/${channelId}/messages`, b)).then((out) => out.message));
  }

  async #withFiles(body, files) {
    if (files.length > 4) throw new Error('Up to 4 files per message');
    const form = new FormData();
    form.append('payload_json', JSON.stringify(body));
    for (const [i, f] of files.entries()) {
      const { name, blob } = await filePart(f);
      form.append(`files[${i}]`, blob, name);
    }
    return form;
  }
  /**
   * Send a Components V2 message (layout components, flags 32768): the layout is the whole message, no content
   * or embeds. `bot.sendLayout(ch, [new Container().accent('blue').text('# Hi').add(new Row(Button.primary('Go', 'go')))])`.
   * Limits: 40 components (nested ones count), 4000 characters of text in all, galleries of 1 to 10.
   * @see https://www.yapin.gg/developers/api/messages#post-channels-id-messages
   */
  sendLayout(channelId, components, opts = {}) {
    return this.#soft(this.api('POST', `/channels/${channelId}/messages`, { flags: IS_COMPONENTS_V2, reply_to: opts.replyTo, components: list(components) }).then((out) => out.message));
  }
  /** Send just a card: `bot.sendEmbed(ch, new Embed().title('Hi'))`. */
  sendEmbed(channelId, embed, content = '') { return this.send(channelId, content, { embeds: [].concat(embed) }); }
  /** Delete a message: the bot's own, or anyone's if its roles have Manage messages. @see https://www.yapin.gg/developers/api/messages#delete-channels-id-messages-mid */
  async delete(channelId, messageId) { return this.api('DELETE', `/channels/${channelId}/messages/${messageId}`); }
  /** Servers the bot is in (with member_count, and online_count where live counts are on). @see https://www.yapin.gg/developers/api/servers#get-servers */
  async servers() { return (await this.api('GET', '/servers')).servers; }
  /**
   * Channels of a server the bot can see (private ones only if it was let in), in sidebar order:
   * { id, name, type: 'text'|'voice', category: { id, name, position } | null, position, private, read_only, slowmode }.
   * `channels(serverId, { type: 'text' })` for one kind. Without a server id: every channel in every server the bot is in.
   * @see https://www.yapin.gg/developers/api/channels#get-channels
   * @see https://www.yapin.gg/developers/api/channels#get-servers-id-channels
   */
  async channels(serverId, { type } = {}) {
    const q = type ? `?type=${encodeURIComponent(type)}` : '';
    return (await this.api('GET', serverId ? `/servers/${serverId}/channels${q}` : `/channels${q}`)).channels;
  }
  /** Channel categories of a server, in order: { id, name, position }. @see https://www.yapin.gg/developers/api/channels#get-servers-id-channels */
  async categories(serverId) { return (await this.api('GET', `/servers/${serverId}/channels`)).categories; }
  /** One channel by id (null if the bot can't see it). @see https://www.yapin.gg/developers/api/channels#get-channels-id */
  async channel(channelId) { try { return (await this.api('GET', `/channels/${channelId}`)).channel; } catch { return null; } }
  /** Members of a server (first 200; pass `after` = last user id for more). @see https://www.yapin.gg/developers/api/servers#get-servers-id-members */
  async members(serverId, after) { return (await this.api('GET', `/servers/${serverId}/members?limit=200${after ? `&after=${after}` : ''}`)).members; }
  /** Recent messages in a channel, oldest first. Each has its `author` profile ({ id, username, display_name, … }). @see https://www.yapin.gg/developers/api/messages#get-channels-id-messages */
  async messages(channelId, limit = 50) { return withAuthors(await this.api('GET', `/channels/${channelId}/messages?limit=${limit}`)); }
  /**
   * What an id is: await bot.resolve(id) -> { id, object: 'channel' | 'user' | 'role' | …, server_id, channel_id } or
   * null (unknown, or something the bot can't see). 120 a minute per bot. In testing (flag bot_api_round2).
   * @see https://www.yapin.gg/developers/api/users#get-resolve-id
   */
  async resolve(id) {
    try { return await this.api('GET', `/resolve/${encodeURIComponent(String(id))}`); } catch (e) { if (e.status === 404) return null; throw e; }
  }
  /** Someone's public profile. @see https://www.yapin.gg/developers/api/users#get-users-id */
  async user(userId) { return (await this.api('GET', `/users/${userId}`)).user; }
  /**
   * Set the bot's profile picture. Pass a file path (Node), a Blob/File, or bytes (Uint8Array/Buffer).
   * PNG, JPG, GIF or WebP, up to 8 MB. `type` is needed only for raw bytes (e.g. 'image/png').
   * @see https://www.yapin.gg/developers/api/bot#put-me-avatar
   */
  async setAvatar(image, type) { return this.#upload('/me/avatar', image, type); }
  /** Change the bot's display name and/or bio: setProfile({ displayName: 'Dice Bot', bio: 'Rolls dice' }). @see https://www.yapin.gg/developers/api/bot#patch-me */
  async setProfile({ displayName, bio } = {}) {
    return this.api('PATCH', '/me', { display_name: displayName, bio });
  }
  /** The bot's banner, same inputs as setAvatar. @see https://www.yapin.gg/developers/api/bot#put-me-banner */
  async setBanner(image, type) { return this.#upload('/me/banner', image, type); }
  /** Online status and what the bot is "playing": setStatus('dnd', 'Moderating'). Status: online, idle, dnd. @see https://www.yapin.gg/developers/api/bot#put-me-status */
  async setStatus(status = 'online', activity = null) {
    const out = await this.api('PUT', '/me/status', { status, activity });
    // Connected to the gateway: tell it too, so the dot and activity change there at once.
    try { if (this._ws?.readyState === 1) this._ws.send(JSON.stringify({ op: 'presence', status, activity })); } catch { /* closed */ }
    return out;
  }

  // ---- messages ----
  /** Edit one of the bot's own messages. `opts.embeds` / `opts.components`: new ones, or null to remove them. @see https://www.yapin.gg/developers/api/messages#patch-channels-id-messages-mid */
  async edit(channelId, messageId, content, opts = {}) {
    const body = {};
    if (content !== undefined && content !== null) body.content = String(content);
    if (opts.embeds !== undefined) body.embeds = list(opts.embeds);
    if (opts.components !== undefined) body.components = list(opts.components);
    return (await this.api('PATCH', `/channels/${channelId}/messages/${messageId}`, body)).message;
  }
  /** Swap the layout of one of the bot's Components V2 messages (see sendLayout). @see https://www.yapin.gg/developers/api/messages#patch-channels-id-messages-mid */
  async editLayout(channelId, messageId, components) {
    return (await this.api('PATCH', `/channels/${channelId}/messages/${messageId}`, { flags: IS_COMPONENTS_V2, components: list(components) })).message;
  }
  /**
   * Answer a button click, a pick, a modal or a /command (within 15 minutes). type: 'reply' (new message),
   * 'ephemeral' (only the clicker sees it), 'update' (edit the clicked message), 'ack' (just "got it") or 'modal'
   * (open a form: `{ modal: new Modal(...) }`, only as the first answer). The `i` helpers call this for you.
   * `layout`: a Components V2 layout instead of content/embeds/components (reply and update only).
   * @see https://www.yapin.gg/developers/api/interactions#post-interactions-id-token-callback
   */
  respond(interaction, type, { content, embeds, components, layout, modal } = {}) {
    if (!interaction || !interaction.id || !interaction.token) {
      return Promise.reject(new Error('Nothing to answer: this needs an interaction (a click, a pick, a modal or a command event)'));
    }
    const body = { type };
    if (modal !== undefined) body.modal = plain(modal);
    if (content !== undefined) body.content = content === null ? null : String(content);
    if (embeds !== undefined) body.embeds = list(embeds);
    if (components !== undefined) body.components = list(components);
    if (layout !== undefined) { body.flags = IS_COMPONENTS_V2; body.components = list(layout); }
    return this.#soft(this.api('POST', `/interactions/${interaction.id}/${interaction.token}/callback`, body));
  }
  /**
   * One message by id, with its `author` profile, like send() and edit() return a message.
   * (`.message` still works for bots written against the older SDK that returned the raw body.)
   * @see https://www.yapin.gg/developers/api/messages#get-channels-id-messages-mid
   */
  async message(channelId, messageId) {
    const out = await this.api('GET', `/channels/${channelId}/messages/${messageId}`);
    return out.message ? { ...out.message, author: out.author ?? null, message: out.message } : out;
  }
  /** Messages after a time (ISO string or Date), oldest first, each with its `author`. @see https://www.yapin.gg/developers/api/messages#get-channels-id-messages */
  async messagesAfter(channelId, after, limit = 50) { return withAuthors(await this.api('GET', `/channels/${channelId}/messages?limit=${limit}&after=${encodeURIComponent(new Date(after).toISOString())}`)); }
  /** Delete up to 100 messages at once (needs Manage messages for other people's). Returns { deleted, skipped }. @see https://www.yapin.gg/developers/api/messages#post-channels-id-messages-bulk-delete */
  async bulkDelete(channelId, messageIds) { return this.api('POST', `/channels/${channelId}/messages/bulk-delete`, { ids: messageIds }); }
  /** @see https://www.yapin.gg/developers/api/messages#put-channels-id-messages-mid-pin */
  async pin(channelId, messageId) { return this.api('PUT', `/channels/${channelId}/messages/${messageId}/pin`); }
  /** @see https://www.yapin.gg/developers/api/messages#delete-channels-id-messages-mid-pin */
  async unpin(channelId, messageId) { return this.api('DELETE', `/channels/${channelId}/messages/${messageId}/pin`); }
  /** @see https://www.yapin.gg/developers/api/messages#put-channels-id-messages-mid-reactions-emoji */
  react(channelId, messageId, emoji) { return this.#soft(this.api('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`)); }
  /** @see https://www.yapin.gg/developers/api/messages#delete-channels-id-messages-mid-reactions-emoji */
  async unreact(channelId, messageId, emoji) { return this.api('DELETE', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`); }
  /** @see https://www.yapin.gg/developers/api/messages#get-channels-id-messages-mid-reactions */
  async reactions(channelId, messageId) { return (await this.api('GET', `/channels/${channelId}/messages/${messageId}/reactions`)).reactions; }

  // ---- members, roles, moderation (the bot needs a role with the matching permission) ----
  /** Server details; `online_count` (people online now) sits next to `member_count` where live counts are on. @see https://www.yapin.gg/developers/api/servers#get-servers-id */
  async server(serverId) { return (await this.api('GET', `/servers/${serverId}`)).server; }
  /**
   * Live counts for a "Members: N / Online: N" counter: { member_count, online_count }. Online is refreshed once a
   * minute, so ask every few minutes (member_join / member_leave carry member_count in between).
   * @see https://www.yapin.gg/developers/api/servers#get-servers-id-counts
   */
  async memberCounts(serverId) { return this.api('GET', `/servers/${serverId}/counts`); }
  /** @see https://www.yapin.gg/developers/api/roles#get-servers-id-roles */
  async roles(serverId) { return (await this.api('GET', `/servers/${serverId}/roles`)).roles; }
  /** One member: profile, nickname, role ids, timeout. @see https://www.yapin.gg/developers/api/servers#get-servers-id-members-uid */
  async member(serverId, userId) { return (await this.api('GET', `/servers/${serverId}/members/${userId}`)).member; }
  /** @see https://www.yapin.gg/developers/api/roles#put-servers-id-members-uid-roles-rid */
  async addRole(serverId, userId, roleId) { return this.api('PUT', `/servers/${serverId}/members/${userId}/roles/${roleId}`); }
  /** @see https://www.yapin.gg/developers/api/roles#delete-servers-id-members-uid-roles-rid */
  async removeRole(serverId, userId, roleId) { return this.api('DELETE', `/servers/${serverId}/members/${userId}/roles/${roleId}`); }

  // ---- managing roles (Manage Roles; only roles below the bot's highest, only permissions the bot has itself) ----
  /**
   * Make a role, just below the bot's highest: createRole(server, { name: 'Mods', color: '#5865f2', mentionable: false,
   * permissions: { kick_members: true } }). Returns the role. 30 role and permission changes a minute per bot.
   * @see https://www.yapin.gg/developers/api/roles#post-servers-id-roles
   */
  async createRole(serverId, { name, color, mentionable, permissions } = {}) {
    return (await this.api('POST', `/servers/${serverId}/roles`, { name, color, mentionable, permissions })).role;
  }
  /** Change a role: { name, color, mentionable, permissions (only the keys you pass change), position }. Returns the role. @see https://www.yapin.gg/developers/api/roles#patch-servers-id-roles-rid */
  async editRole(serverId, roleId, { name, color, mentionable, permissions, position } = {}) {
    return (await this.api('PATCH', `/servers/${serverId}/roles/${roleId}`, { name, color, mentionable, permissions, position })).role;
  }
  /** @see https://www.yapin.gg/developers/api/roles#delete-servers-id-roles-rid */
  async deleteRole(serverId, roleId) { return this.api('DELETE', `/servers/${serverId}/roles/${roleId}`); }
  /** One role (in testing, flag bot_api_round2). @see https://www.yapin.gg/developers/api/roles#get-servers-id-roles-rid */
  async getRole(serverId, roleId) { return (await this.api('GET', `/servers/${serverId}/roles/${roleId}`)).role; }
  /**
   * Put roles in this order, top first: reorderRoles(server, [modsId, helpersId]). Roles you leave out keep their order
   * below these; roles at or above the bot's own stay put. Returns every role, top first. In testing (bot_api_round2).
   * @see https://www.yapin.gg/developers/api/roles#patch-servers-id-roles
   */
  async reorderRoles(serverId, roleIds) { return (await this.api('PATCH', `/servers/${serverId}/roles`, { ids: roleIds })).roles; }
  /**
   * What someone can do, worked out like the app does: getPermissions(server, user) for the server, or with a channel
   * for that channel (overrides included). { object: 'permissions', owner, administrator, permissions: { kick_members: true, … } }.
   * In testing (bot_api_round2).
   */
  async getPermissions(serverId, userId, channelId = null) {
    const path = channelId ? `/channels/${channelId}/permissions/${userId}` : `/servers/${serverId}/members/${userId}/permissions`;
    return (await this.api('GET', path)).permissions;
  }
  // ---- custom emojis (Manage Emoji; 30 changes a minute per bot; in testing, flag bot_emojis) ----
  /** The server's custom emojis: { emojis: [{ id, name, animated, url, … }], limit } (limit = emoji slots). @see https://www.yapin.gg/developers/api/emojis#get-servers-id-emojis */
  async emojis(serverId) { return this.api('GET', `/servers/${serverId}/emojis`); }
  /**
   * Add a custom emoji: createEmoji(server, 'party', './party.gif'). The picture: a file path (Node), a Blob/File or
   * bytes (Uint8Array/Buffer). PNG, GIF or WebP up to 1 MB. Checked like every new emoji. Returns the emoji, or null
   * when the check wasn't sure and it waits for a moderator.
   * @see https://www.yapin.gg/developers/api/emojis#post-servers-id-emojis
   */
  async createEmoji(serverId, name, image) {
    let bytes = image;
    if (typeof image === 'string') bytes = await (await import('node:fs/promises')).readFile(image);
    else if (typeof Blob !== 'undefined' && image instanceof Blob) bytes = new Uint8Array(await image.arrayBuffer());
    if (!(bytes instanceof Uint8Array)) throw new Error('Pass a file path, a Blob or bytes');
    let b64;
    if (typeof Buffer !== 'undefined') b64 = Buffer.from(bytes).toString('base64');
    else { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); b64 = btoa(s); }
    return (await this.api('POST', `/servers/${serverId}/emojis`, { name, image: b64 })).emoji;
  }
  /** Rename a custom emoji. Returns the emoji. @see https://www.yapin.gg/developers/api/emojis#patch-servers-id-emojis-eid */
  async editEmoji(serverId, emojiId, name) { return (await this.api('PATCH', `/servers/${serverId}/emojis/${emojiId}`, { name })).emoji; }
  /** @see https://www.yapin.gg/developers/api/emojis#delete-servers-id-emojis-eid */
  async deleteEmoji(serverId, emojiId) { return this.api('DELETE', `/servers/${serverId}/emojis/${emojiId}`); }
  /**
   * The custom emojis in one message (text, embeds, buttons, reactions), from any server: [{ id, name, animated, url,
   * in_server, text }]. For steal emoji commands. Read Message History; in testing (flag bot_emoji_lookup).
   * @see https://www.yapin.gg/developers/api/emojis#get-channels-id-messages-mid-emojis
   */
  async messageEmojis(channelId, messageId) { return (await this.api('GET', `/channels/${channelId}/messages/${messageId}/emojis`)).emojis; }
  /**
   * Copy an emoji into a server (the bot needs Manage Emoji there): `emoji` is one from messageEmojis(). Downloads its
   * picture and adds it like createEmoji, under `name` (default: its own name). Returns the new emoji, or null when it
   * waits for a moderator.
   *   bot.command('steal', 'Copy an emoji', async (msg) => {
   *     const [e] = await bot.messageEmojis(msg.channel_id, msg.reply_to_id || msg.id);
   *     if (!e) return msg.reply('No custom emoji there');
   *     const added = await bot.stealEmoji(msg.server_id, e, msg.argv[0]);
   *     await msg.reply(added ? `Added ${added.name}` : 'Sent for a check');
   *   });
   */
  async stealEmoji(serverId, emoji, name) {
    if (!emoji || typeof emoji.url !== 'string' || !emoji.url) throw new Error('stealEmoji needs an emoji from messageEmojis()');
    const res = await fetch(emoji.url);
    if (!res.ok) throw new Error(`Couldn't download that emoji (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return this.createEmoji(serverId, name || emoji.name, bytes);
  }
  /** @everyone's permissions (the basic ones): setEveryonePerms(server, { send_messages: false }). @see https://www.yapin.gg/developers/api/roles#patch-servers-id-roles-everyone */
  async setEveryonePerms(serverId, permissions) { return this.api('PATCH', `/servers/${serverId}/roles/everyone`, { permissions }); }
  /** A channel's permission overrides: [{ role_id (null = @everyone), allow, deny }]. @see https://www.yapin.gg/developers/api/channels#get-channels-id-permissions */
  async channelPermissions(channelId) { return (await this.api('GET', `/channels/${channelId}/permissions`)).overrides; }
  /**
   * Allow or deny permissions for a role (or 'everyone') in one channel: setChannelPermissions(ch, roleId,
   * { allow: ['send_messages'], deny: ['view_channel'] }). Empty lists remove the override.
   * @see https://www.yapin.gg/developers/api/channels#put-channels-id-permissions-target
   */
  async setChannelPermissions(channelId, roleId, { allow = [], deny = [] } = {}) {
    return this.api('PUT', `/channels/${channelId}/permissions/${roleId}`, { allow, deny });
  }
  /** @see https://www.yapin.gg/developers/api/channels#delete-channels-id-permissions-target */
  async clearChannelPermissions(channelId, roleId) { return this.api('DELETE', `/channels/${channelId}/permissions/${roleId}`); }
  /** The same for a whole category (its channels follow it unless they have their own). @see https://www.yapin.gg/developers/api/channels#put-servers-id-categories-cid-permissions-role */
  async setCategoryPermissions(serverId, categoryId, roleId, { allow = [], deny = [] } = {}) {
    return this.api('PUT', `/servers/${serverId}/categories/${categoryId}/permissions/${roleId}`, { allow, deny });
  }
  /** @see https://www.yapin.gg/developers/api/channels#delete-servers-id-categories-cid-permissions-role */
  async clearCategoryPermissions(serverId, categoryId, roleId) { return this.api('DELETE', `/servers/${serverId}/categories/${categoryId}/permissions/${roleId}`); }
  // ---- overrides, round 2 (in testing, flag bot_api_round2): target is a role id or 'everyone' ----
  /** A channel's overrides: [{ object: 'override', type: 'role' | 'everyone', id, role_id, allow, deny, channel_id }]. @see https://www.yapin.gg/developers/api/channels#get-channels-id-overrides */
  async getOverrides(channelId) { return (await this.api('GET', `/channels/${channelId}/overrides`)).overrides; }
  /**
   * setOverride(channel, roleId or 'everyone', { allow: ['send_messages'], deny: ['view_channel'] }). Empty lists remove it.
   * Same rules as a person: only roles below the bot's top role, only permissions the bot has itself.
   * @see https://www.yapin.gg/developers/api/channels#put-channels-id-overrides-target
   */
  async setOverride(channelId, target, { allow = [], deny = [] } = {}) {
    const out = await this.api('PUT', `/channels/${channelId}/overrides/${target}`, { allow, deny });
    return out.override ?? null;
  }
  /** @see https://www.yapin.gg/developers/api/channels#delete-channels-id-overrides-target */
  async deleteOverride(channelId, target) { return this.api('DELETE', `/channels/${channelId}/overrides/${target}`); }
  /** A category's overrides (its channels follow them unless they set their own). @see https://www.yapin.gg/developers/api/channels#get-categories-id-overrides */
  async getCategoryOverrides(categoryId) { return (await this.api('GET', `/categories/${categoryId}/overrides`)).overrides; }
  /** @see https://www.yapin.gg/developers/api/channels#put-categories-id-overrides-target */
  async setCategoryOverride(categoryId, target, { allow = [], deny = [] } = {}) {
    const out = await this.api('PUT', `/categories/${categoryId}/overrides/${target}`, { allow, deny });
    return out.override ?? null;
  }
  /** @see https://www.yapin.gg/developers/api/channels#delete-categories-id-overrides-target */
  async deleteCategoryOverride(categoryId, target) { return this.api('DELETE', `/categories/${categoryId}/overrides/${target}`); }
  /** Set someone's nickname ('' clears it). @see https://www.yapin.gg/developers/api/moderation#patch-servers-id-members-uid */
  async setNickname(serverId, userId, nickname) { return this.api('PATCH', `/servers/${serverId}/members/${userId}`, { nickname }); }
  /** @see https://www.yapin.gg/developers/api/moderation#post-servers-id-kick */
  async kick(serverId, userId) { return this.api('POST', `/servers/${serverId}/kick`, { user_id: userId }); }
  /** @see https://www.yapin.gg/developers/api/moderation#post-servers-id-bans */
  async ban(serverId, userId) { return this.api('POST', `/servers/${serverId}/bans`, { user_id: userId }); }
  /** @see https://www.yapin.gg/developers/api/moderation#delete-servers-id-bans-uid */
  async unban(serverId, userId) { return this.api('DELETE', `/servers/${serverId}/bans/${userId}`); }
  /** @see https://www.yapin.gg/developers/api/moderation#get-servers-id-bans */
  async bans(serverId) { return (await this.api('GET', `/servers/${serverId}/bans`)).bans; }
  /**
   * The server's invites: [{ code, url, inviter_id, uses, max_uses, expires_at, vanity, created_at }]. Needs Manage Server.
   * Yapin’ invites don't run out: max_uses is 0 (no limit) and expires_at null.
   * @see https://www.yapin.gg/developers/api/moderation#get-servers-id-invites
   */
  async invites(serverId) { return (await this.api('GET', `/servers/${serverId}/invites`)).invites; }
  /** Time someone out for `minutes` (0 clears it). @see https://www.yapin.gg/developers/api/moderation#post-servers-id-timeouts */
  async timeout(serverId, userId, minutes, reason = '') { return this.api('POST', `/servers/${serverId}/timeouts`, { user_id: userId, minutes, reason }); }

  // ---- voice (Move Members for moves; 30 moves and 60 lookups a minute per bot) ----
  /** Who is in voice: [{ channel_id, user_ids }] for every voice channel the bot can see (empty ones too). @see https://www.yapin.gg/developers/api/voice#get-servers-id-voice */
  async voice(serverId) { return (await this.api('GET', `/servers/${serverId}/voice`)).voice; }
  /** Move someone who is in voice to another voice channel of the server (Move Members). @see https://www.yapin.gg/developers/api/voice#post-servers-id-voice-move */
  async moveMember(serverId, userId, channelId) { return this.api('POST', `/servers/${serverId}/voice/move`, { user_id: userId, channel_id: channelId }); }
  /** Drop someone from voice (Move Members). @see https://www.yapin.gg/developers/api/voice#post-servers-id-voice-disconnect */
  async disconnectMember(serverId, userId) { return this.api('POST', `/servers/${serverId}/voice/disconnect`, { user_id: userId }); }

  // ---- the bot in voice: music bots (10 joins and leaves a minute; one voice channel per server) ----
  /**
   * A ticket for a voice channel: { url, token, e2ee, voice_muted, channel_id, server_id }. Connect with any LiveKit SDK
   * within a minute. The bot can send one audio track (as a mic) and hears nobody. Joining another channel of the
   * same server drops it from the first. Most bots want connectVoice below, which does all of it.
   * @see https://www.yapin.gg/developers/api/voice#post-servers-id-voice-join
   */
  async joinVoice(serverId, channelId) { return this.api('POST', `/servers/${serverId}/voice/join`, { channel_id: channelId }); }
  /** Take the bot out of voice in that server (also works when its own code has lost track of the call). @see https://www.yapin.gg/developers/api/voice#post-servers-id-voice-leave */
  async leaveVoice(serverId) { return this.api('POST', `/servers/${serverId}/voice/leave`); }
  /**
   * Join a voice channel and get an audio source to play into, with @livekit/rtc-node (npm i @livekit/rtc-node). You
   * pass the module in, so this file stays dependency free:
   *   import * as rtc from '@livekit/rtc-node';
   *   const call = await bot.connectVoice(rtc, serverId, channelId);
   *   await call.source.captureFrame(new rtc.AudioFrame(pcm, 48000, 2, 480));   // 10 ms of 16-bit stereo PCM
   *   await call.leave();
   * Returns { room, source, track, e2ee, leave() }. Calls on Yapin’ are end-to-end encrypted: this hands the bot's
   * media key to everyone in the call the way the app does (sealed to each person, the server never sees it) and
   * encrypts the audio with it. Without that nobody would hear the bot.
   */
  async connectVoice(rtc, serverId, channelId, { sampleRate = 48000, channels = 2, bitrate = 128_000 } = {}) {
    const t = await this.joinVoice(serverId, channelId);
    const subtle = (globalThis.crypto ?? (await import('node:crypto')).webcrypto).subtle;
    const mediaKey = t.e2ee ? (globalThis.crypto ?? (await import('node:crypto')).webcrypto).getRandomValues(new Uint8Array(32)) : null;
    const room = new rtc.Room();
    // Shared key mode encrypts our frames with mediaKey; HKDF (1) is how the app's browsers turn it into the frame key.
    // Spelled out in full: our object replaces rtc-node's defaults instead of merging into them, so the salt went
    // empty (and the cipher unset) and every listener derived a different frame key: the bot "spoke" but nobody
    // heard it. The browsers use livekit-client's salt "LKFrameEncryptionKey" with AES-GCM, like the Python SDK.
    const encryption = mediaKey ? {
      ...(rtc.defaultE2EEOptions ?? {}),
      encryptionType: rtc.EncryptionType?.GCM ?? 1,
      keyProviderOptions: {
        ...(rtc.defaultKeyProviderOptions ?? {}),
        sharedKey: mediaKey, ratchetSalt: new TextEncoder().encode('LKFrameEncryptionKey'),
        ratchetWindowSize: 0, failureTolerance: -1, keyRingSize: 16, keyDerivationFunction: 1,
      },
    } : null;
    // `e2ee`, not `encryption`: `encryption` also encrypts data messages with the media key, so the key handoff below
    // went out sealed under the very key it carries. The app (media only, lib/callCrypto.ts) never read it, never got
    // our key and dropped every frame: the bot glowed green (the server sees audio levels) but nobody heard it.
    await room.connect(t.url, t.token, { autoSubscribe: false, dynacast: false, ...(encryption ? { e2ee: encryption } : {}) });
    const keys = mediaKey ? await handOutVoiceKey(room, subtle, mediaKey) : null;
    const source = new rtc.AudioSource(sampleRate, channels);
    const track = rtc.LocalAudioTrack.createAudioTrack('audio', source);
    const opts = new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE, dtx: false, red: false, audioEncoding: { maxBitrate: BigInt(bitrate) } });
    await room.localParticipant.publishTrack(track, opts);
    return { room, source, track, e2ee: !!mediaKey, leave: async () => { keys?.stop(); await room.disconnect(); } };
  }

  // ---- channels ----
  // ---- webhooks (flag bot_webhooks; the bot needs Manage Webhooks in that channel) ----
  /**
   * Make a webhook in a text channel and post through it with a different name and picture per message
   * (PluralKit style): `const hook = await bot.createWebhook(ch, 'Proxy');
   * await hook.send({ content: 'hi!', username: 'Alice', avatarUrl: 'https://i.imgur.com/abc.png' })`.
   * The message shows a BOT tag. `hook.token` and `hook.url` (the secret URL) only come back here; the bot token is
   * enough to post, so you don't need to keep them. Up to 10 webhooks a channel, 10 makes + deletes a minute.
   * @see https://www.yapin.gg/developers/api/webhooks#post-channels-id-webhooks
   */
  async createWebhook(channelId, name) { return this.wrapWebhook((await this.api('POST', `/channels/${channelId}/webhooks`, { name })).webhook); }
  /** Every webhook in a channel (people's too, without tokens). @see https://www.yapin.gg/developers/api/webhooks#get-channels-id-webhooks */
  async webhooks(channelId) { return (await this.api('GET', `/channels/${channelId}/webhooks`)).webhooks.map((w) => this.wrapWebhook(w)); }
  /** The bot's own webhooks in every server, newest first: find them again after a restart. @see https://www.yapin.gg/developers/api/webhooks#get-webhooks */
  async myWebhooks() { return (await this.api('GET', '/webhooks')).webhooks.map((w) => this.wrapWebhook(w)); }
  /** Delete a webhook (its old messages stay). @see https://www.yapin.gg/developers/api/webhooks#delete-webhooks-id */
  async deleteWebhook(webhookId) { return this.api('DELETE', `/webhooks/${webhookId}`); }
  /**
   * Post through one of the bot's own webhooks. `content` is the text, or an object with all of it:
   * `{ content, username, avatarUrl, embeds, components, allowedMentions }`. avatarUrl must be an https link to
   * Yapin’ uploads or a known image host (like embed pictures). Components: link buttons only. Returns the message.
   * Limits: 5 per 2 seconds per webhook, 30 a minute per channel, plus the bot's own message limits.
   * @see https://www.yapin.gg/developers/api/webhooks#post-webhooks-id
   */
  async sendWebhook(webhookId, content, opts = {}) {
    if (content && typeof content === 'object' && !Array.isArray(content) && !(content instanceof Embed)) { opts = content; content = content.content; }
    const body = { content: String(content ?? ''), username: opts.username ?? undefined, avatar_url: opts.avatarUrl ?? opts.avatar_url ?? undefined,
      embeds: list(opts.embeds || undefined), components: list(opts.components || undefined), allowed_mentions: opts.allowedMentions ?? opts.allowed_mentions ?? undefined };
    return (await this.api('POST', `/webhooks/${webhookId}`, body)).message;
  }
  /** A webhook's data -> a webhook with send(content | { content, username, avatarUrl, ... }) and delete(). */
  wrapWebhook(data) {
    const bot = this;
    return {
      ...data,
      /** Post as this webhook: `hook.send('hi', { username: 'Alice' })` or `hook.send({ content: 'hi', username: 'Alice', avatarUrl })`. */
      send(content, opts = {}) { return bot.sendWebhook(data.id, content, opts); },
      /** Delete it. */
      delete() { return bot.deleteWebhook(data.id); },
    };
  }

  /** @see https://www.yapin.gg/developers/api/channels#post-servers-id-channels */
  async createChannel(serverId, name, { kind = 'text', categoryId } = {}) { return (await this.api('POST', `/servers/${serverId}/channels`, { name, kind, category_id: categoryId })).channel; }
  /** Change a channel: { name, categoryId, private, roleIds, readOnly, postRoleIds, slowmode }. @see https://www.yapin.gg/developers/api/channels#patch-channels-id */
  async editChannel(channelId, changes = {}) {
    const { name, categoryId, private: priv, roleIds, readOnly, postRoleIds, slowmode } = changes;
    return (await this.api('PATCH', `/channels/${channelId}`, { name, category_id: categoryId, private: priv, role_ids: roleIds, read_only: readOnly, post_role_ids: postRoleIds, slowmode })).channel;
  }
  /** @see https://www.yapin.gg/developers/api/channels#delete-channels-id */
  async deleteChannel(channelId) { return this.api('DELETE', `/channels/${channelId}`); }
  /** @see https://www.yapin.gg/developers/api/channels#post-servers-id-categories */
  async createCategory(serverId, name) { return (await this.api('POST', `/servers/${serverId}/categories`, { name })).category; }
  /** @see https://www.yapin.gg/developers/api/channels#delete-servers-id-categories-cid */
  async deleteCategory(serverId, categoryId) { return this.api('DELETE', `/servers/${serverId}/categories/${categoryId}`); }

  // ---- events (in testing) ----
  /** Upcoming and live events of a server. @see https://www.yapin.gg/developers/api/scheduled-events#get-servers-id-events */
  async events(serverId) { return (await this.api('GET', `/servers/${serverId}/events`)).events; }
  /** Make an event: { title, startsAt (Date or ISO), endsAt, channelId (voice) or location, announceChannelId, repeat: 'none'|'weekly', tz, description }. Manage Events. @see https://www.yapin.gg/developers/api/scheduled-events#post-servers-id-events */
  async createEvent(serverId, { title, startsAt, endsAt, channelId, location, announceChannelId, repeat, tz, description } = {}) {
    const iso = (d) => (d instanceof Date ? d.toISOString() : d);
    return (await this.api('POST', `/servers/${serverId}/events`, { title, starts_at: iso(startsAt), ends_at: iso(endsAt) ?? null, channel_id: channelId, location, announce_channel_id: announceChannelId, repeat, tz, description })).event;
  }

  // ---- DMs ----
  /** Open a DM with someone (they must allow DMs from the bot: a friend, or sharing a server, depending on their setting). Returns the channel id; then bot.send(channelId, …). @see https://www.yapin.gg/developers/api/users#post-users-id-dm */
  async dm(userId) { return (await this.api('POST', `/users/${userId}/dm`)).channel_id; }
  /** Open a DM and send one message in it. */
  dmSend(userId, content, opts = {}) { return this.#soft(this.dm(userId).then((cid) => this.send(cid, content, opts))); }

  async #upload(path, image, type) {
    let bytes = image;
    if (typeof image === 'string') {
      const fs = await import('node:fs/promises');
      bytes = await fs.readFile(image);
      type ||= { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[image.split('.').pop().toLowerCase()];
    } else if (typeof Blob !== 'undefined' && image instanceof Blob) {
      type ||= image.type;
      bytes = new Uint8Array(await image.arrayBuffer());
    }
    if (!type) throw new Error('Pass the image type too, like "image/png"');
    const res = await fetch((this._fallback && Date.now() < this._fallbackUntil ? this._fallback : this.base) + path, { method: 'PUT', headers: { authorization: `Bot ${this.token}`, 'content-type': type, 'user-agent': `yapper-sdk/${VERSION}` }, body: bytes });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(out.error || `upload failed (${res.status})`); err.status = res.status; throw err; }
    return out;
  }

  /**
   * Sending is often fire-and-forget (`msg.reply('hi')` without await). If such a call fails (rate limit,
   * no permission) Node would crash on the unhandled rejection; instead the error goes to on('error') / the
   * log. Code that awaits or .catch()es the call gets the error as usual and nothing extra is reported.
   */
  /** One API call over the gateway socket: { status, body }, or { lost: true } when the socket went before the answer. */
  #viaGateway(method, path, body, timeout) {
    const ws = this._ws;
    const id = String(++this._gwNext);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._gwPending.delete(id); resolve({ lost: true }); }, timeout);
      this._gwPending.set(id, (r) => { clearTimeout(t); this._gwPending.delete(id); resolve(r); });
      try { ws.send(JSON.stringify({ op: 'request', id, method, path, body })); } catch { this._gwPending.get(id)?.({ lost: true }); }
    });
  }

  #soft(p) {
    let seen = false;
    p.catch((e) => { if (!seen) void this.fail(e); });
    const use = () => { seen = true; return p; };
    return { then: (a, b) => use().then(a, b), catch: (b) => use().catch(b), finally: (f) => use().finally(f), [Symbol.toStringTag]: 'Promise' };
  }

  async emit(event, payload) {
    for (const fn of this.handlers[event] || []) {
      try { await fn(payload); } catch (e) {
        // A broken "error" listener is logged once. Sending it back to fail() made it call itself until the stack overflowed.
        if (event === 'error') { if (this.log) console.error('[yapper] error listener threw:', e?.message || e); }
        else await this.fail(e);
      }
    }
  }
  async fail(e) {
    if (this.handlers.error?.length) await this.emit('error', e);
    else if (this.log) console.error(e?.cog ? `[yapper] [${e.cog}${e.where ? ` ${e.where}` : ''}]` : '[yapper]', e?.message || e);
  }

  /** Register the commands with Yapin’ and start fetching events. Resolves when stopped. @see https://www.yapin.gg/developers/api/events#get-events @see https://www.yapin.gg/developers/api/bot#get-me @see https://www.yapin.gg/developers/api/bot#put-commands */
  async start() {
    if (this.running) return;
    this.running = true;
    // Cogs still loading (bot.load() without await) finish first, so their commands are in the list.
    if (this._pending.size) await Promise.allSettled([...this._pending]);
    if (this.log) console.log('[yapper] connecting…');
    void checkVersion(this.base, this.log);
    let list = [];
    let first;
    // Startup calls retry through network blips and server hiccups too (a bad token still stops right away).
    for (let n = 1; ; n++) {
      try {
        this.me = await this.api('GET', '/me');
        this._dirty = false;
        list = this.#commandList();
        // interactions: true = commands picked from the / menu come as command events (nothing posted in chat) and
        // msg.reply answers them; Yapin’ shows "<user> used /cmd" above the answer. Typed "!cmd" still comes as a message.
        await this.api('PUT', '/commands', { commands: list, interactions: true });
        this._registered = true;
        // Skip events from before we started.
        first = await this.api('GET', '/events?after=0&wait=0');
        break;
      } catch (e) {
        if (e.status === 401 || e.status === 400 || e.status === 403) { this.running = false; throw e; }
        await this.fail(e);
        await sleep(backoff(n));
        if (!this.running) return;
      }
    }
    this.last = first.last || 0;
    // A cog loaded while we were connecting: send the list again.
    if (this._dirty) this.#syncSoon();
    if (this.log) console.log(`[yapper] ${this.me.username} is online${list.length ? ` with ${list.length} command${list.length === 1 ? '' : 's'}` : ''}`);
    await this.emit('ready', this.me);
    let failures = 0;
    let gwFails = 0;
    let gwRetryAt = 0;
    while (this.running) {
      // The gateway first; when it's off for this bot or keeps failing, the long poll below for a while.
      if (this.gateway && Date.now() >= gwRetryAt) {
        const r = await this.#gatewaySession();
        if (!this.running) break;
        if (r === 'bad_token') { await this.fail(new Error('Token rejected: make a new one in Settings → Developer')); this.running = false; break; }
        if (r === 'disabled') gwRetryAt = Date.now() + 10 * 60_000;
        else if (r === 'ok') { gwFails = 0; await sleep(backoff(1)); continue; }
        else if (++gwFails >= 3) {
          if (this.log) console.log('[yapper] gateway unavailable, long polling for 5 minutes');
          gwFails = 0; gwRetryAt = Date.now() + 5 * 60_000;
        } else { await sleep(backoff(gwFails)); continue; }
      }
      let out;
      try {
        // No inner retries: a failed poll already waits below, with backoff that keeps growing.
        out = await this.api('GET', `/events?after=${this.last}&wait=25`, undefined, { timeout: 45_000, retries: 0 });
        // Yapin’ always sends an events list. Anything else (a wrong `base` answering 200 with a web page) waits
        // and retries below instead of asking again at once, forever.
        if (!Array.isArray(out?.events)) throw new Error(`GET /events got an answer without events from ${this.base}. Is the base URL right?`);
        failures = 0;
      } catch (e) {
        failures++;
        if (e.status === 401) { await this.fail(new Error('Token rejected: make a new one in Settings → Developer')); this.running = false; break; }
        await this.fail(e);
        // Retry-After when the server sent one, otherwise exponential backoff (never a tight loop).
        await sleep(Math.max((e.retryAfter || 0) * 1000, backoff(failures)));
        continue;
      }
      for (const ev of out.events || []) {
        // Each event once, in order: anything at or below the cursor was already handled.
        if (!(ev.id > this.last)) continue;
        this.last = ev.id;
        await this.handle(ev);
      }
      // Also move on when there were no events (the server answers after=0 with the newest id).
      if (typeof out.last === 'number' && out.last > this.last) this.last = out.last;
    }
  }

  /**
   * One gateway connection (docs: /developers#gateway). Picks up after this.last, so nothing is missed between a
   * long poll and the socket or across reconnects. Resolves when the socket closes: 'ok' (was up a while, reconnect),
   * 'disabled' (not on for this bot: long poll), 'bad_token', or 'failed'.
   */
  #gatewaySession() {
    return new Promise((resolve) => {
      let ws;
      try { ws = new WebSocket(this.gateway); } catch { resolve('failed'); return; }
      this._ws = ws;
      let readyAt = 0;
      let beat = null;
      let acked = true;
      // Events are handled one at a time, in order, like the long poll.
      let chain = Promise.resolve();
      let over = false;
      const finish = (r) => {
        if (over) return;
        over = true;
        // Detached first: closing from inside a handler can fire "error" again right away.
        ws.onmessage = null; ws.onerror = null; ws.onclose = null;
        clearInterval(beat); clearTimeout(slow);
        if (this._ws === ws) { this._ws = null; this._gwRequests = false; }
        for (const done of [...this._gwPending.values()]) done({ lost: true });
        chain.then(() => resolve(r));
      };
      // A socket that never gets to ready (or a dead one whose close never comes) doesn't hold the bot up.
      const slow = setTimeout(() => { finish('failed'); try { ws.close(4000, 'no ready'); } catch { /* closed */ } }, 15_000);
      ws.onmessage = (m) => {
        let msg;
        try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
        if (msg.op === 'hello') ws.send(JSON.stringify({ op: 'resume', token: this.token, seq: this.last }));
        else if (msg.op === 'ready') {
          readyAt = Date.now();
          clearTimeout(slow);
          this._gwRequests = msg.requests === true;
          if (this.log) console.log(`[yapper] connected to the gateway${this._gwRequests ? ' (API calls over it too)' : ''}`);
          beat = setInterval(() => {
            // No answer to the last heartbeat: the connection is dead, start over.
            if (!acked) { finish('ok'); try { ws.close(4000, 'no heartbeat ack'); } catch { /* closed */ } return; }
            acked = false;
            ws.send(JSON.stringify({ op: 'heartbeat' }));
          }, msg.heartbeat_interval || 30_000);
        } else if (msg.op === 'heartbeat_ack') acked = true;
        else if (msg.op === 'response' && typeof msg.id === 'string') this._gwPending.get(msg.id)?.({ status: Number(msg.status) || 0, body: msg.body });
        else if (msg.op === 'event' && msg.d) {
          const ev = msg.d;
          chain = chain.then(async () => {
            if (!(ev.id > this.last)) return;
            this.last = ev.id;
            try { await this.handle(ev); } catch (e) { await this.fail(e); }
          });
        }
      };
      // Node's WebSocket fires only "error" (no "close") when it can't connect at all.
      ws.onerror = () => { if (!readyAt) finish('failed'); };
      ws.onclose = (e) => finish(e.code === 4004 ? 'bad_token' : e.code === 4003 ? 'disabled'
        : readyAt && Date.now() - readyAt > 10_000 ? 'ok' : 'failed');
    });
  }

  /** Stop after the current poll. */
  stop() {
    this.running = false;
    try { this._ws?.close(1000); } catch { /* already closed */ }
    this._registered = false;
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
  }

  async handle(ev) {
    const data = ev.data || {};
    if (ev.type === 'message') {
      // Messages from bots and webhooks (author_bot): skipped unless the bot asked for them (ignoreBots: false).
      if (this.ignoreBots && data.author_bot) return;
      const msg = this.wrap(data);
      let name = data.command;
      let args = data.args;
      // "/fish @OtherBot": a command picked for another bot (command_for) isn't ours to answer, even if we have /fish.
      const forOther = Array.isArray(data.command_for) && !data.command_for.includes(this.me?.id);
      if (!name && !forOther) {
        // Commands typed with another prefix, or ones we didn't register. A prefix can be longer than one
        // character ('yap!'); the longest one that fits goes first so '!!' wins over '!'.
        const content = data.content || '';
        for (const p of [...this.prefixes].sort((a, b) => b.length - a.length)) {
          if (!p || !content.startsWith(p)) continue;
          const m = /^([a-z0-9_-]{1,32})(?:\s+([\s\S]*))?$/i.exec(content.slice(p.length));
          if (m && this.commands.has(m[1].toLowerCase())) { name = m[1].toLowerCase(); args = (m[2] || '').trim(); break; }
        }
      }
      if (name && this.commands.has(name)) {
        const c = this.commands.get(name);
        msg.command = name;
        msg.args = args || '';
        msg.argv = msg.args ? msg.args.split(/\s+/) : [];
        // A cog's check(msg) runs first; false (or an error) skips the command.
        let ok = true;
        if (c.check) { try { ok = (await c.check(msg)) !== false; } catch (e) { ok = false; await this.fail(e); } }
        if (ok) {
          try { await c.fn(msg); } catch (e) { await this.fail(e); }
          await this.emit('command', msg);
        }
      }
      await this.emit('message', msg);
    } else if (ev.type === 'command') {
      // A slash command picked from the / menu (flag bot_slash_interactions): nothing was posted in chat. msg works
      // like a command message; msg.reply answers it (shown with "<user> used /cmd"), msg.ephemeral only to them.
      const msg = this.wrapCommand(data);
      const c = this.commands.get(msg.command);
      if (!c) { await this.respond(data, 'ephemeral', { content: `/${msg.command} isn't a command of this bot anymore` }).catch(() => {}); return; }
      let ok = true;
      if (c.check) { try { ok = (await c.check(msg)) !== false; } catch (e) { ok = false; await this.fail(e); } }
      if (ok) {
        try { await c.fn(msg); } catch (e) { await this.fail(e); }
        await this.emit('command', msg);
      }
    } else if (ev.type === 'interaction') {
      const i = this.wrapInteraction(data);
      const kind = data.type === 'select' || data.type === 'modal_submit' ? data.type : 'button';
      for (const b of this.buttons) {
        if ((b.kind || 'button') !== kind) continue;
        // lastIndex reset: a /g or /y pattern keeps its place between tests, which made every other click miss.
        const hit = b.match instanceof RegExp ? ((b.match.lastIndex = 0), b.match.test(data.custom_id)) : b.match === data.custom_id;
        if (hit) { try { await b.fn(i); } catch (e) { await this.fail(e); } }
      }
      await this.emit('interaction', i);
    } else if (ev.type === 'dm_message') {
      // A DM to this bot. Commands aren't run here (they are for servers); answer in onDm / on('dm_message').
      if (this.ignoreBots && data.author_bot) return;
      const msg = this.wrap(data);
      msg.dm = true;
      msg.is_dm = true;
      msg.dm_channel_id ||= data.channel_id;
      await this.emit('dm_message', msg);
    } else {
      // A channel / thread event's data has its own type (text, voice, thread): kept, the event name is in .event.
      const own = (data.object === 'channel' || data.object === 'thread') && typeof data.type === 'string';
      await this.emit(ev.type, { ...data, type: own ? data.type : ev.type, event: ev.type });
    }
  }

  wrapInteraction(data) {
    const bot = this;
    return {
      ...data,
      /** A new message in the channel. */
      reply(content, opts = {}) { return bot.respond(data, 'reply', { content, ...opts }); },
      /** A message only the person who clicked sees. Text and embeds, no buttons. */
      ephemeral(content, opts = {}) { return bot.respond(data, 'ephemeral', { content, ...opts }); },
      /**
       * Change the message the button is on: { content, embeds, components } (left out = kept, null = removed).
       * On a Components V2 message: i.update({ layout: [ … ] }) with the whole new layout.
       */
      update(changes = {}) { return bot.respond(data, 'update', changes); },
      /** Just say "got it", so the person doesn't see an error. */
      ack() { return bot.respond(data, 'ack'); },
      /** Open a form for the person (a Modal). Only as the first answer, not to a modal_submit. Flag bot_modals. */
      showModal(modal) { return bot.respond(data, 'modal', { modal }); },
      /** <@id> for the person who clicked. */
      get userMention() { return `<@${data.user_id}>`; },
    };
  }

  /**
   * A command event as a command message: command, args, argv, author_id, author, channel_id, server_id, content
   * ("/roll 2d6"), interaction (true). reply / say answer it (files go as a normal message), ephemeral answers only the
   * person who used it, ack just says "got it".
   */
  wrapCommand(data) {
    const bot = this;
    const args = typeof data.args === 'string' ? data.args : '';
    const answer = (type, content, opts = {}) => {
      if (opts.files) return bot.send(data.channel_id, content, opts);
      const { embeds, components, layout } = opts;
      return bot.respond(data, type, { content, embeds, components, layout }).then((out) => out?.message ?? null);
    };
    return {
      ...data,
      id: data.id, interaction: true, command: data.command, args, argv: args ? args.split(/\s+/) : [],
      author_id: data.user_id, author: data.username ?? null, author_bot: false, mentioned: true,
      content: `/${data.command}${args ? ` ${args}` : ''}`,
      /** Answer the command (a new message, with "<user> used /cmd" above it). */
      reply(content, opts = {}) { return answer('reply', content, opts); },
      /** Same as reply. */
      say(content, opts = {}) { return answer('reply', content, opts); },
      /** Only the person who used the command sees it. Text and embeds. */
      ephemeral(content, opts = {}) { return answer('ephemeral', content, opts); },
      /** Just "got it", no message. */
      ack() { return bot.respond(data, 'ack'); },
      /** Open a form for the person who used it (a Modal, flag bot_modals). Only as the first answer; it comes back to onModal. */
      showModal(modal) { return bot.respond(data, 'modal', { modal }); },
      /** <@id> for the person who used it. */
      get authorMention() { return `<@${data.user_id}>`; },
    };
  }

  wrap(data) {
    const bot = this;
    return {
      ...data,
      /** True when a bot or a webhook sent it. */
      author_bot: !!data.author_bot,
      /** Reply to this message (quoted). */
      reply(content, opts = {}) { return bot.send(data.channel_id, content, { ...opts, replyTo: data.id }); },
      /** Post in the same channel without quoting. */
      say(content, opts = {}) { return bot.send(data.channel_id, content, opts); },
      /** <@id> for the author, for mentioning them back. */
      get authorMention() { return `<@${data.author_id}>`; },
    };
  }
}

/** A reaction listener that only fires for reactions on the bot's own messages, with `added` set. */
function mineOnly(bot, fn) {
  return (ev) => {
    if (!ev || !bot.me?.id || ev.message_author_id !== bot.me.id) return undefined;
    return fn({ ...ev, added: ev.type === 'reaction_add' });
  };
}

/**
 * A cog groups commands, buttons and listeners, usually one file per topic (cogs/fun.js, cogs/mod.js).
 * Load it with `await bot.load('./cogs/fun.js')` or a whole folder with `await bot.loadCogs('./cogs')`.
 *
 *   import { Cog } from '../yapper.js';
 *   export class Fun extends Cog {
 *     commands = {
 *       joke: { description: 'Tell a joke', run: (msg) => msg.reply('I know a UDP joke, but you might not get it') },
 *     };
 *     buttons = { 'vote:': (i) => i.ephemeral('Thanks!') };   // custom_ids starting with "vote:"
 *     on = { member_join: (ev) => console.log(ev.username, 'joined') };
 *     check(msg) { return true; }       // optional: return false to skip this cog's commands for this message
 *     cogLoad() {}                      // optional: runs when the cog is loaded
 *     cogUnload() {}                    // optional: runs on bot.unload / bot.reload (clear timers here)
 *   }
 *
 * Inside, `this.bot` is the bot. Use arrow functions (as above) or `run(msg) { … }`; both get `this` = the cog.
 */
export class Cog {
  static yapperCog = true;
  constructor(bot) { this.bot = bot; }
}

/**
 * Builds an embed card. Every setter returns the embed, so they chain:
 *   new Embed().title('Score').url('https://…').description('**3** wins').color('#57f287')
 *     .field('Kills', '12', true).field('Deaths', '4', true).thumbnail(url).footer('Season 2').timestamp()
 * Pictures must be https links to Yapin’ uploads or common image hosts (imgur, tenor, giphy, github, wikimedia, AniList, MyAnimeList, Roblox CDN…; full list on /developers).
 * Limits: title 256, description 4096, 10 fields (name 256, value 1024), 6000 characters in all.
 */
export class Embed {
  constructor(data = {}) { this.data = { ...data }; }
  title(t) { this.data.title = String(t); return this; }
  description(t) { this.data.description = String(t); return this; }
  url(u) { this.data.url = String(u); return this; }
  /** '#5865f2', 0x5865f2 or 'red' | 'green' | 'blue' | 'yellow' | 'purple' | 'orange' | 'grey'. */
  color(c) {
    const named = { red: 0xed4245, green: 0x57f287, blue: 0x5865f2, yellow: 0xfee75c, purple: 0x9b59b6, orange: 0xe67e22, grey: 0x95a5a6, gray: 0x95a5a6 };
    this.data.color = typeof c === 'number' ? c : named[String(c).toLowerCase()] ?? parseInt(String(c).replace('#', ''), 16);
    return this;
  }
  field(name, value, inline = false) { (this.data.fields ||= []).push({ name: String(name), value: String(value), inline: !!inline }); return this; }
  author(name, { url, icon } = {}) { this.data.author = { name: String(name), url, icon_url: icon }; return this; }
  footer(text, icon) { this.data.footer = { text: String(text), icon_url: icon }; return this; }
  thumbnail(url) { this.data.thumbnail = { url: String(url) }; return this; }
  image(url) { this.data.image = { url: String(url) }; return this; }
  timestamp(t = new Date()) { this.data.timestamp = new Date(t).toISOString(); return this; }
  toJSON() { return this.data; }
}

/**
 * A button for `components`. Shortcuts: Button.primary(label, customId), .secondary, .success, .danger, Button.link(label, url).
 *   new Row(Button.success('Yes', 'vote:yes'), Button.danger('No', 'vote:no'), Button.link('Rules', 'https://example.com'))
 * Limits: 5 rows of 5 buttons, label 80, custom_id 100 (each one different), link urls https only.
 */
export class Button {
  constructor(data = {}) { this.data = { type: 'button', style: 'secondary', ...data }; }
  static primary(label, customId) { return new Button({ style: 'primary', label, custom_id: customId }); }
  static secondary(label, customId) { return new Button({ style: 'secondary', label, custom_id: customId }); }
  static success(label, customId) { return new Button({ style: 'success', label, custom_id: customId }); }
  static danger(label, customId) { return new Button({ style: 'danger', label, custom_id: customId }); }
  static link(label, url) { return new Button({ style: 'link', label, url }); }
  style(s) { this.data.style = s; return this; }
  label(t) { this.data.label = String(t); return this; }
  /** One emoji: '🔥', a server emoji '<:name:id>' or { id, name, animated }. */
  emoji(e) { this.data.emoji = e && typeof e === 'object' ? { ...e } : String(e); return this; }
  id(customId) { this.data.custom_id = String(customId); return this; }
  url(u) { this.data.style = 'link'; this.data.url = String(u); delete this.data.custom_id; return this; }
  disabled(on = true) { this.data.disabled = !!on; return this; }
  toJSON() { return this.data; }
}

/**
 * A select menu (dropdown), alone in its row: new Row(new Select('food').option('Pizza', 'pizza').option('Taco', 'taco')).
 * Picks come to onSelect with i.values. Up to 25 options; min/max picks default to 1. In a Modal give it a label.
 * In testing (flag bot_selects).
 */
export class Select {
  constructor(customId, options = []) {
    this.data = { type: 'select', custom_id: String(customId), options: [] };
    for (const o of options) this.data.options.push(plain(o));
  }
  /** One choice: label shown, value sent back. opts: { description, emoji, default }. */
  option(label, value, { description, emoji, default: on } = {}) {
    const o = { label: String(label), value: String(value ?? label) };
    if (description) o.description = String(description);
    if (emoji) o.emoji = typeof emoji === 'object' ? { ...emoji } : String(emoji);
    if (on) o.default = true;
    this.data.options.push(o);
    return this;
  }
  placeholder(t) { this.data.placeholder = String(t); return this; }
  /** Fewest picks (0 to 25). */
  min(n) { this.data.min_values = n; return this; }
  /** Most picks (1 to 25). */
  max(n) { this.data.max_values = n; return this; }
  disabled(on = true) { this.data.disabled = !!on; return this; }
  /** In a Modal: the question above it. */
  label(t) { this.data.label = String(t); return this; }
  /** In a Modal: must something be picked (default true). */
  required(on = true) { this.data.required = !!on; return this; }
  /** In a Modal: smaller text under the label. */
  description(t) { this.data.description = String(t); return this; }
  toJSON() { return this.data; }
}

/**
 * A text box for a Modal: TextInput.short('name', 'Your name') or TextInput.paragraph('why', 'Why?').
 * Answers come back in i.values[customId] ("" when an optional one is skipped). Up to 4000 characters.
 */
export class TextInput {
  constructor(customId, label, style = 'short') { this.data = { type: 'text_input', custom_id: String(customId), label: String(label), style }; }
  static short(customId, label) { return new TextInput(customId, label, 'short'); }
  static paragraph(customId, label) { return new TextInput(customId, label, 'paragraph'); }
  /** Must be filled in (default true). */
  required(on = true) { this.data.required = !!on; return this; }
  /** Fewest and most characters. */
  length(min, max) { if (min !== undefined && min !== null) this.data.min_length = min; if (max !== undefined && max !== null) this.data.max_length = max; return this; }
  /** Filled in already. */
  value(v) { this.data.value = String(v); return this; }
  placeholder(t) { this.data.placeholder = String(t); return this; }
  /** Smaller text under the label. */
  description(t) { this.data.description = String(t); return this; }
  toJSON() { return this.data; }
}

/**
 * A form that pops up for the person: i.showModal(new Modal('apply', 'Apply', TextInput.paragraph('why', 'Why?'))).
 * Up to 5 inputs (TextInput or Select with a label). It comes back to onModal('apply', (i) => …) with i.values.
 * Only as the first answer to a click, a pick or a /command (msg.showModal). In testing (flag bot_modals).
 */
export class Modal {
  constructor(customId, title, ...inputs) { this.customId = String(customId); this.title = String(title); this.inputs = inputs.flat(); }
  add(...inputs) { this.inputs.push(...inputs.flat()); return this; }
  toJSON() { return { custom_id: this.customId, title: this.title, components: this.inputs.map(plain) }; }
}

/** A row of up to 5 buttons, or one Select. Works under a normal message and inside a Components V2 layout. */
export class Row {
  constructor(...buttons) { this.buttons = buttons.flat(); }
  add(...buttons) { this.buttons.push(...buttons.flat()); return this; }
  toJSON() { return { type: 'row', components: this.buttons.map(plain) }; }
}

// ---- Components V2 (bot.sendLayout): layout components, standard JSON shape and type numbers ----
const COLORS = { red: 0xed4245, green: 0x57f287, blue: 0x5865f2, yellow: 0xfee75c, purple: 0x9b59b6, orange: 0xe67e22, grey: 0x95a5a6, gray: 0x95a5a6 };
const colorOf = (c) => (typeof c === 'number' ? c : COLORS[String(c).toLowerCase()] ?? parseInt(String(c).replace('#', ''), 16));
const textOf = (t) => (t instanceof TextDisplay ? t : new TextDisplay(t));

/** Markdown text (type 10). Mentions, links and emoji work like in messages; no HTML. */
export class TextDisplay {
  constructor(content) { this.content = String(content); }
  toJSON() { return { type: 10, content: this.content }; }
}

/** A small picture (type 11), only as a Section's accessory. */
export class Thumbnail {
  constructor(url, { description, spoiler } = {}) { this.data = { type: 11, media: { url: String(url) }, description, spoiler: spoiler || undefined }; }
  toJSON() { return this.data; }
}

/** 1 to 3 lines of text with a button or a thumbnail beside them (type 9). */
export class Section {
  constructor(...texts) { this.texts = texts.flat().map(textOf); this.side = null; }
  text(t) { this.texts.push(textOf(t)); return this; }
  /** A Button, or a Thumbnail (or just a picture url). */
  accessory(a) { this.side = typeof a === 'string' ? new Thumbnail(a) : a; return this; }
  toJSON() { return { type: 9, components: this.texts.map(plain), accessory: plain(this.side) }; }
}

/** 1 to 10 pictures or videos in a grid (type 12). */
export class MediaGallery {
  constructor(...urls) { this.items = []; for (const u of urls.flat()) this.add(u); }
  add(url, { description, spoiler } = {}) { this.items.push({ media: { url: String(url) }, description, spoiler: spoiler || undefined }); return this; }
  toJSON() { return { type: 12, items: this.items }; }
}

/** A line or empty space (type 14). `new Separator({ divider: false, spacing: 'large' })`. */
export class Separator {
  constructor({ divider = true, spacing = 'small' } = {}) { this.data = { type: 14, divider: !!divider, spacing: spacing === 'large' || spacing === 2 ? 2 : 1 }; }
  toJSON() { return this.data; }
}

/** A file to download (type 13): an https link to a Yapin’ upload or an allowed host. */
export class FileComponent {
  constructor(url, { spoiler } = {}) { this.data = { type: 13, file: { url: String(url) }, spoiler: spoiler || undefined }; }
  toJSON() { return this.data; }
}

/** A card holding other components (type 17), with an optional accent colour bar and spoiler. */
export class Container {
  constructor(...components) { this.parts = components.flat(); this.data = { type: 17 }; }
  /** '#5865f2', 0x5865f2 or 'red' | 'green' | 'blue' | 'yellow' | 'purple' | 'orange' | 'grey'. */
  accent(c) { this.data.accent_color = colorOf(c); return this; }
  spoiler(on = true) { this.data.spoiler = !!on; return this; }
  add(...components) { this.parts.push(...components.flat()); return this; }
  text(t) { return this.add(textOf(t)); }
  separator(opts) { return this.add(new Separator(opts)); }
  /** Plain strings become text displays. */
  toJSON() { return { ...this.data, components: this.parts.map((p) => plain(typeof p === 'string' ? new TextDisplay(p) : p)) }; }
}

export default Bot;

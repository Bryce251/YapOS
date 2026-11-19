import { looksLikeFeatureOff } from './errors.js';

export const OPTION_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'user', 'channel', 'role']);
export const MAX_OPTIONS = 10;
export const MAX_CHOICES = 25;
const OPTION_NAME_RE = /^[a-z0-9_-]{1,32}$/;
const CAP = 'command_options';

const opt = (name, type, description, extra = {}) => ({ name, type, description, required: false, ...extra });
const userOpt = (description, required = false) => opt('user', 'user', description, { required });
const reasonOpt = (description = 'Why (shows in the mod log)') => opt('reason', 'string', description);

export const DEFAULT_COMMAND_OPTIONS = {
  mod: [
    opt('action', 'string', 'What to do, like timeout, ban, warn, note, user, purge', {
      choices: ['timeout', 'untimeout', 'kick', 'ban', 'unban', 'warn', 'warnings', 'case', 'cases', 'purge', 'slowmode', 'lock', 'unlock', 'note', 'notes', 'unnote', 'user', 'log', 'settings', 'modrole', 'adminrole'],
    }),
    userOpt('Who it is about'),
    opt('details', 'string', 'Length, amount or reason, like 10m spamming'),
  ],
  warn: [userOpt('Who to warn', true), reasonOpt()],
  timeout: [userOpt('Who to time out', true), opt('length', 'string', 'How long, like 10m or 2h30m (off clears it)'), reasonOpt()],
  kick: [userOpt('Who to kick', true), reasonOpt()],
  ban: [userOpt('Who to ban', true), opt('length', 'string', 'Lift it after, like 7d (leave out for permanent)'), reasonOpt()],
  purge: [opt('amount', 'integer', 'How many recent messages, up to 100'), userOpt('Only this person')],
  lock: [opt('channel', 'string', 'Which channel (this one if left out)'), reasonOpt()],
  unlock: [opt('channel', 'string', 'Which channel (this one if left out)')],
  case: [opt('number', 'integer', 'Case number (leave out for recent ones)'), opt('change', 'string', 'reason new text, to change the reason')],
  ticket: [opt('action', 'string', 'close, claim, add, remove, rename, or a topic to open one'), opt('details', 'string', 'The person, new name, reason or topic')],
  tickets: [
    opt('setting', 'string', 'What to set up', { choices: ['panel', 'staff', 'log', 'category', 'types', 'type', 'limit', 'ping', 'autoclose', 'tidy', 'settings'] }),
    opt('value', 'string', 'Channel, role, number or off'),
  ],
  roles: [opt('action', 'string', 'new, add, open, set, item, preview, tidy, reset, delete, list or help'), opt('menu', 'string', 'Menu id like m1'), opt('details', 'string', 'Role, emoji and label, like @Gamer 🎮')],
  verify: [opt('action', 'string', 'setup, status, test, panel, on, off, unlock or user'), opt('details', 'string', 'The person to let in, or the setup step')],
  clan: [opt('action', 'string', 'create, join, invite, accept, leave, top, info, deposit, upgrade or privacy'), opt('details', 'string', 'Clan name and tag, a person, a tag or an amount')],
};

function choiceProblem(c) {
  if (typeof c === 'string' || typeof c === 'number') return String(c).length > 100 || String(c).length === 0 ? 'a choice is empty or over 100 characters' : null;
  if (c && typeof c === 'object' && (typeof c.value === 'string' || typeof c.value === 'number')) {
    const label = String(c.name ?? c.value);
    return label.length > 100 || String(c.value).length > 100 || !label.length ? 'a choice is empty or over 100 characters' : null;
  }
  return 'a choice must be text, a number or { name, value }';
}

export function optionsProblem(list) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) return 'options must be a list';
  if (list.length > MAX_OPTIONS) return `up to ${MAX_OPTIONS} options`;
  const seen = new Set();
  let optional = false;
  for (const o of list) {
    if (!o || typeof o !== 'object') return 'each option must be an object';
    if (!OPTION_NAME_RE.test(String(o.name))) return `bad option name "${o.name}"`;
    if (seen.has(o.name)) return `option "${o.name}" is listed twice`;
    seen.add(o.name);
    if (!OPTION_TYPES.has(o.type)) return `option "${o.name}" has an unknown type`;
    if (o.description !== undefined && String(o.description).length > 100) return `option "${o.name}" description is over 100 characters`;
    if (o.required && optional) return `required option "${o.name}" comes after an optional one`;
    if (!o.required) optional = true;
    if (o.choices !== undefined) {
      if (!['string', 'integer', 'number'].includes(o.type)) return `option "${o.name}" can't have choices`;
      if (!Array.isArray(o.choices) || !o.choices.length || o.choices.length > MAX_CHOICES) return `option "${o.name}" needs 1 to ${MAX_CHOICES} choices`;
      for (const c of o.choices) {
        const bad = choiceProblem(c);
        if (bad) return `option "${o.name}": ${bad}`;
      }
    }
  }
  return null;
}

export function wireOptions(list) {
  return list.map((o) => {
    const out = { name: o.name, type: o.type, required: !!o.required, description: String(o.description || o.name).slice(0, 100) };
    if (o.choices) out.choices = o.choices.map((c) => (c && typeof c === 'object' ? { name: String(c.name ?? c.value), value: c.value } : { name: String(c), value: c }));
    return out;
  });
}

export function isRefusal(e) {
  const s = e?.status;
  if (s === 400 || s === 422) return true;
  if (looksLikeFeatureOff(e)) return true;
  return (s === 403 || s === 404) && /isn't on|is not on|not on for|feature_off|option/i.test(String(e?.message || ''));
}

export function createCommandOptions(engine) {
  const declared = new Map();
  const { bot, caps, log } = engine;
  let orig = null;
  const stats = { sent: 0, refused: 0, lastError: null };

  function optionsFor(name) {
    const n = String(name || '').toLowerCase();
    if (declared.has(n)) return declared.get(n);
    return Object.hasOwn(DEFAULT_COMMAND_OPTIONS, n) ? DEFAULT_COMMAND_OPTIONS[n] : null;
  }

  function declare(name, list) {
    const n = String(name).toLowerCase();
    if (list === undefined) return;
    declared.set(n, Array.isArray(list) ? list : null);
  }

  function forget(name) { declared.delete(String(name).toLowerCase()); }

  function withOptions(commands) {
    let any = false;
    const out = commands.map((c) => {
      const list = optionsFor(c?.name);
      if (!list?.length || optionsProblem(list)) return c;
      any = true;
      return { ...c, options: wireOptions(list) };
    });
    return any ? out : null;
  }

  async function api(method, path, body, opts) {
    if (method !== 'PUT' || path !== '/commands' || !body || !Array.isArray(body.commands) || caps.state(null, CAP) === false) return orig(method, path, body, opts);
    const commands = withOptions(body.commands);
    if (!commands) return orig(method, path, body, opts);
    try {
      const out = await orig(method, path, { ...body, commands }, opts);
      stats.sent++;
      if (caps.state(null, CAP) !== true) caps.mark(null, CAP, true);
      return out;
    } catch (e) {
      if (!isRefusal(e)) throw e;
      stats.refused++;
      stats.lastError = String(e?.message || e?.status || 'refused');
      caps.mark(null, CAP, false, e?.message);
      log?.info?.('command hints were refused, so commands are registered without them');
      return orig(method, path, body, opts);
    }
  }

  function install() {
    if (bot.api?.yaposCommandOptions) return;
    const base = bot.api;
    orig = (method, path, body, opts) => base.call(bot, method, path, body, opts);
    api.yaposCommandOptions = true;
    bot.api = api;
  }

  return { install, optionsFor, declare, forget, withOptions, stats, get on() { return caps.state(null, CAP); } };
}

export function commandOptionsFor(engine) {
  if (!engine.commandOptions) {
    engine.commandOptions = createCommandOptions(engine);
    engine.commandOptions.install();
  }
  return engine.commandOptions;
}

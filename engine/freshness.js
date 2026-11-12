export const LATE_MS = 2 * 60_000;
const WAKE_QUIET_MS = 5000;
const COMMAND_RE = /^([a-z0-9_-]{1,32})(?:\s+[\s\S]*)?$/i;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function eventTime(ev) {
  const raw = ev?.created_at ?? ev?.data?.created_at;
  if (raw === undefined || raw === null) return null;
  const t = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function emptyWake() {
  return { commands: 0, slash: 0, clicks: 0, dms: 0, lateEvents: 0, oldestAgeMs: 0, startedAt: null };
}

export function createFreshness({ bot, engine, log, lateMs = LATE_MS, now = () => Date.now(), quietMs = WAKE_QUIET_MS } = {}) {
  const skipped = { commands: 0, slash: 0, clicks: 0, dms: 0 };
  let lateEvents = 0;
  let wake = emptyWake();
  let lastWake = null;
  let timer = null;

  function ageOf(ev) {
    const t = eventTime(ev);
    return t === null ? 0 : now() - t;
  }

  function isLate(ev) {
    return ageOf(ev) > lateMs;
  }

  function typedCommand(data) {
    const forOther = Array.isArray(data.command_for) && !data.command_for.includes(bot.me?.id);
    if (forOther) return null;
    if (data.command && bot.commands.has(String(data.command).toLowerCase())) return String(data.command).toLowerCase();
    const content = String(data.content || '');
    for (const p of [...(bot.prefixes || ['/', '!'])].sort((a, b) => b.length - a.length)) {
      if (!p || !content.startsWith(p)) continue;
      const m = COMMAND_RE.exec(content.slice(p.length));
      if (m && bot.commands.has(m[1].toLowerCase())) return m[1].toLowerCase();
    }
    return null;
  }

  function looksLikeDmCommand(data) {
    const content = String(data.content || '').trim();
    if (!content) return false;
    if (/^[/!]\S/.test(content)) return true;
    const word = content.split(/\s+/)[0].toLowerCase();
    if (bot.commands.has(word)) return true;
    const yapWords = engine?.yap?.words?.() || [];
    return yapWords.includes(word);
  }

  function note(kind, ev) {
    lateEvents++;
    wake.lateEvents++;
    if (wake.startedAt === null) wake.startedAt = now();
    wake.oldestAgeMs = Math.max(wake.oldestAgeMs, ageOf(ev));
    if (kind) { skipped[kind]++; wake[kind]++; }
    clearTimeout(timer);
    timer = setTimeout(flush, quietMs);
    timer.unref?.();
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!wake.lateEvents) return null;
    const done = { ...wake, endedAt: now() };
    wake = emptyWake();
    lastWake = done;
    const cmds = done.commands + done.slash + done.dms;
    const parts = [];
    if (cmds) parts.push(`Skipped ${plural(cmds, 'old command', 'old commands')} from while I was asleep`);
    if (done.clicks) parts.push(`${parts.length ? 'and' : 'Skipped'} ${plural(done.clicks, 'old button press', 'old button presses')}${cmds ? '' : ' from while I was asleep'}`);
    if (parts.length) log?.warn(`${parts.join(' ')}.`);
    else log?.info(`Caught up on ${plural(done.lateEvents, 'old event', 'old events')} from while I was asleep.`);
    return done;
  }

  async function answerLate(data, content) {
    try {
      await bot.respond(data, 'ephemeral', { content });
    } catch (e) {
      log?.debug('could not answer a late interaction', e?.message);
    }
  }

  function markLate(ev, data) {
    const marked = { ...data, yaposLate: true };
    return { ...ev, yaposLate: true, data: marked };
  }

  async function filter(ev) {
    if (!ev || typeof ev !== 'object' || !isLate(ev)) {
      if (wake.lateEvents) flush();
      return ev;
    }
    const data = ev.data || {};
    switch (ev.type) {
      case 'message': {
        const cmd = typedCommand(data);
        if (!cmd) { note(null, ev); return markLate(ev, data); }
        note('commands', ev);
        const out = markLate(ev, { ...data, command: undefined, args: undefined, command_for: [] });
        out.yaposSkippedCommand = cmd;
        out.data.yaposSkippedCommand = cmd;
        return out;
      }
      case 'command': {
        note('slash', ev);
        const cmd = String(data.command || '').toLowerCase();
        await answerLate(data, `I was offline when you sent this, so I didn't run it. Please run /${cmd} again.`);
        return null;
      }
      case 'interaction': {
        note('clicks', ev);
        const text = data.type === 'modal_submit'
          ? 'That form reached me late (I was offline). Please send it again.'
          : 'That button press reached me late (I was offline). Please press it again.';
        await answerLate(data, text);
        return null;
      }
      case 'dm_message': {
        if (looksLikeDmCommand(data)) { note('dms', ev); return null; }
        note(null, ev);
        return markLate(ev, data);
      }
      default:
        note(null, ev);
        return markLate(ev, data);
    }
  }

  function install() {
    if (bot.handle?.yaposFresh) return;
    const original = bot.handle.bind(bot);
    const wrapped = async (ev) => {
      const next = await filter(ev);
      if (next) return original(next);
      return undefined;
    };
    wrapped.yaposFresh = true;
    bot.handle = wrapped;
  }

  function dispose() {
    clearTimeout(timer);
    timer = null;
  }

  return {
    get lateMs() { return lateMs; },
    get skipped() { return { ...skipped }; },
    get lateEvents() { return lateEvents; },
    get lastWake() { return lastWake ? { ...lastWake } : null; },
    get pending() { return wake.lateEvents ? { ...wake } : null; },
    stats() {
      return { lateMs, skipped: { ...skipped }, lateEvents, lastWake: lastWake ? { ...lastWake } : null, pending: wake.lateEvents ? { ...wake } : null };
    },
    isLate,
    ageOf,
    filter,
    flush,
    install,
    dispose,
  };
}

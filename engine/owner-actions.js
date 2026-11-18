import { GLOBAL_KEY, CURRENCY, allowGiver, denyGiver, ownerIds, grantBadge, revokeBadge, parseSeasonBadge, seasonMonth, seasonName, seasonBadgeText, withGiftBadges, BADGE_ID_RE, SEASON_KINDS, isCustomBadge, customBadges, FOUNDER_BADGE, FOUNDER_ONLY, founderAllowed } from './global.js';
import { profileSync } from './profiles-sync.js';
import { privacyOf, achievementsOf } from './profile-data.js';

export const OWNER_NS = 'owner';
export const OWNER_LOG_KEY = 'applied';
export const OWNER_BATCH = 50;
export const OWNER_KEEP = 2000;
export const RESULTS_PER_POST = 100;

const SAFE_ID = /^[\w-]{1,64}$/;
const MAX_MESSAGE = 300;
const DM_MS = 5000;
const SEASON_CATALOG_MONTHS = 12;
const SEASON_CATALOG_TOP = 3;
const CHECK_MS = 5000;
const CHECK_KEEP_MS = 10 * 60_000;
export const NO_ACCOUNT = "No Yapin' account has this id, so nothing was changed. Check the id.";
const ACCOUNT_FREE = new Set(['giver.revoke']);

export const OWNER_KINDS = Object.freeze([
  'shards.add', 'shards.remove', 'shards.set',
  'xp.add', 'xp.remove', 'level.set',
  'achievement.grant', 'achievement.revoke',
  'badge.grant', 'badge.revoke',
  'giver.grant', 'giver.revoke',
  'quests.reset', 'streak.set',
  'party.stats.add',
]);

const AMOUNTS = Object.freeze({
  'shards.add': { min: 1, max: 1e12 },
  'shards.remove': { min: 1, max: 1e12 },
  'shards.set': { min: 0, max: 1e12 },
  'xp.add': { min: 1, max: 1e9 },
  'xp.remove': { min: 1, max: 1e9 },
  'level.set': { min: 0, max: 100_000 },
  'streak.set': { min: 0, max: 10_000 },
});
const NEEDS_REF = new Set(['achievement.grant', 'achievement.revoke', 'badge.grant', 'badge.revoke']);
const GIFTS = new Set(['shards.add', 'xp.add', 'achievement.grant', 'badge.grant', 'giver.grant', 'level.set', 'streak.set']);

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fmt = (n) => Math.max(0, Math.trunc(Number(n) || 0)).toLocaleString('en-US');
const clipText = (s, max = MAX_MESSAGE) => {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return Array.from(t).slice(0, max).join('');
};

function wholeNumber(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v === 'string' && /^\d{1,16}$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function idOf(raw) {
  if (!plain(raw)) return null;
  const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id).trim() : '';
  return SAFE_ID.test(id) ? id : null;
}

export function cleanAction(raw) {
  const id = idOf(raw);
  if (!id) return null;
  const fail = (error) => ({ id, error });
  const user = typeof raw.user === 'string' ? raw.user.trim() : '';
  if (!SAFE_ID.test(user)) return fail("That doesn't look like a real user id, so I left it alone.");
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
  if (!OWNER_KINDS.includes(kind)) return fail("I don't know that kind of change, so I skipped it.");
  if (kind === 'party.stats.add') return fail('Party stats are changed on the website itself, not by the bot.');
  const box = plain(raw.value) ? raw.value : null;
  const notify = raw.notify === true || box?.notify === true;
  const out = { id, user, kind, notify };
  const limits = AMOUNTS[kind];
  if (limits) {
    const value = box ? box.amount ?? box.value ?? box.n : raw.value;
    if (typeof value === 'string' && /inf|∞/i.test(value)) return fail('Unlimited amounts are not allowed here. Pick a whole number.');
    const n = wholeNumber(value);
    if (n === null) return fail('That amount must be a whole number.');
    if (n < limits.min || n > limits.max) return fail(`That amount must be between ${fmt(limits.min)} and ${fmt(limits.max)}.`);
    out.amount = n;
  }
  if (NEEDS_REF.has(kind)) {
    const ref = typeof raw.ref === 'string' ? raw.ref.trim() : box && typeof box.id === 'string' ? box.id.trim() : '';
    if (!BADGE_ID_RE.test(ref)) return fail(kind.startsWith('achievement') ? "That achievement id doesn't look right." : "That badge id doesn't look right.");
    out.ref = ref;
  }
  return out;
}

function readLog(engine) {
  const doc = engine.store.get(OWNER_NS, OWNER_LOG_KEY, null);
  return plain(doc) ? doc : {};
}

function writeRecord(engine, id, rec) {
  engine.store.update(OWNER_NS, OWNER_LOG_KEY, (cur) => {
    const doc = plain(cur) ? cur : {};
    doc[id] = rec;
    const keys = Object.keys(doc);
    if (keys.length > OWNER_KEEP) {
      const old = keys
        .filter((k) => doc[k]?.posted === true)
        .sort((a, b) => (Number(doc[a]?.at) || 0) - (Number(doc[b]?.at) || 0))
        .slice(0, keys.length - OWNER_KEEP);
      for (const k of old) delete doc[k];
    }
    return doc;
  }, {});
}

function editRecords(engine, ids, fn) {
  if (!ids.length) return;
  engine.store.update(OWNER_NS, OWNER_LOG_KEY, (cur) => {
    const doc = plain(cur) ? cur : {};
    for (const id of ids) if (plain(doc[id])) fn(doc[id]);
    return doc;
  }, {});
}

export function createOwnerActions(engine, { now = () => Date.now(), partyStats = null, dm = true } = {}) {
  const log = engine.log;
  let changedProfiles = false;
  const checked = new Map();
  let unreachable = false;

  async function accountOf(user) {
    const hit = checked.get(user);
    if (hit && now() - hit.at < CHECK_KEEP_MS) return hit.state;
    if (typeof engine.bot?.user !== 'function' || unreachable) return 'unknown';
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve('unknown'), CHECK_MS);
      timer.unref?.();
    });
    const ask = Promise.resolve()
      .then(() => engine.bot.user(user))
      .then((u) => (u && typeof u === 'object' ? 'real' : 'fake'))
      .catch((e) => (e?.status === 404 ? 'fake' : 'unknown'));
    let state;
    try {
      state = await Promise.race([ask, late]);
    } finally {
      clearTimeout(timer);
    }
    if (state !== 'unknown') checked.set(user, { at: now(), state });
    else unreachable = true;
    return state;
  }

  function achievementIds() {
    try {
      const list = engine.service?.('achievements')?.catalog?.();
      return new Set(Array.isArray(list) ? list.map((a) => a?.id).filter((x) => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  }

  function achievementName(id) {
    try {
      const a = engine.service?.('achievements')?.catalog?.()?.find?.((x) => x?.id === id);
      return a ? `${a.emoji ? `${a.emoji} ` : ''}${a.label}` : id;
    } catch {
      return id;
    }
  }

  function badgeList() {
    try {
      const list = engine.service?.('levels')?.badges?.();
      return Array.isArray(list) ? list.filter((b) => b && typeof b.id === 'string' && BADGE_ID_RE.test(b.id)) : [];
    } catch {
      return [];
    }
  }

  function badgeName(id) {
    const season = parseSeasonBadge(id);
    if (season) return `#${season.rank} ${season.kind === 'xp' ? 'XP' : CURRENCY.name} · ${seasonName(season.month)}`;
    const b = isCustomBadge(id) ? customBadges(engine).find((x) => x.id === id) : badgeList().find((x) => x.id === id);
    return b ? `${b.emoji ? `${b.emoji} ` : ''}${b.label}` : id;
  }

  function catalog() {
    let achievements = [];
    try {
      const list = engine.service?.('achievements')?.catalog?.();
      if (Array.isArray(list)) {
        achievements = list
          .filter((a) => a && typeof a.id === 'string' && BADGE_ID_RE.test(a.id))
          .map((a) => ({ id: a.id, label: clipText(a.label, 64), emoji: clipText(a.emoji, 8), reward: Math.max(0, Math.floor(Number(a.reward) || 0)) }));
      }
    } catch (e) {
      log?.debug?.('[owner] reading achievements failed', e?.message);
    }
    const badges = badgeList().filter((b) => !isCustomBadge(b.id)).map((b) => ({ id: b.id, label: clipText(b.label, 64), emoji: clipText(b.emoji, 8) }));
    if (engine.service?.('levels') || engine.service?.('economy')) badges.push(...seasonCatalog());
    return { achievements, badges };
  }

  function pastMonths(n) {
    const [y, m] = seasonMonth(now()).split('-').map(Number);
    const out = [];
    for (let i = 1; i <= n; i++) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return out;
  }

  function seasonCatalog() {
    const out = [];
    for (const month of pastMonths(SEASON_CATALOG_MONTHS)) {
      for (const kind of SEASON_KINDS) {
        for (let rank = 1; rank <= SEASON_CATALOG_TOP; rank++) {
          const text = seasonBadgeText({ month, kind, rank });
          const at = text.indexOf(' ');
          out.push({ id: `season-${kind}-${rank}-${month}`, label: clipText(text.slice(at + 1), 64), emoji: text.slice(0, at) });
        }
      }
    }
    return out;
  }

  function needService(name, fn) {
    const svc = engine.service?.(name);
    if (!svc || typeof svc[fn] !== 'function') {
      const app = { economy: 'Economy', levels: 'Levels', achievements: 'Achievements', quests: 'Quests' }[name] || name;
      throw Object.assign(new Error(`${app} isn't loaded on the bot right now, so I couldn't do this.`), { friendly: true });
    }
    return svc;
  }

  async function apply(a) {
    const { user, kind } = a;
    if (user === engine.bot?.me?.id) return { ok: false, message: "That's the bot itself. It doesn't hold Shards, XP or badges." };
    switch (kind) {
      case 'shards.add':
      case 'shards.remove':
      case 'shards.set': {
        const eco = needService('economy', 'ownerAdjust');
        const mode = kind.slice(7);
        const max = Number(eco.maxBalance?.()) || Infinity;
        if (a.amount > max) return { ok: false, message: `Wallets stop at ${fmt(max)} ${CURRENCY.name}.` };
        const r = eco.ownerAdjust(user, mode, a.amount, mode === 'add' ? 'Owner gift' : 'Owner adjustment');
        if (!r) return { ok: false, message: "The wallet didn't accept that change." };
        const moved = Math.abs(r.real);
        const text = mode === 'add' ? `Gave ${fmt(moved)} ${CURRENCY.emoji} ${CURRENCY.name}.`
          : mode === 'remove' ? `Took ${fmt(moved)} ${CURRENCY.emoji} ${CURRENCY.name}${moved < a.amount ? ' (all they had)' : ''}.`
            : `Set their wallet to ${fmt(r.bal)} ${CURRENCY.emoji}.`;
        return { ok: true, message: `${text} They have ${fmt(r.bal)} now.`, gift: mode === 'add' && moved > 0 ? `${fmt(moved)} ${CURRENCY.emoji} ${CURRENCY.name}` : null };
      }
      case 'xp.add':
      case 'xp.remove': {
        const levels = needService('levels', 'ownerXp');
        const r = levels.ownerXp(user, kind === 'xp.add' ? a.amount : -a.amount);
        if (!r) return { ok: false, message: "Levels didn't accept that change." };
        if (r.leveledUp) rewards(user, r.level);
        const lvl = r.level !== r.before.level ? ` Level ${fmt(r.before.level)} → ${fmt(r.level)}.` : ` Still level ${fmt(r.level)}.`;
        return { ok: true, message: `${kind === 'xp.add' ? 'Added' : 'Removed'} ${fmt(Math.abs(r.xp - r.before.xp))} XP. They have ${fmt(r.xp)} XP now.${lvl}`, gift: kind === 'xp.add' && r.xp > r.before.xp ? `${fmt(r.xp - r.before.xp)} XP` : null };
      }
      case 'level.set': {
        const levels = needService('levels', 'ownerLevel');
        const max = Number(levels.maxLevel?.()) || 1000;
        if (a.amount > max) return { ok: false, message: `Levels go up to ${fmt(max)}, so I didn't change anything.` };
        const r = levels.ownerLevel(user, a.amount);
        if (!r) return { ok: false, message: "Levels didn't accept that change." };
        if (r.level > r.before.level) rewards(user, r.level);
        return { ok: true, message: `They're level ${fmt(r.level)} now (${fmt(r.xp)} XP), was ${fmt(r.before.level)}.`, gift: r.level > r.before.level ? `level ${fmt(r.level)}` : null };
      }
      case 'achievement.grant':
      case 'achievement.revoke': {
        const svc = needService('achievements', kind === 'achievement.grant' ? 'ownerGrant' : 'ownerRevoke');
        if (!achievementIds().has(a.ref)) return { ok: false, message: "That achievement doesn't exist on the bot." };
        const name = achievementName(a.ref);
        if (kind === 'achievement.grant') {
          const changed = svc.ownerGrant(user, a.ref);
          if (changed === null) return { ok: false, message: "I couldn't give that achievement." };
          return { ok: true, message: changed ? `Gave ${name}. No ${CURRENCY.name} reward was paid for it.` : `They already had ${name}.`, gift: changed ? `the ${name} achievement` : null };
        }
        const changed = svc.ownerRevoke(user, a.ref);
        if (changed === null) return { ok: false, message: "I couldn't take that achievement." };
        return { ok: true, message: changed ? `Took ${name}. It won't unlock again on its own until you give it back.` : `They didn't have ${name}. It's now blocked from unlocking on its own.` };
      }
      case 'badge.grant':
      case 'badge.revoke': {
        const season = parseSeasonBadge(a.ref);
        if (season) {
          if (season.month > seasonMonth(now())) return { ok: false, message: "That season hasn't happened yet." };
        } else if (isCustomBadge(a.ref) ? !customBadges(engine).some((b) => b.id === a.ref) : !badgeList().some((b) => b.id === a.ref)) {
          if (isCustomBadge(a.ref) && kind === 'badge.revoke') {
            revokeBadge(engine, user, a.ref);
            return { ok: true, message: 'That badge was deleted, so nobody has it anymore.' };
          }
          return { ok: false, message: isCustomBadge(a.ref) ? "That badge was deleted or hasn't reached the bot yet. Try again in a minute." : "That badge doesn't exist on the bot." };
        }
        const name = badgeName(a.ref);
        if (kind === 'badge.grant') {
          if (a.ref === FOUNDER_BADGE && !founderAllowed(engine, user)) return { ok: false, message: FOUNDER_ONLY };
          const changed = grantBadge(engine, user, a.ref);
          if (changed === null) return { ok: false, message: 'They already have as many gifted badges as a profile can hold.' };
          return { ok: true, message: changed ? `Gave the ${name} badge.` : `They already had the ${name} badge.`, gift: changed ? `the ${name} badge` : null };
        }
        const changed = revokeBadge(engine, user, a.ref);
        if (changed === null) return { ok: false, message: "I couldn't take that badge." };
        return { ok: true, message: changed ? `Took the ${name} badge off their profile.` : `They didn't have the ${name} badge.` };
      }
      case 'giver.grant':
      case 'giver.revoke': {
        const had = ownerIds(engine).includes(user);
        if (kind === 'giver.grant') {
          allowGiver(engine, user);
          return { ok: true, message: had ? `They could already hand out ${CURRENCY.name}.` : `They can hand out ${CURRENCY.name} and change earn rates now.`, gift: had ? null : `permission to hand out ${CURRENCY.name}` };
        }
        denyGiver(engine, user);
        const still = engine.isBotOwner?.(user) ? ' They are the bot owner, so they keep it anyway.' : '';
        return { ok: true, message: had ? `They can't hand out ${CURRENCY.name} anymore.${still}` : `They weren't on the list.${still}` };
      }
      case 'quests.reset': {
        const q = needService('quests', 'resetToday');
        const n = q.resetToday(user);
        if (n === null) return { ok: false, message: "I couldn't reset their quests." };
        return { ok: true, message: `Reset today's ${fmt(n)} quests. They can do and claim them again.` };
      }
      case 'streak.set': {
        const eco = needService('economy', 'setStreak');
        const r = eco.setStreak(user, a.amount);
        if (!r) return { ok: false, message: "I couldn't change their streak." };
        return { ok: true, message: `Their /daily streak is ${fmt(r.streak)} days now, was ${fmt(r.before)}.`, gift: r.streak > r.before ? `a ${fmt(r.streak)}-day /daily streak` : null };
      }
      default:
        return { ok: false, message: "I don't know that kind of change, so I skipped it." };
    }
  }

  function rewards(user, level) {
    const svc = engine.service?.('levels');
    if (typeof svc?.rewardsEverywhere !== 'function') return;
    Promise.resolve()
      .then(() => svc.rewardsEverywhere(user, level))
      .catch((e) => log?.debug?.('[owner] level rewards failed', e?.message));
  }

  async function afterOf(user, kind, ref) {
    const privacy = privacyOf(engine, user);
    const after = {};
    if (privacy.hidden) after.hidden = true;
    if (kind.startsWith('shards.')) {
      if (!privacy.showShards) after.privateShards = true;
      try {
        const n = Number(engine.service?.('economy')?.balance?.(GLOBAL_KEY, user));
        if (Number.isFinite(n)) after.shards = Math.max(0, Math.floor(n));
      } catch (e) {
        log?.debug?.('[owner] reading the balance failed', e?.message);
      }
    }
    if (kind.startsWith('xp.') || kind === 'level.set') {
      try {
        const u = engine.service?.('levels')?.getUser?.(null, user);
        if (u) {
          after.xp = Math.max(0, Math.floor(Number(u.xp) || 0));
          after.level = Math.max(0, Math.floor(Number(u.level) || 0));
        }
      } catch (e) {
        log?.debug?.('[owner] reading the level failed', e?.message);
      }
    }
    if (!privacy.hidden && kind.startsWith('achievement.')) after.achievements = achievementsOf(engine, user);
    if (!privacy.hidden && kind.startsWith('badge.') && !parseSeasonBadge(ref)) {
      let base = null;
      if (typeof partyStats === 'function') {
        try {
          base = (await partyStats([user]))?.[user]?.badges ?? null;
        } catch {
          base = null;
        }
      }
      if (Array.isArray(base)) after.badges = base;
      else after.badges = withGiftBadges(engine, user, []);
    }
    return ['shards', 'xp', 'level', 'achievements', 'badges'].some((k) => k in after) ? after : null;
  }

  async function save() {
    try {
      await engine.store.flush?.();
    } catch (e) {
      log?.debug?.('[owner] saving the owner log failed', e?.message);
    }
  }

  async function tell(user, gift) {
    if (!dm || !gift || typeof engine.bot?.dm !== 'function') return false;
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), DM_MS);
      timer.unref?.();
    });
    try {
      const channel = await Promise.race([Promise.resolve().then(() => engine.bot.dm(user)).catch(() => null), late]);
      if (!channel) return false;
      const content = `🎁 You got ${gift} from the YapOS team!`;
      if (engine.budget?.send) await engine.budget.send({ serverId: null, channelId: channel, content, priority: 'low', key: `owner:gift:${user}` });
      else await engine.bot.send(channel, content);
      return true;
    } catch (e) {
      log?.debug?.('[owner] gift DM failed', e?.message);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runOne(raw, known) {
    const id = idOf(raw);
    if (!id) return;
    const t = now();
    const prev = known[id];
    if (plain(prev)) {
      if (prev.state === 'started') {
        const rec = { at: prev.at || t, state: 'done', ok: false, message: 'YapOS restarted while doing this, so it may or may not have gone through. Check their profile before sending it again.', posted: false };
        writeRecord(engine, id, rec);
        known[id] = rec;
      } else if (prev.posted) {
        editRecords(engine, [id], (r) => { r.posted = false; });
        known[id] = { ...prev, posted: false };
      }
      return;
    }
    const a = cleanAction(raw);
    if (!a || a.error) {
      const rec = { at: t, state: 'done', ok: false, message: clipText(a?.error || "I couldn't read that change."), posted: false };
      writeRecord(engine, id, rec);
      known[id] = rec;
      return;
    }
    if (!ACCOUNT_FREE.has(a.kind) && a.user !== engine.bot?.me?.id) {
      const account = await accountOf(a.user);
      if (account === 'unknown') return;
      if (account === 'fake') {
        const rec = { at: t, state: 'done', ok: false, noAccount: true, message: NO_ACCOUNT, posted: false, user: a.user, kind: a.kind };
        writeRecord(engine, id, rec);
        known[id] = rec;
        return;
      }
    }
    writeRecord(engine, id, { at: t, state: 'started', user: a.user, kind: a.kind, posted: false });
    await save();
    let out;
    try {
      out = await apply(a);
    } catch (e) {
      log?.debug?.('[owner] applying an owner change failed', e?.message);
      out = { ok: false, message: e?.friendly ? e.message : "Something went wrong while doing this, so nothing more was changed." };
    }
    let after = null;
    if (out.ok) {
      try { profileSync(engine).markDirty(a.user); changedProfiles = true; } catch (e) { log?.debug?.('[owner] marking the profile failed', e?.message); }
      try { after = await afterOf(a.user, a.kind, a.ref); } catch (e) { log?.debug?.('[owner] reading the new profile failed', e?.message); }
    }
    let message = clipText(out.message);
    if (out.ok && a.notify && out.gift && GIFTS.has(a.kind)) {
      const sent = await tell(a.user, out.gift);
      message = clipText(`${message}${sent ? ' I let them know in a DM.' : " I couldn't DM them, so they weren't told."}`);
    }
    const rec = { at: t, state: 'done', ok: !!out.ok, message, posted: false, user: a.user, kind: a.kind };
    if (after) rec.after = after;
    writeRecord(engine, id, rec);
    known[id] = rec;
  }

  async function run(rows) {
    const list = Array.isArray(rows) ? rows.slice(0, OWNER_BATCH) : [];
    unreachable = false;
    const seen = new Set();
    const local = { ...readLog(engine) };
    for (const raw of list) {
      const id = idOf(raw);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      await runOne(raw, local);
    }
    if (seen.size) await save();
    if (changedProfiles) {
      changedProfiles = false;
      try {
        Promise.resolve(profileSync(engine).push()).catch((e) => log?.debug?.('[owner] pushing the new profile failed', e?.message));
      } catch (e) {
        log?.debug?.('[owner] pushing the new profile failed', e?.message);
      }
    }
    return pending();
  }

  function pending() {
    const doc = readLog(engine);
    return Object.entries(doc)
      .filter(([, r]) => plain(r) && r.state === 'done' && r.posted !== true)
      .sort((a, b) => (Number(a[1].at) || 0) - (Number(b[1].at) || 0))
      .slice(0, RESULTS_PER_POST)
      .map(([id, r]) => {
        const out = { id, ok: r.ok === true, message: r.message || (r.ok ? 'Done.' : 'That didn\'t work.') };
        if (plain(r.after)) out.after = r.after;
        if (r.noAccount === true) out.noAccount = true;
        return out;
      });
  }

  function markPosted(ids) {
    editRecords(engine, ids, (r) => { r.posted = true; });
  }

  return { run, pending, markPosted, catalog, catalogMonth: () => seasonMonth(now()), apply, record: (id) => readLog(engine)[id] || null };
}

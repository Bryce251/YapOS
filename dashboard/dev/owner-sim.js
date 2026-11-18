import { readFileSync } from 'node:fs';

export const OWNER_SIM_DELAY_MS = 2000;
export const OWNER_SIM_EVERY_MS = 1000;

export const DEV_OWNER_CATALOG = {
  achievements: [
    { id: 'msgs1k', label: 'Chatterbox', emoji: '💬', reward: 100 },
    { id: 'msgs10k', label: 'Town crier', emoji: '📣', reward: 500 },
    { id: 'level10', label: 'Rising star', emoji: '📈', reward: 100 },
    { id: 'level25', label: 'Regular', emoji: '🌟', reward: 250 },
    { id: 'level50', label: 'Legend', emoji: '👑', reward: 500 },
    { id: 'streak7', label: 'On a roll', emoji: '🔥', reward: 50 },
    { id: 'casino50', label: 'High roller', emoji: '🎰', reward: 150 },
    { id: 'party10', label: 'Party starter', emoji: '🎉', reward: 50 },
    { id: 'quests10', label: 'Errand runner', emoji: '📜', reward: 50 },
    { id: 'clanfound', label: 'Clan founder', emoji: '🛡️', reward: 50 },
  ],
  badges: [
    { id: 'early-supporter', label: 'Early supporter', emoji: '🌱' },
    { id: 'bug-hunter', label: 'Bug hunter', emoji: '🐛' },
    { id: 'event-winner', label: 'Event winner', emoji: '🏅' },
    { id: 'founder', label: 'Founder', emoji: '🔱' },
  ],
};

export const DEV_OWNER_PEOPLE = [
  { id: 'a0000000-0000-4000-8000-000000000004', username: 'sam', name: 'Sam', level: 12, xp: 2650, shards: null, badges: ['early-supporter'], achievements: ['msgs1k', 'level10'] },
  { id: 'a0000000-0000-4000-8000-000000000005', username: 'riley', name: 'Riley', level: 7, xp: 1480, shards: null, badges: [], achievements: ['msgs1k'] },
  { id: 'de7e0000-0000-4000-8000-000000000005', username: 'ozzyosprey', name: 'Ozzy', level: 3, xp: 310, shards: null, badges: [], achievements: [] },
];

export function botHandlesOwner(file) {
  try {
    return readFileSync(file, 'utf8').includes('/bot/owner/results');
  } catch {
    return false;
  }
}

export function seedOwnerPanel(db, t = Date.now()) {
  db.raw.prepare('INSERT INTO owner_catalog (id, data, updated) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').run('bot', JSON.stringify(DEV_OWNER_CATALOG), t);
  const pub = db.raw.prepare('INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?) ON CONFLICT (user_id) DO NOTHING');
  for (const p of DEV_OWNER_PEOPLE) {
    pub.run(p.id, p.username, p.username, p.name, p.level, p.xp, p.shards, JSON.stringify(p.badges), JSON.stringify(p.achievements), '[]', t);
  }
}

function list(text) {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function pick(...values) {
  for (const v of values) if (v !== null && v !== undefined) return Number(v);
  return null;
}

export function simulateOne(action, { pub, known }) {
  const value = (() => {
    try {
      return action.value === null ? null : JSON.parse(action.value);
    } catch {
      return null;
    }
  })();
  const shards = pick(known?.shards, pub?.shards) ?? 0;
  const xp = pick(known?.xp, pub?.xp) ?? 0;
  const level = pick(known?.level, pub?.level) ?? 0;
  const achievements = list(pub?.achievements);
  const badges = list(pub?.badges);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const toggle = (arr, id, on) => (on ? [...new Set([...arr, id])] : arr.filter((x) => x !== id));
  switch (action.kind) {
    case 'shards.add': return { ok: true, message: `Gave ${fmt(value)} 💎 Shards. They have ${fmt(shards + value)} now.`, after: { shards: shards + value } };
    case 'shards.remove': {
      const next = Math.max(0, shards - value);
      return { ok: true, message: `Took ${fmt(shards - next)} 💎 Shards. They have ${fmt(next)} now.`, after: { shards: next } };
    }
    case 'shards.set': return { ok: true, message: `Set their Shards to ${fmt(value)}.`, after: { shards: value } };
    case 'xp.add': return { ok: true, message: `Gave ${fmt(value)} XP.`, after: { xp: xp + value, level } };
    case 'xp.remove': return { ok: true, message: `Took ${fmt(Math.min(xp, value))} XP.`, after: { xp: Math.max(0, xp - value), level } };
    case 'level.set': return { ok: true, message: `They are level ${fmt(value)} now.`, after: { level: value, xp } };
    case 'achievement.grant':
      if (achievements.includes(action.ref)) return { ok: false, message: 'They already have that achievement.' };
      return { ok: true, message: 'Achievement given. No Shard reward was paid.', after: { achievements: toggle(achievements, action.ref, true) } };
    case 'achievement.revoke':
      if (!achievements.includes(action.ref)) return { ok: false, message: "They don't have that achievement." };
      return { ok: true, message: 'Achievement taken away.', after: { achievements: toggle(achievements, action.ref, false) } };
    case 'badge.grant': return { ok: true, message: 'Badge given.', after: { badges: toggle(badges, action.ref, true) } };
    case 'badge.revoke': return { ok: true, message: 'Badge taken away.', after: { badges: toggle(badges, action.ref, false) } };
    case 'giver.grant': return { ok: true, message: 'They can give Shards to people now.' };
    case 'giver.revoke': return { ok: true, message: "They can't give Shards any more." };
    case 'quests.reset': return { ok: true, message: "Today's quests were reset." };
    case 'streak.set': return { ok: true, message: `Their daily streak is ${fmt(value)} now.` };
    default: return { ok: false, message: "The local test bot doesn't know that one." };
  }
}

export function createOwnerSim({ db, send, now = () => Date.now(), delay = OWNER_SIM_DELAY_MS }) {
  let busy = false;
  async function tick() {
    if (busy) return 0;
    busy = true;
    try {
      const rows = db.raw.prepare("SELECT id, user_id, kind, value, ref FROM owner_actions WHERE status IN ('queued', 'sent') AND created <= ? ORDER BY created ASC, rowid ASC LIMIT 50").all(now() - delay);
      if (!rows.length) return 0;
      const results = [];
      const pending = new Map();
      for (const r of rows) {
        const pub = db.raw.prepare('SELECT level, xp, shards, badges, achievements FROM public_profiles WHERE user_id = ?').get(r.user_id) || null;
        const known = pending.get(r.user_id) || db.raw.prepare('SELECT shards, level, xp FROM owner_known WHERE user_id = ?').get(r.user_id) || null;
        const out = simulateOne(r, { pub: pending.get(`pub:${r.user_id}`) || pub, known });
        results.push({ id: r.id, ...out });
        if (out.after) {
          pending.set(r.user_id, { ...(known || {}), ...out.after });
          pending.set(`pub:${r.user_id}`, { ...(pub || {}), ...(out.after.achievements ? { achievements: JSON.stringify(out.after.achievements) } : {}), ...(out.after.badges ? { badges: JSON.stringify(out.after.badges) } : {}) });
        }
      }
      await send(results);
      return results.length;
    } finally {
      busy = false;
    }
  }
  let timer = null;
  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, OWNER_SIM_EVERY_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

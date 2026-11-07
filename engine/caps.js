import { looksLikeFeatureOff } from './errors.js';

export const CAPS = {
  selects: 'Select menus',
  modals: 'Pop-up forms (modals)',
  files: 'Sending files',
  dms: 'Direct messages',
  roles: 'Role management',
  emojis: 'Custom emojis',
  webhooks: 'Bot webhooks',
  invites: 'Invite tracking',
  events: 'Scheduled events',
  v2: 'Components V2 cards',
  activities: 'Activities',
};

export function createCaps({ settings, log, retryMs = 6 * 3600_000, now = () => Date.now() }) {
  const seen = new Map();
  const key = (sid, cap) => `${sid || 'dm'}:${cap}`;

  function state(sid, cap) {
    const forced = sid ? settings.core(sid).caps?.[cap] : undefined;
    if (forced === true || forced === false) return forced;
    const s = seen.get(key(sid, cap));
    if (!s) return null;
    if (s.on === false && now() - s.at > retryMs) return null;
    return s.on;
  }

  function mark(sid, cap, on, reason = '') {
    const prev = seen.get(key(sid, cap));
    seen.set(key(sid, cap), { on, at: now(), reason });
    if (!on && prev?.on !== false) log?.info(`capability "${cap}" looks off in server ${sid || 'DMs'}${reason ? ` (${reason})` : ''}; using the fallback`);
  }

  async function attempt(sid, cap, tryFn, fallbackFn) {
    if (state(sid, cap) === false && fallbackFn) return fallbackFn({ reason: 'known-off' });
    try {
      const out = await tryFn();
      if (state(sid, cap) !== true) mark(sid, cap, true);
      return out;
    } catch (e) {
      if (fallbackFn && (looksLikeFeatureOff(e) || e?.status === 400) && !/ephemeral/i.test(String(e?.message))) {
        mark(sid, cap, false, e?.message);
        return fallbackFn({ reason: 'failed', error: e });
      }
      throw e;
    }
  }

  function summary(sid) {
    return Object.entries(CAPS).map(([cap, label]) => ({ cap, label, state: state(sid, cap), forced: settings.core(sid).caps?.[cap] ?? null }));
  }

  return { state, mark, attempt, summary, CAPS };
}

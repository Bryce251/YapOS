const DETAIL_TTL = 60000;

export const state = {
  user: null,
  partyOwner: false,
  userChecked: false,
  servers: null,
  serversAt: 0,
  details: new Map(),
};

export function getDetail(sid) {
  const d = state.details.get(sid);
  if (!d) return null;
  return d;
}

export function isFresh(entry, ttl = DETAIL_TTL, now = Date.now()) {
  return Boolean(entry) && now - entry.at < ttl;
}

export function setDetail(sid, data) {
  const entry = {
    at: Date.now(),
    overview: data?.overview ?? null,
    apps: Array.isArray(data?.apps) ? data.apps : [],
    settings: data?.settings && typeof data.settings === 'object' ? data.settings : {},
    updatedAt: data?.updatedAt ?? null,
    level: typeof data?.level === 'string' ? data.level : '',
  };
  state.details.set(sid, entry);
  return entry;
}

export function mergeSnapshot(sid, snap) {
  const cur = state.details.get(sid);
  if (!cur || !snap || typeof snap !== 'object') return cur;
  if (Array.isArray(snap.apps)) cur.apps = snap.apps;
  if (snap.settings && typeof snap.settings === 'object') cur.settings = { ...cur.settings, ...snap.settings };
  if (snap.overview) cur.overview = snap.overview;
  if (snap.updatedAt) cur.updatedAt = snap.updatedAt;
  cur.at = Date.now();
  return cur;
}

export function serverSummary(sid) {
  const fromList = Array.isArray(state.servers) ? state.servers.find((s) => s.id === sid) : null;
  const detail = state.details.get(sid);
  const ov = detail?.overview;
  return {
    id: sid,
    name: ov?.name || fromList?.name || 'Server',
    icon_url: ov?.icon_url || fromList?.icon_url || '',
    level: detail?.level || fromList?.level || '',
  };
}

export function forgetAll() {
  state.user = null;
  state.partyOwner = false;
  state.servers = null;
  state.serversAt = 0;
  state.details.clear();
}

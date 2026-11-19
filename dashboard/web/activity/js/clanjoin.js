export const CLAN_API = '/api/clans/';
export const CLAN_TAG_RE = /^[A-Za-z0-9]{3,4}$/;
export const CLAN_POLL_MS = 3000;
export const CLAN_POLL_MAX = 60;
export const VIEWER_STATES = Object.freeze(['signed_out', 'member', 'pending', 'pending_other', 'other', 'invite_only', 'can_join']);

const HEX_RE = /^#[0-9a-f]{6}$/i;
const CODES = new Set(['joined', 'already', 'invite_only', 'in_clan', 'gone', 'bot', 'failed']);

function str(v, max = 80) {
  if (typeof v !== 'string') return '';
  const t = v.replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max).join('') : t;
}

function whole(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function clanTagOk(tag) {
  return typeof tag === 'string' && CLAN_TAG_RE.test(tag);
}

export function clanPath(tag, join = false) {
  return `${CLAN_API}${encodeURIComponent(String(tag || '').toUpperCase())}${join ? '/join' : ''}`;
}

export function clanParts(clan) {
  if (!clan || typeof clan !== 'object') return null;
  const name = str(clan.name, 40);
  const tag = str(clan.tag, 6);
  if (!name && !tag) return null;
  const same = Boolean(tag) && tag.toLowerCase() === name.toLowerCase();
  return { code: tag ? `[${tag}]` : '', name: same ? '' : name, full: tag ? `[${tag}]${same || !name ? '' : ` ${name}`}` : name };
}

const OWN_PIC = /^\/avatar-img\/a-[a-z0-9]{10}-[0-9a-f]{16}(-still)?\.(png|webp|jpg|gif)$/;
const YAPIN_PIC = /^https:\/\/(files\.yapper\.website|www\.yapin\.gg)\/[^\s"'<>\\]{1,1000}$/;

function pic(v) {
  return typeof v === 'string' && (OWN_PIC.test(v) || YAPIN_PIC.test(v)) ? v : null;
}

function person(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = str(raw.name, 64) || str(raw.username, 64);
  if (!name) return null;
  const avatar = pic(raw.avatar);
  const still = avatar ? pic(raw.avatarStill) : null;
  return { name, username: str(raw.username, 64) || null, level: whole(raw.level), leader: raw.leader === true, ...(avatar ? { avatar } : {}), ...(still ? { avatarStill: still } : {}) };
}

export function readClan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tag = str(raw.tag, 6);
  const name = str(raw.name, 40);
  if (!tag || !name) return null;
  return {
    tag,
    name,
    colour: typeof raw.colour === 'string' && HEX_RE.test(raw.colour) ? raw.colour.toLowerCase() : null,
    banner: str(raw.banner, 80) || null,
    members: whole(raw.members),
    join: raw.join === 'invite' ? 'invite' : 'open',
    leader: person(raw.leader),
    top: (Array.isArray(raw.top) ? raw.top : []).map(person).filter(Boolean).slice(0, 5),
  };
}

function readRequest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = raw.status === 'joined' || raw.status === 'refused' ? raw.status : 'pending';
  return { status, code: CODES.has(raw.code) ? raw.code : null, message: str(raw.message, 300) || null, waiting: raw.waiting === true };
}

export function readViewer(raw) {
  if (!raw || typeof raw !== 'object') return { signedIn: false, status: 'signed_out', clan: null, request: null, pendingTag: null };
  const status = VIEWER_STATES.includes(raw.status) ? raw.status : raw.signedIn ? 'can_join' : 'signed_out';
  const other = raw.clan && typeof raw.clan === 'object' ? clanParts(raw.clan) : null;
  return { signedIn: status !== 'signed_out', status, clan: other, request: readRequest(raw.request), pendingTag: str(raw.pendingTag, 6) || null };
}

export function joinState(st) {
  if (!st || st.phase === 'loading') return { tone: 'wait', text: 'Loading clan…', action: null };
  if (st.phase === 'missing') return { tone: 'bad', text: "We couldn't find this clan. It may have been disbanded.", action: null };
  if (st.phase === 'error') return { tone: 'bad', text: st.note || "We couldn't load this clan right now.", action: 'retry', label: 'Try again' };
  const clan = st.clan;
  const v = st.viewer || readViewer(null);
  const req = v.request;
  const label = `Join [${clan.tag}]`;
  const note = st.note;
  if (v.status === 'member') {
    const fresh = req && req.status === 'joined';
    return { tone: 'good', text: fresh ? `You joined [${clan.tag}] ${clan.name}!` : "You're in this clan.", action: null };
  }
  if (v.status === 'pending') return { tone: 'wait', text: (req && req.message) || 'Waiting for YapOS to add you.', action: 'join', label: 'Requested', busy: true };
  if (v.status === 'pending_other') return { tone: 'warn', text: note || `You already asked to join [${v.pendingTag || '?'}]. Wait for that to finish first.`, action: null };
  if (v.status === 'other') return { tone: 'warn', text: `You're in ${v.clan ? v.clan.full : 'another clan'}. Leave it first with /clan leave, then join here.`, action: null };
  if (v.status === 'invite_only' || (v.status === 'signed_out' && clan.join === 'invite')) return { tone: 'warn', text: 'This clan is invite only. Ask the leader for an invite.', action: null };
  if (v.status === 'signed_out') return { tone: 'info', text: note || 'Sign in to join this clan.', action: 'signin', label: 'Sign in to join' };
  const refused = req && req.status === 'refused' ? req.message : null;
  return { tone: refused || note ? 'warn' : 'info', text: note || refused || 'Anyone can join this clan.', action: 'join', label, busy: Boolean(st.busy) };
}

export function createClanJoin({ tag, request, onChange = () => {}, setTimer = null, clearTimer = null, pollMs = CLAN_POLL_MS, pollMax = CLAN_POLL_MAX } = {}) {
  let st = { phase: 'loading', tag: String(tag || '').toUpperCase(), clan: null, viewer: null, note: null, busy: false };
  let timer = null;
  let polls = 0;
  let stopped = false;
  let seq = 0;

  function set(next) {
    if (stopped) return;
    st = { ...st, ...next };
    onChange(st);
  }

  function unpoll() {
    if (timer !== null && clearTimer) clearTimer(timer);
    timer = null;
  }

  function poll() {
    unpoll();
    if (stopped || !setTimer || polls >= pollMax) return;
    polls += 1;
    timer = setTimer(() => {
      timer = null;
      load(true);
    }, pollMs);
  }

  async function call(method, path) {
    try {
      const r = await request(method, path);
      return { status: Number(r && r.status) || 0, data: r && r.data && typeof r.data === 'object' ? r.data : null };
    } catch {
      return { status: 0, data: null };
    }
  }

  function settle(viewer) {
    if (viewer.status === 'pending') poll();
    else {
      unpoll();
      polls = 0;
    }
  }

  async function load(quiet = false) {
    if (stopped) return st;
    if (!clanTagOk(st.tag)) {
      set({ phase: 'missing' });
      return st;
    }
    const mine = ++seq;
    if (!quiet) set({ phase: 'loading', note: null });
    const r = await call('GET', clanPath(st.tag));
    if (stopped || mine !== seq) return st;
    const clan = r.data ? readClan(r.data.clan) : null;
    if (r.status === 404 || r.status === 400) set({ phase: 'missing' });
    else if (!clan) {
      if (quiet && st.clan) poll();
      else set({ phase: 'error', note: r.status === 429 ? 'Too many clan lookups. Wait a minute and try again.' : null });
      return st;
    } else {
      const viewer = readViewer(r.data.viewer);
      set({ phase: 'ready', clan, viewer, busy: false, note: quiet ? st.note : null });
      settle(viewer);
    }
    return st;
  }

  async function join() {
    if (stopped || st.phase !== 'ready' || st.busy) return st;
    const now = joinState(st);
    if (now.action !== 'join' || now.busy) return st;
    const mine = ++seq;
    set({ busy: true, note: null });
    const r = await call('POST', clanPath(st.tag, true));
    if (stopped || mine !== seq) return st;
    const msg = r.data && typeof r.data.message === 'string' ? str(r.data.message, 300) : null;
    if (r.status === 404 || r.status === 400) {
      set({ phase: 'missing', busy: false });
      return st;
    }
    if (r.status === 401) {
      set({ busy: false, viewer: readViewer(null), note: msg || 'Sign in to join this clan.' });
      return st;
    }
    if (r.data && r.data.viewer) {
      const viewer = readViewer(r.data.viewer);
      const extra = r.status === 403 && r.data.error === 'invite_only' ? { clan: { ...st.clan, join: 'invite' } } : {};
      set({ busy: false, viewer, note: r.status >= 400 ? msg : null, ...extra });
      polls = 0;
      settle(viewer);
      return st;
    }
    set({ busy: false, note: r.status === 429 ? msg || 'That is a lot of join requests. Wait a minute and try again.' : msg || "That didn't go through. Try again in a moment." });
    return st;
  }

  function stop() {
    stopped = true;
    seq += 1;
    unpoll();
  }

  return {
    load,
    join,
    stop,
    get state() {
      return st;
    },
    get polling() {
      return timer !== null;
    },
  };
}

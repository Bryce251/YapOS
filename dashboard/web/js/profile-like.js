import { h, replace } from './dom.js';
import { icon } from './icons.js';
import { avatar, button, toast } from './ui.js';
import { formatNumber, formatShort, relativeTime } from './format.js';
import { ApiError, isAbort } from './api.js';
import { loginUrl, profilePath } from './router.js';
import { prefersReducedMotion } from './profile-fx.js';

export const LIKES_API = '/api/likes';
export const LIKED_BY_API = '/api/me/likes';
export const LIKED_BY_PAGE = 20;
export const POP_MS = 420;
export const PRIVATE_LIKER = 'Private profile';

export function likeWord(n) {
  return n === 1 ? 'like' : 'likes';
}

export function likeLabel(count, liked) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const said = `${formatNumber(n)} ${likeWord(n)}`;
  return liked ? `Unlike this profile. ${said}` : `Like this profile. ${said}`;
}

export function readLikeState(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    count: Math.max(0, Math.floor(Number(data.count) || 0)),
    liked: data.liked === true,
    own: data.own === true,
    signedIn: data.signedIn === true,
  };
}

export function toggled(state) {
  const liked = !state.liked;
  return { ...state, liked, count: Math.max(0, state.count + (liked ? 1 : -1)) };
}

export function readLikedBy(data) {
  const people = (Array.isArray(data?.people) ? data.people : []).filter((p) => p && typeof p === 'object').map((p) => {
    const username = !p.private && typeof p.username === 'string' && p.username ? p.username : null;
    return {
      private: !username,
      name: username ? (typeof p.name === 'string' && p.name ? p.name : username) : PRIVATE_LIKER,
      username,
      avatar: username && typeof p.avatar === 'string' ? p.avatar : '',
      still: username && typeof p.avatarStill === 'string' ? p.avatarStill : '',
      at: Number(p.at) || 0,
    };
  });
  return {
    people,
    count: Math.max(0, Math.floor(Number(data?.count) || 0)),
    more: data?.more === true,
    next: typeof data?.next === 'string' && /^[0-9]{1,16}\.[A-Za-z0-9_-]{1,64}$/.test(data.next) ? data.next : null,
  };
}

function likerRow(p) {
  const pic = avatar({ name: p.private ? '' : p.name, url: p.avatar, still: p.still, animate: false, id: p.username || 'private', size: 'sm' });
  const who = p.private
    ? h('span', { class: 'likedby-name is-private', text: PRIVATE_LIKER })
    : h('a', { class: 'likedby-name', href: profilePath(p.username), dataset: { link: '' }, text: p.name });
  return h('li', { class: 'likedby-item' },
    pic,
    h('span', { class: 'likedby-who' }, who, p.private ? null : h('span', { class: 'likedby-handle', text: `@${p.username}` })),
    p.at ? h('span', { class: 'likedby-when', text: relativeTime(p.at) }) : null);
}

export function createLikedBy({ api, signal = null, pageSize = LIKED_BY_PAGE } = {}) {
  const list = h('ul', { class: 'likedby-list' });
  const status = h('p', { class: 'likedby-status muted', attrs: { role: 'status', 'aria-live': 'polite' } });
  const more = button({ label: 'Show more', icon: 'chevron-down', size: 'sm', variant: 'ghost', className: 'likedby-more' });
  more.hidden = true;
  const total = h('span', { class: 'likedby-total' });
  const el = h('section', { class: ['profile-section', 'is-wide', 'profile-likedby'], dataset: { section: 'likedby' } },
    h('div', { class: 'profile-section-head' },
      h('h2', { class: 'profile-section-title' }, icon('heart', { size: 16 }), h('span', { text: 'Liked by' }), total)),
    status,
    list,
    more);
  let next = null;
  let busy = false;
  let loaded = false;
  async function load(reset = false) {
    if (busy) return;
    busy = true;
    more.disabled = true;
    if (reset) {
      next = null;
      replace(list);
    }
    status.textContent = loaded && !reset ? '' : 'Loading…';
    try {
      const q = new URLSearchParams({ limit: String(pageSize) });
      if (next) q.set('before', next);
      const page = readLikedBy(await api.get(`${LIKED_BY_API}?${q}`, { signal, allow401: true }));
      if (signal?.aborted) return;
      loaded = true;
      for (const p of page.people) list.appendChild(likerRow(p));
      next = page.next;
      more.hidden = !(page.more && next);
      total.textContent = page.count ? formatNumber(page.count) : '';
      status.textContent = list.children.length ? '' : 'Nobody has liked your profile yet. Share your link to get some love.';
    } catch (err) {
      if (isAbort(err) || signal?.aborted) return;
      status.textContent = err instanceof ApiError ? err.message : "Couldn't load who liked your profile.";
    } finally {
      busy = false;
      more.disabled = false;
    }
  }
  more.addEventListener('click', () => load(false));
  return { el, load, list, status, more };
}

export function createLikeButton({ api, name, signal = null, win = globalThis.window, onState = null } = {}) {
  let state = null;
  let pending = false;
  let popTimer = 0;
  const count = h('span', { class: 'like-count', text: '' });
  const heart = h('span', { class: 'like-heart', attrs: { 'aria-hidden': 'true' } }, icon('heart', { size: 16 }));
  const btn = h('button', { type: 'button', class: ['btn', 'btn-secondary', 'btn-sm', 'like-btn'], attrs: { 'aria-pressed': 'false', 'aria-label': 'Like this profile' } }, heart, count);
  const hint = h('p', { class: 'like-hint', hidden: true, attrs: { role: 'status' } });
  const el = h('div', { class: 'like-box', hidden: true }, btn, hint);

  function paint() {
    if (!state) return;
    el.hidden = false;
    count.textContent = formatShort(state.count);
    if (state.own) {
      btn.classList.add('is-own');
      btn.setAttribute('aria-disabled', 'true');
      btn.removeAttribute('aria-pressed');
      btn.setAttribute('aria-label', `${formatNumber(state.count)} ${state.count === 1 ? 'person likes' : 'people like'} your profile`);
      btn.title = 'Likes on your profile';
      return;
    }
    btn.classList.toggle('is-liked', state.liked);
    btn.setAttribute('aria-pressed', state.liked ? 'true' : 'false');
    btn.setAttribute('aria-label', likeLabel(state.count, state.liked));
    btn.title = state.liked ? 'Unlike' : 'Like';
    if (pending) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  }

  function pop() {
    if (prefersReducedMotion(win)) return;
    btn.classList.remove('is-pop');
    void btn.offsetWidth;
    btn.classList.add('is-pop');
    clearTimeout(popTimer);
    popTimer = setTimeout(() => btn.classList.remove('is-pop'), POP_MS);
  }

  function invite() {
    const here = win && win.location ? `${win.location.pathname}${win.location.search || ''}` : '/';
    replace(hint, h('span', { text: 'Sign in to like profiles. ' }), h('a', { class: 'like-signin', href: loginUrl(here), text: 'Sign in' }));
    hint.hidden = false;
  }

  async function click() {
    if (!state || state.own || pending) return;
    if (!state.signedIn) {
      invite();
      return;
    }
    const before = state;
    state = toggled(state);
    pending = true;
    if (state.liked) pop();
    paint();
    try {
      const data = await api.post(`${LIKES_API}/${encodeURIComponent(name)}`, { liked: state.liked }, { signal, allow401: true });
      if (signal?.aborted) return;
      pending = false;
      state = readLikeState(data) || state;
      paint();
      if (onState) onState(state);
    } catch (err) {
      if (isAbort(err) || signal?.aborted) return;
      pending = false;
      state = before;
      if (err instanceof ApiError && err.status === 401) {
        state = { ...before, signedIn: false };
        paint();
        invite();
        return;
      }
      paint();
      toast(err instanceof ApiError ? err.message : "Couldn't save that like. Try again.", { tone: 'danger' });
    }
  }

  btn.addEventListener('click', click);

  async function load() {
    try {
      const data = await api.get(`${LIKES_API}/${encodeURIComponent(name)}`, { signal, allow401: true });
      if (signal?.aborted) return null;
      state = readLikeState(data);
      paint();
      if (onState) onState(state);
      return state;
    } catch (err) {
      if (isAbort(err) || signal?.aborted) return null;
      el.hidden = true;
      return null;
    }
  }

  return { el, btn, load, click, get state() { return state; } };
}

export function profileLikes({ api, name, signal = null, win = globalThis.window } = {}) {
  let card = null;
  let likedBy = null;
  const like = createLikeButton({ api, name, signal, win, onState: (s) => place(s) });
  let started = false;

  function place(s) {
    if (!card) return;
    const actions = card.querySelector('.profile-actions');
    if (actions && like.el.parentNode !== actions) actions.insertBefore(like.el, actions.firstChild);
    if (s && s.own) {
      if (!likedBy) {
        likedBy = createLikedBy({ api, signal });
        likedBy.load(true);
      }
      const sections = card.querySelector('.profile-sections');
      if (sections && likedBy.el.parentNode !== sections) sections.appendChild(likedBy.el);
    }
  }

  return {
    attach(next) {
      card = next;
      place(like.state);
      if (!started) {
        started = true;
        like.load();
      }
    },
    get like() { return like; },
    get likedBy() { return likedBy; },
  };
}

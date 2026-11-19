import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installDom, flush, FakeEvent } from './dom-shim.js';

const { document, window } = installDom({ url: 'https://dash.example.test/u/bea' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { createLikeButton, createLikedBy, readLikedBy, likeLabel, toggled, profileLikes, LIKES_API, LIKED_BY_API } = await import('../web/js/profile-like.js');
const { ApiError } = await import('../web/js/api.js');
const { renderProfile } = await import('../web/js/pages/profile.js');
const { cleanCard, cardModel } = await import('../web/activity/js/ui/profilecard.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const click = (el) => el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
const EVIL = '<img src=x onerror=alert(1)>';

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

function fakeApi({ state, post, likedBy } = {}) {
  const calls = [];
  return {
    calls,
    get: async (p, opts) => {
      calls.push(['GET', p, opts]);
      if (p.startsWith(LIKED_BY_API)) return typeof likedBy === 'function' ? likedBy(p) : likedBy;
      return typeof state === 'function' ? state(p) : state;
    },
    post: async (p, body, opts) => {
      calls.push(['POST', p, body, opts]);
      return post(p, body);
    },
  };
}

test('the heart shows the count, aria-pressed and toggles with the server answer', async () => {
  const api = fakeApi({ state: { count: 4, liked: false, own: false, signedIn: true }, post: async (p, body) => ({ count: body.liked ? 5 : 4, liked: body.liked, own: false, signedIn: true }) });
  const like = createLikeButton({ api, name: 'bea', win: window });
  document.body.replaceChildren(like.el);
  await like.load();
  assert.equal(like.el.hidden, false);
  assert.equal(like.btn.getAttribute('aria-pressed'), 'false');
  assert.equal(like.btn.querySelector('.like-count').textContent, '4');
  assert.equal(like.btn.getAttribute('aria-label'), 'Like this profile. 4 likes');
  click(like.btn);
  assert.equal(like.btn.getAttribute('aria-pressed'), 'true', 'the heart fills straight away');
  assert.equal(like.btn.querySelector('.like-count').textContent, '5');
  assert.ok(like.btn.classList.contains('is-pop'));
  await flush();
  assert.deepEqual(api.calls[1].slice(0, 3), ['POST', `${LIKES_API}/bea`, { liked: true }]);
  assert.equal(like.btn.getAttribute('aria-busy'), null);
  click(like.btn);
  await flush();
  assert.equal(like.btn.getAttribute('aria-pressed'), 'false');
  assert.equal(like.btn.querySelector('.like-count').textContent, '4');
});

test('a failed like rolls back and says why', async () => {
  const api = fakeApi({ state: { count: 2, liked: false, own: false, signedIn: true }, post: async () => { throw new ApiError('Slow down a little.', { status: 429, code: 'rate_limited' }); } });
  const like = createLikeButton({ api, name: 'bea', win: window });
  document.body.replaceChildren(like.el);
  await like.load();
  click(like.btn);
  assert.equal(like.btn.querySelector('.like-count').textContent, '3');
  await flush();
  assert.equal(like.btn.getAttribute('aria-pressed'), 'false');
  assert.equal(like.btn.querySelector('.like-count').textContent, '2');
  assert.match(document.body.textContent, /Slow down a little/);
});

test('signed out clicks invite a sign in and never post', async () => {
  const api = fakeApi({ state: { count: 1, liked: false, own: false, signedIn: false }, post: async () => assert.fail('no post when signed out') });
  const like = createLikeButton({ api, name: 'bea', win: window });
  document.body.replaceChildren(like.el);
  await like.load();
  click(like.btn);
  await flush();
  const hint = like.el.querySelector('.like-hint');
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /Sign in to like profiles/);
  assert.match(hint.querySelector('a').href || hint.querySelector('a').getAttribute('href'), /^\/auth\/login\?next=%2Fu%2Fbea/);
  assert.equal(api.calls.filter((c) => c[0] === 'POST').length, 0);
});

test('reduced motion skips the pop', async () => {
  const still = { ...window, matchMedia: () => ({ matches: true }) };
  const api = fakeApi({ state: { count: 0, liked: false, own: false, signedIn: true }, post: async () => ({ count: 1, liked: true, own: false, signedIn: true }) });
  const like = createLikeButton({ api, name: 'bea', win: still });
  await like.load();
  click(like.btn);
  assert.equal(like.btn.classList.contains('is-pop'), false);
  await flush();
});

test('a missing or private profile hides the heart', async () => {
  const api = fakeApi({ state: async () => { throw new ApiError('nope', { status: 404, code: 'not_found' }); } });
  const like = createLikeButton({ api, name: 'ghost', win: window });
  await like.load();
  assert.equal(like.el.hidden, true);
});

test('liked by lists names as text, links open profiles and pages on', async () => {
  const pages = [
    { people: [{ name: EVIL, username: 'sam', avatar: 'https://files.yapper.website/s.png', at: Date.now() - 60000 }, { private: true, name: 'Private profile', username: null, at: Date.now() - 120000 }], count: 3, more: true, next: '1700.abc' },
    { people: [{ name: 'Al', username: 'al', at: Date.now() - 180000 }], count: 3, more: false, next: null },
  ];
  const api = fakeApi({ likedBy: () => pages.shift() });
  const box = createLikedBy({ api, pageSize: 2 });
  document.body.replaceChildren(box.el);
  await box.load(true);
  const items = box.list.querySelectorAll('.likedby-item');
  assert.equal(items.length, 2);
  const link = items[0].querySelector('a.likedby-name');
  assert.equal(link.textContent, EVIL);
  assert.equal(link.getAttribute('href') || link.href, '/u/sam');
  assert.equal(walk(box.el).some((n) => n.localName === 'img' && /onerror/.test(n.getAttribute?.('src') || '')), false);
  assert.equal(items[1].querySelector('a'), null, 'private likers are not links');
  assert.equal(items[1].querySelector('.likedby-name').textContent, 'Private profile');
  assert.equal(box.more.hidden, false);
  click(box.more);
  await flush();
  assert.match(api.calls[1][1], /before=1700\.abc/);
  assert.equal(box.list.querySelectorAll('.likedby-item').length, 3);
  assert.equal(box.more.hidden, true);
});

test('an empty liked by list says so', async () => {
  const api = fakeApi({ likedBy: { people: [], count: 0, more: false, next: null } });
  const box = createLikedBy({ api });
  await box.load(true);
  assert.match(box.status.textContent, /Nobody has liked your profile yet/);
});

test('helpers read server data defensively', () => {
  assert.equal(likeLabel(1, true), 'Unlike this profile. 1 like');
  assert.deepEqual(toggled({ count: 0, liked: true, own: false, signedIn: true }), { count: 0, liked: false, own: false, signedIn: true });
  const read = readLikedBy({ people: [{ username: 'x', name: 'X', avatar: 5 }, { private: true, username: 'leak', name: 'Leak' }, null], next: 'bad cursor', more: true });
  assert.equal(read.people.length, 2);
  assert.equal(read.people[0].avatar, '');
  assert.equal(read.people[1].name, 'Private profile');
  assert.equal(read.people[1].username, null);
  assert.equal(read.next, null);
});

const PROFILE = { profile: { username: 'bea', name: 'Bea', level: 3, xp: 400, shards: null, badges: [], achievements: [], season: [], party: { games: 1, wins: 0, favourites: [] } }, partyBadges: [], catalog: { badges: [], achievements: [] } };

function mountProfile(likeState, likedBy) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const ctrl = new AbortController();
  const seen = [];
  const ctx = {
    params: { name: 'bea' },
    signal: ctrl.signal,
    api: {
      get: async (p) => {
        seen.push(p);
        if (p.startsWith(LIKED_BY_API)) return likedBy;
        if (p.startsWith(LIKES_API)) return likeState;
        return PROFILE;
      },
      post: async () => ({}),
    },
    setTitle() {},
    getUser: async () => null,
  };
  renderProfile(root, ctx);
  return { root, seen, abort: () => ctrl.abort() };
}

test('a visitor sees the heart in the profile actions, without a liked by list', async () => {
  const { root, seen, abort } = mountProfile({ count: 7, liked: true, own: false, signedIn: true });
  await flush();
  const btn = root.querySelector('.profile-actions .like-btn');
  assert.ok(btn);
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(root.querySelector('.profile-likedby'), null);
  assert.equal(seen.filter((p) => p.startsWith(LIKED_BY_API)).length, 0);
  abort();
});

test('your own profile shows the count and the liked by list', async () => {
  const { root, abort } = mountProfile({ count: 1, liked: false, own: true, signedIn: true }, { people: [{ name: 'Sam', username: 'sam', at: Date.now() }], count: 1, more: false, next: null });
  await flush();
  await flush();
  const btn = root.querySelector('.profile-actions .like-btn');
  assert.ok(btn.classList.contains('is-own'));
  assert.equal(btn.getAttribute('aria-pressed'), null);
  const list = root.querySelector('.profile-sections .profile-likedby');
  assert.ok(list);
  assert.match(list.textContent, /Liked by/);
  assert.match(list.textContent, /Sam/);
  abort();
});

test('the Party card shows a like pill only when there are likes', () => {
  const base = { name: 'Bea', username: 'bea', party: { games: 1, wins: 0 }, page: true };
  const some = cardModel(cleanCard({ ...base, likes: 12 }));
  const pill = some.facts.find((f) => f.key === 'likes');
  assert.equal(pill.text, '12 likes');
  assert.equal(cardModel(cleanCard({ ...base, likes: 1 })).facts.find((f) => f.key === 'likes').text, '1 like');
  assert.equal(cardModel(cleanCard({ ...base, likes: 0 })).facts.find((f) => f.key === 'likes'), undefined);
  assert.equal(cardModel(cleanCard({ ...base, likes: null })).facts.find((f) => f.key === 'likes'), undefined);
  assert.equal(cleanCard({ ...base, likes: 'lots' }).likes, null);
});

test('likes.css is linked, plain ASCII and honours reduced motion', () => {
  const css = readFileSync(path.join(here, '..', 'web', 'css', 'likes.css'), 'utf8');
  assert.ok(/^[\x00-\x7f]*$/.test(css));
  assert.match(css, /prefers-reduced-motion: reduce/);
  const html = readFileSync(path.join(here, '..', 'web', 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/css\/likes\.css">/);
  const js = readFileSync(path.join(here, '..', 'web', 'js', 'profile-like.js'), 'utf8');
  assert.equal(/innerHTML|\.style\.[a-z]+\s*=/.test(js), false);
});

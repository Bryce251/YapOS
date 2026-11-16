import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, FakeEvent } from './dom-shim.js';
import { room } from './activity-kit.test.js';
import { questionById } from '../web/activity/data/trivia.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function all(node, out = []) {
  for (const c of node.childNodes || []) {
    if (c.localName) out.push(c);
    all(c, out);
  }
  return out;
}

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

function mount(engine) {
  const { window } = globalThis;
  const root = document.createElement('div');
  document.body.append(root);
  const win = Object.assign(window, {
    document,
    parent: window,
    innerWidth: 400,
    innerHeight: 700,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
  });
  return import('../web/activity/js/ui/app.js').then(({ mountApp }) => ({ root, app: mountApp({ root, engine, bridge: { close() {} }, win }) }));
}

test('the activity page works under the strict activity CSP', () => {
  const html = readFileSync(path.join(activity, 'index.html'), 'utf8');
  assert.equal(/style\s*=/.test(html), false);
  assert.equal(/<style/i.test(html), false);
  assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  assert.equal(/https?:\/\//.test(html), false);
  const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /type="module" src="\/activity\/js\/main\.js"/);
  assert.equal(scripts[0].replace(/<script[^>]*>/, '').replace('</script>', '').trim(), '');
  assert.match(html, /href="\/activity\/css\/activity\.css"/);
  for (const f of walk(activity)) {
    const src = readFileSync(f, 'utf8');
    if (f.endsWith('.css')) {
      assert.equal(/url\(|@import|@font-face/.test(src), false, f);
      assert.match(src, /prefers-reduced-motion/);
    }
    if (f.endsWith('.js')) {
      assert.equal(/\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(src), false, `${f} sets inline styles`);
      const fetches = [path.join('ui', 'app.js'), path.join('js', 'dictionary.js'), path.join('js', 'profiles.js'), path.join('js', 'admin.js'), path.join('ui', 'leaderboard.js'), path.join('ui', 'profilecard.js'), path.join('js', 'account.js')].some((x) => f.endsWith(x));
      const remembers = { [path.join('ui', 'sfx.js')]: 'SOUND_KEY', [path.join('ui', 'lobby.js')]: 'TAB_KEY', [path.join('views', 'palette.js')]: 'RECENT_KEY', [path.join('ui', 'fullscreen.js')]: 'FOCUS_KEY', [path.join('js', 'account.js')]: 'AUTH_KEY', [path.join('ui', 'fxmode.js')]: 'FX_STORE_KEY', [path.join('views', 'beatdrop.js')]: 'OFFSET_KEY' };
      const memoryKey = Object.entries(remembers).find(([x]) => f.endsWith(x));
      assert.equal(/sessionStorage|XMLHttpRequest|WebSocket/.test(src), false, f);
      if (memoryKey) assert.deepEqual([...src.matchAll(/setItem\(([^,]+),/g)].map((m) => m[1]), [memoryKey[1]], f);
      else assert.equal(/localStorage/.test(src), false, f);
      assert.equal(/fetch\(\s*['"`](?:https?:)?\/\//.test(src), false, `${f} fetches another site`);
      if (!fetches) assert.equal(/fetch\(/.test(src), false, f);
      assert.equal(/postMessage\([^)]*['"]\*['"]/.test(src), false, `${f} posts to any origin`);
    }
  }
});

test('the lobby, a Would You Rather round and the results render and respond to taps', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { join: false });
  await r.clock.advance(500);
  const [hostEngine, guestEngine] = r.engines;
  const host = await mount(hostEngine);
  const guest = await mount(guestEngine);
  await r.clock.advance(300);
  assert.match(text(guest.root), /Waiting for Player 1 to start/);
  assert.match(text(host.root), /You're the host/);
  assert.match(text(guest.root), /Player 2/);
  assert.equal(byKey(guest.root, 'start'), null);
  assert.equal(byKey(guest.root, 'pick-wyr'), null, 'the guest starts on the tab of the picked game');
  byKey(guest.root, 'tab-party').click();
  await r.clock.advance(100);
  assert.equal(byKey(guest.root, 'pick-wyr').disabled, true);
  assert.match(text(guest.root), /You're watching/);
  assert.match(text(host.root), /0 playing/);
  byKey(guest.root, 'join').click();
  await r.clock.advance(400);
  assert.match(text(host.root), /1 playing/);
  assert.ok(byKey(guest.root, 'leave-game'));
  byKey(host.root, 'join').click();
  await r.clock.advance(400);
  assert.match(text(guest.root), /2 playing/);
  byKey(host.root, 'tab-party').click();
  await r.clock.advance(100);
  byKey(host.root, 'pick-wyr').click();
  await r.clock.advance(300);
  byKey(host.root, 'set-rounds-5').click();
  await r.clock.advance(300);
  assert.equal(hostEngine.snapshot().settings.rounds, 5);
  byKey(host.root, 'start').click();
  await r.clock.advance(400);
  assert.match(text(guest.root), /Would you rather/);
  assert.match(text(guest.root), /Prompt 1 of 5/);
  byKey(guest.root, 'side-a').click();
  byKey(host.root, 'side-b').click();
  await r.clock.advance(500);
  assert.match(text(guest.root), /50%/);
  assert.match(text(guest.root), /perfect split/);
  assert.equal(byKey(guest.root, 'side-a').disabled, true);
  hostEngine.lobby.end();
  await r.clock.advance(400);
  assert.match(text(guest.root), /tie!/);
  assert.match(text(guest.root), /Waiting for Player 1 to pick/);
  assert.ok(byKey(host.root, 'again'));
  byKey(host.root, 'lobby').click();
  await r.clock.advance(400);
  assert.match(text(guest.root), /Scoreboard/);
  assert.match(text(guest.root), /50/);
  assert.equal(byKey(guest.root, 'reset'), null);
  const reset = byKey(host.root, 'reset');
  assert.match(text(reset), /New game \(reset scores\)/);
  reset.click();
  await r.clock.advance(300);
  assert.match(text(byKey(host.root, 'reset')), /Tap again to reset/);
  assert.ok(Object.values(hostEngine.snapshot().scores.t).some((v) => v > 0), 'one tap does not reset');
  byKey(host.root, 'reset').click();
  await r.clock.advance(400);
  assert.deepEqual(hostEngine.snapshot().scores.t, {});
  assert.equal(byKey(host.root, 'reset'), null);
  host.app.destroy();
  guest.app.destroy();
});

test('a trivia question renders, locks in a pick and shows the reveal', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2);
  await r.clock.advance(500);
  const [hostEngine, guestEngine] = r.engines;
  const guest = await mount(guestEngine);
  hostEngine.lobby.pick('trivia');
  hostEngine.lobby.start();
  await r.clock.advance(400);
  const st = guestEngine.snapshot().state.trivia;
  assert.match(text(guest.root), /Question 1 of 10/);
  const right = st.q.options.indexOf(questionById(st.q.id).a);
  byKey(guest.root, `opt-${right}`).click();
  await r.clock.advance(300);
  assert.match(text(guest.root), /Locked in!/);
  assert.equal(byKey(guest.root, `opt-${(right + 1) % 4}`).disabled, true);
  hostEngine.act({ type: 'answer', i: (right + 1) % 4 });
  await r.clock.advance(400);
  assert.match(text(guest.root), /Nice one!/);
  assert.match(text(guest.root), /Got it:/);
  const cls = byKey(guest.root, `opt-${right}`).className;
  assert.match(cls, /is-right/);
  assert.match(cls, /is-mine/);
  guest.app.destroy();
});

function fakeStore(start = {}) {
  const data = new Map(Object.entries(start));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

async function lobbyOf(engine, store) {
  const { createLobby } = await import('../web/activity/js/ui/lobby.js');
  const sfx = { played: [], play(name) { this.played.push(name); } };
  const lobby = createLobby({ engine, toast() {}, sfx, store });
  document.body.append(lobby.el);
  lobby.update(engine.snapshot());
  return { lobby, sfx, el: lobby.el };
}

function selectedTab(el) {
  return all(el).find((n) => n.getAttribute && n.getAttribute('role') === 'tab' && n.getAttribute('aria-selected') === 'true');
}

function pickKeys(el) {
  return all(el).filter((n) => n.dataset && /^pick-/.test(n.dataset.key || '')).map((n) => n.dataset.key);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('every game sits in one of the picker categories', async () => {
  const { GAMES, CATEGORIES } = await import('../web/activity/js/games/index.js');
  const ids = CATEGORIES.map((c) => c.id);
  assert.deepEqual(ids, ['drawing', 'words', 'quiz', 'party', 'quick']);
  assert.ok(GAMES.length >= 21);
  for (const id of ['typerace', 'memory']) assert.equal(GAMES.find((g) => g.id === id).category, 'quick', id);
  for (const g of GAMES) assert.ok(ids.includes(g.category), `${g.id} has category ${g.category}`);
  assert.deepEqual(GAMES.slice(0, 4).map((g) => g.id), ['trivia', 'draw', 'chain', 'wyr']);
  const { VIEWS } = await import('../web/activity/js/views/index.js');
  for (const g of GAMES) assert.equal(typeof VIEWS[g.id], 'function', g.id);
  const html = readFileSync(path.join(activity, 'index.html'), 'utf8');
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  for (const id of ['odd', 'telephone', 'scramble', 'hive', 'emoji', 'hottakes', 'truths', 'reflex', 'bluff', 'pixel', 'higherlower', 'sketchduel', 'story', 'hangman', 'musicquiz']) {
    const at = sheets.indexOf(`/activity/css/${id}.css`);
    assert.ok(at > sheets.indexOf('/activity/css/games.css'), id);
  }
  const fs = sheets.indexOf('/activity/css/fullscreen.css');
  assert.ok(fs > sheets.indexOf('/activity/css/musicquiz.css'));
  assert.ok(fs < sheets.indexOf('/activity/css/admin.css'));
  assert.equal(sheets[sheets.length - 1], '/activity/css/juice.css');
});

test('pickerTabs counts each category and keeps existing games first', async () => {
  const { GAMES } = await import('../web/activity/js/games/index.js');
  const { pickerTabs, gamesInTab, lobbyModel } = await import('../web/activity/js/ui/lobby.js');
  const list = GAMES.map((g) => ({ id: g.id, category: g.category }));
  const tabs = pickerTabs(list);
  assert.deepEqual(tabs.map((t) => t.id), ['all', 'drawing', 'words', 'quiz', 'party', 'quick']);
  assert.equal(tabs[0].count, GAMES.length);
  assert.equal(tabs.slice(1).reduce((n, t) => n + t.count, 0), GAMES.length);
  assert.deepEqual(gamesInTab(list, 'drawing').map((g) => g.id), ['draw', 'odd', 'telephone', 'pixel', 'sketchduel']);
  assert.deepEqual(gamesInTab(list, 'words').map((g) => g.id), ['chain', 'scramble', 'hive', 'hangman', 'namefive']);
  assert.deepEqual(gamesInTab(list, 'quiz').map((g) => g.id), ['trivia', 'emoji', 'bluff', 'musicquiz', 'closest']);
  assert.deepEqual(gamesInTab(list, 'party').map((g) => g.id), ['wyr', 'hottakes', 'truths', 'story']);
  const quick = gamesInTab(list, 'quick').map((g) => g.id);
  assert.deepEqual(quick.slice(0, 2), ['reflex', 'higherlower']);
  for (const id of ['typerace', 'memory']) assert.ok(quick.includes(id), id);
  assert.deepEqual(pickerTabs([{ id: 'x', category: null }]).map((t) => t.id), ['all']);
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(1, { join: false });
  await r.clock.advance(500);
  const m = lobbyModel(r.engines[0].snapshot(), GAMES);
  assert.equal(m.games.find((g) => g.id === 'reflex').category, 'quick');
});

test('the picker shows category tabs with counts, arrow keys move between them and the choice is remembered', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(1, { join: false });
  await r.clock.advance(500);
  const store = fakeStore();
  const { lobby, sfx, el } = await lobbyOf(r.engines[0], store);
  const list = all(el).find((n) => n.getAttribute && n.getAttribute('role') === 'tablist');
  assert.ok(list);
  const tabs = all(list).filter((n) => n.getAttribute && n.getAttribute('role') === 'tab');
  assert.deepEqual(tabs.map((t) => t.dataset.key), ['tab-all', 'tab-drawing', 'tab-words', 'tab-quiz', 'tab-party', 'tab-quick']);
  const { GAMES: ALL_GAMES } = await import('../web/activity/js/games/index.js');
  assert.match(text(byKey(el, 'tab-all')), new RegExp(`All\\s+${ALL_GAMES.length}`));
  assert.match(text(byKey(el, 'tab-drawing')), /Drawing\s+5/);
  assert.match(text(byKey(el, 'tab-quick')), new RegExp(`Quick\\s+${ALL_GAMES.filter((g) => g.category === 'quick').length}`));
  assert.equal(selectedTab(el).dataset.key, 'tab-quiz');
  assert.equal(byKey(el, 'tab-quiz').getAttribute('tabindex'), '0');
  assert.equal(byKey(el, 'tab-words').getAttribute('tabindex'), '-1');
  assert.deepEqual(pickKeys(el), ['pick-trivia', 'pick-emoji', 'pick-bluff', 'pick-musicquiz', 'pick-closest']);
  assert.equal(byKey(el, 'pick-trivia').getAttribute('aria-checked'), 'true');
  const key = (k) => {
    selectedTab(el).dispatchEvent(new FakeEvent('keydown', { bubbles: true, key: k }));
  };
  key('ArrowRight');
  assert.equal(selectedTab(el).dataset.key, 'tab-party');
  assert.deepEqual(pickKeys(el), ['pick-wyr', 'pick-hottakes', 'pick-truths', 'pick-story']);
  assert.equal(store.data.get('yapos.party.tab'), 'party');
  key('ArrowRight');
  key('ArrowRight');
  assert.equal(selectedTab(el).dataset.key, 'tab-all', 'arrows wrap around');
  key('ArrowLeft');
  assert.equal(selectedTab(el).dataset.key, 'tab-quick');
  key('Home');
  assert.equal(selectedTab(el).dataset.key, 'tab-all');
  assert.equal(pickKeys(el).length, ALL_GAMES.length);
  key('End');
  assert.equal(selectedTab(el).dataset.key, 'tab-quick');
  byKey(el, 'tab-words').click();
  assert.equal(store.data.get('yapos.party.tab'), 'words');
  assert.ok(sfx.played.includes('toggle'));
  assert.equal(sfx.played.includes('pop'), false, 'browsing tabs does not pop the pick');
  lobby.destroy();
  const again = await lobbyOf(r.engines[0], fakeStore({ 'yapos.party.tab': 'all' }));
  assert.equal(selectedTab(again.el).dataset.key, 'tab-all', 'a remembered tab that shows the pick is kept');
  const gone = await lobbyOf(r.engines[0], fakeStore({ 'yapos.party.tab': 'nope' }));
  assert.equal(selectedTab(gone.el).dataset.key, 'tab-quiz', 'an unknown tab falls back to the picked game');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const safe = await lobbyOf(r.engines[0], broken);
  assert.equal(selectedTab(safe.el).dataset.key, 'tab-quiz');
  byKey(safe.el, 'tab-party').click();
  assert.equal(selectedTab(safe.el).dataset.key, 'tab-party', 'blocked storage still lets you switch tabs');
});

test('guests can browse tabs, follow the host to a new pick and always see what is picked', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { join: false });
  await r.clock.advance(500);
  const [hostEngine, guestEngine] = r.engines;
  const guest = await lobbyOf(guestEngine, fakeStore());
  const update = () => guest.lobby.update(guestEngine.snapshot());
  const pill = () => all(guest.el).find((n) => n.classList && n.classList.contains('picked-pill'));
  assert.equal(selectedTab(guest.el).dataset.key, 'tab-quiz');
  assert.equal(byKey(guest.el, 'pick-trivia').disabled, true);
  assert.equal(byKey(guest.el, 'tab-words').disabled, false);
  byKey(guest.el, 'tab-words').click();
  assert.equal(byKey(guest.el, 'pick-hive').disabled, true);
  assert.match(text(pill()), /Trivia/);
  assert.ok(pill().classList.contains('is-away'));
  hostEngine.lobby.pick('odd');
  await r.clock.advance(300);
  update();
  assert.equal(selectedTab(guest.el).dataset.key, 'tab-drawing', 'the guest is moved to the new pick');
  assert.equal(byKey(guest.el, 'pick-odd').getAttribute('aria-checked'), 'true');
  assert.ok(byKey(guest.el, 'pick-odd').classList.contains('juice-pick'));
  assert.ok(guest.sfx.played.includes('pop'));
  assert.equal(pill().classList.contains('is-away'), false);
  assert.match(text(pill()), /Odd One Out/);
  byKey(guest.el, 'tab-all').click();
  hostEngine.lobby.pick('draw');
  await r.clock.advance(300);
  update();
  assert.equal(selectedTab(guest.el).dataset.key, 'tab-all', 'All already shows the pick so it stays');
  assert.equal(byKey(guest.el, 'pick-draw').getAttribute('aria-checked'), 'true');
});

test('the lobby settings panel works for every game', async () => {
  const { GAMES } = await import('../web/activity/js/games/index.js');
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(1, { join: false });
  await r.clock.advance(500);
  const host = r.engines[0];
  const { lobby, el } = await lobbyOf(host, fakeStore({ 'yapos.party.tab': 'all' }));
  for (const g of GAMES) {
    byKey(el, `pick-${g.id}`).click();
    await r.clock.advance(200);
    lobby.update(host.snapshot());
    assert.equal(host.snapshot().pick.id, g.id);
    const pill = all(el).find((n) => n.classList && n.classList.contains('picked-pill'));
    assert.match(text(pill), new RegExp(escapeRe(g.name)));
    assert.equal(byKey(el, `pick-${g.id}`).getAttribute('aria-checked'), 'true');
    for (const spec of g.settings || []) {
      assert.ok(all(el).some((n) => n.dataset && (n.dataset.key || '').startsWith(`set-${spec.id}`)), `${g.id} shows ${spec.id}`);
      if (spec.type === 'multi' || spec.type === 'toggle') continue;
      const other = spec.options.find((o) => JSON.stringify(o.value) !== JSON.stringify(host.snapshot().settings[spec.id]));
      if (!other) continue;
      byKey(el, `set-${spec.id}-${other.value}`).click();
      await r.clock.advance(200);
      lobby.update(host.snapshot());
      assert.deepEqual(host.snapshot().settings[spec.id], other.value, `${g.id}.${spec.id}`);
    }
  }
});

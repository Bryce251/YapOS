import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom-shim.js';
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
      const bare = f.endsWith(path.join('ui', 'app.js')) ? src.replace("win.fetch('/api/me', ", '') : src;
      assert.equal(/localStorage|sessionStorage|fetch\(|XMLHttpRequest|WebSocket/.test(bare), false, f);
      assert.equal(/postMessage\([^)]*['"]\*['"]/.test(src), false, `${f} posts to any origin`);
    }
  }
});

test('the lobby, a Would You Rather round and the results render and respond to taps', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2);
  await r.clock.advance(500);
  const [hostEngine, guestEngine] = r.engines;
  const host = await mount(hostEngine);
  const guest = await mount(guestEngine);
  await r.clock.advance(300);
  assert.match(text(guest.root), /Waiting for Player 1 to start/);
  assert.match(text(host.root), /You're the host/);
  assert.match(text(guest.root), /Player 2/);
  assert.equal(byKey(guest.root, 'start'), null);
  assert.equal(byKey(guest.root, 'pick-wyr').disabled, true);
  byKey(guest.root, 'ready').click();
  await r.clock.advance(400);
  assert.match(text(host.root), /1\/2 ready/);
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

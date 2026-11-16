import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import higherlower, { KEY, higherSide } from '../web/activity/js/games/higherlower.js';
import { createHigherlowerView } from '../web/activity/js/views/higherlower.js';
import { koBar } from '../web/activity/js/views/knockout.js';

const ROOT = new URL('../web/activity/', import.meta.url);

function all(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes || []) {
      if (c.localName) {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

function insideButton(node) {
  for (let n = node.parentNode; n; n = n.parentNode) if (n.localName === 'button') return true;
  return false;
}

test('players who answered show up as clickable profile faces, but not inside answer cards', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { games: [higherlower] });
  await r.clock.advance(500);
  const views = r.engines.map((engine) => {
    const v = createHigherlowerView({ engine, fx: { confetti() {} }, cues: { play() {}, burst() {}, float() {} } });
    engine.on('change', (snap) => v.update(snap));
    return v;
  });
  r.engines[0].lobby.pick('higherlower');
  r.engines[0].lobby.setting('knockout', false);
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  const s = r.hub.state[KEY];
  const right = higherSide(s.a.id, s.b.id);
  views[0].el.querySelector(`.hl-card-${right}`).click();
  await r.clock.advance(300);
  const other = views[1].el.querySelector('.game-foot .faces [data-profile-id][role="button"]');
  assert.ok(other, 'the other player sees a clickable face');
  assert.equal(other.getAttribute('tabindex'), '0');
  assert.match(other.getAttribute('aria-label'), /^View .+'s profile$|^View your profile$/);
  assert.ok(other.classList.contains('avatar-btn'));
  assert.equal(insideButton(other), false);
  views[1].el.querySelector(`.hl-card-${right === 'a' ? 'b' : 'a'}`).click();
  await r.clock.advance(400);
  assert.equal(r.hub.state[KEY].phase, 'reveal');
  for (const v of views) {
    for (const node of all(v.el)) {
      if (node.getAttribute('role') === 'button') assert.equal(insideButton(node), false, 'no button inside a button');
    }
    v.destroy();
  }
});

test('the knockout bar shows standing players as profile buttons', () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const bar = koBar({ alive: [{ id: 'u-1', name: 'Pip', initials: 'P', hue: 20 }, { id: 'u-2', name: 'Kai', initials: 'K', hue: 200, isMe: true }], out: [], duel: false });
  const faces = bar.querySelectorAll('.ko-face [data-profile-id][role="button"]');
  assert.equal(faces.length, 2);
  assert.equal(faces[0].getAttribute('data-profile-id'), 'u-1');
  assert.equal(faces[0].getAttribute('aria-label'), "View Pip's profile");
  assert.equal(faces[1].getAttribute('aria-label'), 'View your profile');
});

test('game views use the shared profile face instead of a bare avatar', () => {
  for (const name of ['trivia', 'emoji', 'musicquiz', 'higherlower', 'reflex', 'knockout']) {
    const src = readFileSync(new URL(`js/views/${name}.js`, ROOT), 'utf8');
    assert.match(src, /profileButton\(/, name);
  }
});

test('restyled game sheets stay on tokens and respect reduced motion', () => {
  for (const name of ['emoji', 'musicquiz', 'higherlower', 'reflex']) {
    const css = readFileSync(new URL(`css/${name}.css`, ROOT), 'utf8');
    assert.match(css, /prefers-reduced-motion/, name);
    assert.doesNotMatch(css, /\/\*|url\(|@import/, name);
    if (name !== 'emoji') assert.match(css, /:focus-visible/, name);
  }
});

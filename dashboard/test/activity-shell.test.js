import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, FakeEvent } from './dom-shim.js';
import { room } from './activity-kit.test.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');

function walk(el, out = []) {
  for (const c of el.childNodes || []) {
    if (c.localName) {
      out.push(c);
      walk(c, out);
    }
  }
  return out;
}

const has = (n, cls) => Boolean(n.classList && n.classList.contains(cls));

test('profile buttons are focusable, labelled and carry the player id', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { profileButton, profileLabel } = await import('../web/activity/js/ui/dom.js');
  const pip = { id: 'u-1', name: 'Pip', initials: 'P', hue: 40, avatar: null, isMe: false };
  const btn = profileButton(pip, 'md', { host: true });
  assert.equal(btn.getAttribute('role'), 'button');
  assert.equal(btn.getAttribute('tabindex'), '0');
  assert.equal(btn.getAttribute('aria-label'), "View Pip's profile");
  assert.equal(btn.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(btn.getAttribute('data-profile-id'), 'u-1');
  assert.ok(has(btn, 'avatar-btn') && has(btn, 'avatar-btn-md') && has(btn, 'is-host'));
  const kids = walk(btn);
  assert.ok(kids.some((n) => has(n, 'avatar') && n.getAttribute('aria-hidden') === 'true'));
  assert.ok(kids.some((n) => has(n, 'avatar-crown') && n.getAttribute('aria-hidden') === 'true'));
  assert.equal(profileLabel({ id: 'me', name: 'Jolli', isMe: true }), 'View your profile');
  let clicks = 0;
  btn.addEventListener('click', () => {
    clicks += 1;
  });
  const enter = new FakeEvent('keydown', { key: 'Enter' });
  btn.dispatchEvent(enter);
  assert.equal(clicks, 1);
  assert.equal(enter.defaultPrevented, true);
  btn.dispatchEvent(new FakeEvent('keydown', { key: ' ' }));
  assert.equal(clicks, 2);
  btn.dispatchEvent(new FakeEvent('keydown', { key: 'a' }));
  assert.equal(clicks, 2);
  const anon = profileButton({ name: 'Ghost', initials: 'G' }, 'sm');
  assert.equal(anon.getAttribute('role'), null);
  assert.equal(anon.getAttribute('tabindex'), null);
  assert.ok(has(anon, 'is-static'));
});

test('the lobby shows a hero for the picked game and profile buttons for every player', async () => {
  const { window } = installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { join: true });
  await r.clock.advance(500);
  const root = document.createElement('div');
  root.classList.add('app');
  document.body.append(root);
  const win = Object.assign(window, { document, parent: window, innerWidth: 400, innerHeight: 700, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id), setInterval: () => 0, clearInterval: () => {} });
  const { mountApp } = await import('../web/activity/js/ui/app.js');
  const app = mountApp({ root, engine: r.engines[0], bridge: { close() {} }, win, juice: false });
  await r.clock.advance(300);
  const nodes = walk(root);
  const hero = nodes.find((n) => has(n, 'lobby-hero'));
  assert.ok(hero, 'the lobby has a hero card');
  assert.ok(walk(hero).some((n) => has(n, 'lobby-hero-title') && n.textContent.length > 0));
  const players = nodes.filter((n) => has(n, 'player'));
  assert.ok(players.length >= 1);
  for (const p of players) {
    const btn = walk(p).find((n) => has(n, 'avatar-btn'));
    assert.ok(btn, 'each player row has an avatar button');
    assert.match(btn.getAttribute('aria-label'), /^View (your|.+'s) profile$/);
    assert.ok(btn.getAttribute('data-profile-id'));
  }
  const brand = nodes.find((n) => has(n, 'brand-name'));
  assert.equal(brand.textContent, 'YapOS Party');
  const mark = nodes.find((n) => has(n, 'brand-mark'));
  const logo = walk(mark).find((n) => n.localName === 'img');
  assert.ok(logo, 'the brand mark is the YapOS logo, same as the dashboard');
  assert.equal(logo.getAttribute('src'), '/logo.png');
  assert.equal(logo.alt ?? logo.getAttribute('alt'), '');
  const pill = nodes.find((n) => has(n, 'status-pill'));
  assert.ok(has(pill, 'is-live'));
  assert.ok(nodes.some((n) => has(n, 'btn-glow')), 'the main call to action glows');
  app.toast('Saved!', 'success');
  const toast = walk(root).find((n) => has(n, 'toast'));
  assert.ok(has(toast, 'toast-success'));
  app.destroy();
});

test('scoreboard faces open profiles and the top three use medal discs', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { board, standings } = await import('../web/activity/js/ui/board.js');
  const mk = (slot, name, game) => ({ id: `id${slot}`, slot, name, initials: name[0], hue: slot * 30, avatar: null, present: true, joined: true, isMe: slot === 1, game });
  const rows = standings([mk(0, 'Ada', 300), mk(1, 'Bo', 200), mk(2, 'Cy', 100), mk(3, 'Di', 50)], 'game');
  const el = board(rows, { label: 'Shell test board' });
  const nodes = walk(el);
  const medals = nodes.filter((n) => has(n, 'board-medal'));
  assert.deepEqual(medals.map((m) => m.textContent), ['1', '2', '3']);
  assert.ok(has(medals[0], 'medal-1') && has(medals[1], 'medal-2') && has(medals[2], 'medal-3'));
  const buttons = nodes.filter((n) => has(n, 'avatar-btn'));
  assert.equal(buttons.length, 4);
  assert.ok(buttons.every((b) => b.getAttribute('data-profile-id') && b.getAttribute('role') === 'button'));
  assert.ok(has(buttons[0], 'ring-lead'));
  assert.equal(nodes.filter((n) => has(n, 'is-me')).length, 1);
});

test('the shell stylesheet takes its design tokens from tokens.css', () => {
  const css = readFileSync(path.join(activity, 'css', 'activity.css'), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  for (const name of ['--bg', '--surface', '--accent', '--text', '--radius', '--space-4', '--shadow-md', '--dur', '--focus-ring']) {
    assert.equal(new RegExp(`\\n\\s*${name}:`).test(root), false, `${name} is only declared in tokens.css`);
  }
  assert.match(root, /--game-trivia:/);
  assert.match(css, /\.avatar-btn/);
  assert.match(css, /prefers-reduced-motion/);
  assert.equal(/\/\*|url\(/.test(css), false);
  const html = readFileSync(path.join(activity, 'index.html'), 'utf8');
  assert.ok(html.indexOf('/activity/css/tokens.css') < html.indexOf('/activity/css/activity.css'));
});

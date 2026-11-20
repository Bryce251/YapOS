import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, flush, fire, FakeEvent } from './dom-shim.js';
import { createHarness, USERS } from './helpers.js';
import {
  cleanLook, readLook, readGradientCustom, gradientCss, gradientStops, rawGradientCss, nameContrast, contrast, defaultLook, isDefaultLook,
  LookError, LIGHT_SURFACE, DARK_SURFACE, GRADIENT_MIN_CONTRAST, CUSTOM_GRADIENT_START, GRADIENT_ANGLES,
} from '../web/js/profile-look.js';
import { resetPlan, cardLook, publicLook } from '../worker/profile-custom.js';
import { buildCard, clearPartyProfileCache } from '../worker/party-profile.js';

const { document } = installDom({ url: 'https://dash.example.test/u/bea' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { profileCard, nameGradientClass } = await import('../web/js/pages/profile.js');
const { openProfileEditor } = await import('../web/js/pages/profile-editor.js');
const { normalizeProfile } = await import('../web/js/community-data.js');
const { readStaffProfile, canReset, nameStyleText, lookRows } = await import('../web/js/pages/party-person.js');
const cl = await import('../web/activity/js/ui/cardlook.js');
const pcard = await import('../web/activity/js/ui/profilecard.js');

const ALICE = USERS.alice;
const BOB = USERS.bob;
const LOOK = '/api/me/profile-look';
const GOOD = Object.freeze({ a: '#ff0080', b: '#00c2ff', angle: 135 });
const GOOD3 = Object.freeze({ a: '#ff0080', b: '#00c2ff', c: '#ffd000', angle: 90 });
const strict = (raw) => () => cleanLook(raw, { strict: true });
const isBad = (e) => e instanceof LookError && e.code === 'bad_gradient';

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

function noStyleAttrs(root) {
  for (const n of walk(root)) if (n.getAttribute) assert.equal(n.getAttribute('style'), null, n.className);
}

test('a custom gradient with two or three hex colours and a whole angle is accepted as is', () => {
  assert.deepEqual(cleanLook({ nameGradientCustom: GOOD }, { strict: true }).nameGradientCustom, { ...GOOD });
  assert.deepEqual(cleanLook({ nameGradientCustom: GOOD3 }, { strict: true }).nameGradientCustom, { ...GOOD3 });
  assert.deepEqual(readGradientCustom({ a: '#000000', b: '#ffffff', c: null, angle: 0 }), { a: '#000000', b: '#ffffff', angle: 0 });
  assert.deepEqual(readGradientCustom({ a: '#000000', b: '#ffffff', angle: 360 }), { a: '#000000', b: '#ffffff', angle: 360 });
  assert.deepEqual(readGradientCustom(JSON.parse('{"angle":45,"b":"#123456","a":"#abcdef"}')), { a: '#abcdef', b: '#123456', angle: 45 }, 'keys come out in one order');
  assert.equal(cleanLook({}).nameGradientCustom, null);
  assert.equal(defaultLook().nameGradientCustom, null);
  assert.equal(isDefaultLook(cleanLook({ nameGradientCustom: GOOD })), false);
  assert.equal(CUSTOM_GRADIENT_START.angle, 90);
  assert.deepEqual(GRADIENT_ANGLES.map((a) => a.angle), [90, 135, 180, 45]);
});

test('bad custom gradients are refused: bad hex, url(), angles out of range and extra keys', () => {
  const bads = [
    { a: '#abc', b: '#000000', angle: 90 },
    { a: 'red', b: '#000000', angle: 90 },
    { a: '#AABBCC', b: '#000000', angle: 90 },
    { a: 'url(https://evil.example/x.png)', b: '#000000', angle: 90 },
    { a: '#000000', b: '#000000;background:url(x)', angle: 90 },
    { a: '#000000', b: '#ffffff', c: 'url(x)', angle: 90 },
    { a: '#000000', b: '#ffffff', c: '', angle: 90 },
    { a: '#000000', b: '#ffffff', angle: 361 },
    { a: '#000000', b: '#ffffff', angle: -1 },
    { a: '#000000', b: '#ffffff', angle: 12.5 },
    { a: '#000000', b: '#ffffff', angle: '90' },
    { a: '#000000', b: '#ffffff', angle: '90deg), url(x' },
    { a: '#000000', b: '#ffffff', angle: Number.NaN },
    { a: '#000000', b: '#ffffff', angle: Infinity },
    { a: '#000000', b: '#ffffff' },
    { a: '#000000', angle: 90 },
    { a: '#000000', b: '#ffffff', angle: 90, d: '#111111' },
    { a: '#000000', b: '#ffffff', angle: 90, type: 'radial' },
    JSON.parse('{"a":"#000000","b":"#ffffff","angle":90,"__proto__":{"x":1}}'),
    ['#000000', '#ffffff', 90],
    '#000000',
    7,
    true,
  ];
  for (const bad of bads) {
    assert.throws(strict({ nameGradientCustom: bad }), isBad, JSON.stringify(bad));
    assert.equal(cleanLook({ nameGradientCustom: bad }).nameGradientCustom, null, JSON.stringify(bad));
    assert.equal(gradientCss(bad, 'dark'), null);
    assert.equal(rawGradientCss(bad), null);
  }
});

test('a custom gradient wins over a preset gradient and a name colour', () => {
  const look = cleanLook({ nameColour: '#112233', nameGradient: 'aurora', nameGradientCustom: GOOD }, { strict: true });
  assert.deepEqual([look.nameColour, look.nameGradient, look.nameGradientCustom], [null, null, { ...GOOD }]);
  const preset = cleanLook({ nameColour: '#112233', nameGradient: 'aurora', nameGradientCustom: null }, { strict: true });
  assert.deepEqual([preset.nameColour, preset.nameGradient, preset.nameGradientCustom], [null, 'aurora', null]);
});

test('the gradient text is built only from checked hex and the angle, and stays readable', () => {
  assert.equal(rawGradientCss(GOOD3), 'linear-gradient(90deg, #ff0080, #ffd000, #00c2ff)');
  const dark = gradientCss({ a: '#000000', b: '#101010', angle: 180 }, 'dark');
  assert.match(dark, /^linear-gradient\(180deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
  for (const c of gradientStops({ a: '#000000', b: '#101010', angle: 180 }, 'dark')) assert.ok(contrast(c, DARK_SURFACE) >= GRADIENT_MIN_CONTRAST);
  for (const c of gradientStops({ a: '#ffffff', b: '#fff8e0', angle: 180 }, 'light')) assert.ok(contrast(c, LIGHT_SURFACE) >= GRADIENT_MIN_CONTRAST);
  assert.deepEqual(gradientStops(GOOD3, 'light').length, 3);
});

test('a low contrast name colour against the profile theme gets a hint, not a block', () => {
  assert.deepEqual(nameContrast(cleanLook({ nameColour: '#ffffff' })), [], 'without a theme the colour is tweaked so it stays readable');
  assert.deepEqual(nameContrast(cleanLook({ nameGradientCustom: { a: '#ffffff', b: '#000000', angle: 0 } })), [], 'gradient stops are tweaked for plain light and dark pages');
  const red = { theme: 'custom', themeCustom: { base: '#ff0000', alt: '#ff0000', accent: '#ff0000' }, themeMode: 'light' };
  const teal = cleanLook({ ...red, nameGradientCustom: { a: '#00bb99', b: '#00bb99', angle: 90 } }, { strict: true });
  const hint = nameContrast(teal);
  assert.equal(hint.length, 1);
  assert.equal(hint[0].mode, 'light');
  assert.ok(hint[0].ratio < 3);
  assert.deepEqual(nameContrast({ ...teal, themeMode: 'dark' }), [], 'only the modes the theme uses are checked');
  assert.deepEqual(nameContrast(null), []);
});

test('the Worker saves a custom gradient, rejects a bad one, and the Party card gets checked stops', async () => {
  const h = createHarness({ PARTY_OWNER_ID: BOB.id });
  for (const user of [ALICE, BOB]) {
    h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, 3, 400, NULL, '[]', '[]', '[]', NULL, 0, ?)")
      .run(user.id, user.username, user.username, user.display_name, h.clock.t);
    h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 12, 4, '{}', '{}', ?)").run(user.id, h.clock.t);
    h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, NULL, 0, ?) ON CONFLICT (id) DO NOTHING').run(user.id, user.username, user.display_name, h.clock.t);
  }
  const alice = (await h.login(ALICE)).cookie;
  const bob = (await h.login(BOB)).cookie;
  for (const bad of [{ a: 'url(x)', b: '#000000', angle: 90 }, { a: '#000000', b: '#ffffff', angle: 400 }, { a: '#000000', b: '#ffffff', angle: 90, x: 1 }]) {
    const res = await h.api('PUT', LOOK, alice, { nameGradientCustom: bad });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_gradient');
  }
  const put = await h.api('PUT', LOOK, alice, { nameColour: '#112233', nameGradientCustom: GOOD3, nameFont: 'serif' });
  assert.equal(put.status, 200, await put.clone().text());
  const saved = (await put.json()).look;
  assert.deepEqual(saved.nameGradientCustom, { ...GOOD3 });
  assert.equal(saved.nameColour, null);
  const own = await (await h.api('GET', LOOK, alice)).json();
  assert.deepEqual(own.look.nameGradientCustom, { ...GOOD3 });
  const pub = await (await h.request('GET', '/api/u/alice', { ip: '203.0.113.31' })).json();
  assert.deepEqual(pub.profile.custom.nameGradientCustom, { ...GOOD3 });
  clearPartyProfileCache(h.db);
  const card = await buildCard(h.db, ALICE.id);
  const g = card.look.nameGradientCustom;
  assert.equal(g.angle, 90);
  assert.deepEqual(g.light, gradientStops(GOOD3, 'light'));
  assert.deepEqual(g.dark, gradientStops(GOOD3, 'dark'));
  assert.equal(card.look.nameGradient, null);
  assert.equal(card.look.nameColour, null);
  const served = (await (await h.request('GET', `/api/activity/profile/${ALICE.id}`, { ip: '203.0.113.32' })).json()).profile.look;
  assert.deepEqual(served.nameGradientCustom, g);
  const staff = await (await h.api('GET', `/api/party/profile/${ALICE.id}`, bob)).json();
  assert.deepEqual(staff.look.nameGradientCustom, { ...GOOD3 });
  const reset = await h.api('DELETE', `/api/party/profile/${ALICE.id}/look/name-style`, bob);
  assert.equal(reset.status, 200, await reset.clone().text());
  const after = await (await h.api('GET', LOOK, alice)).json();
  assert.deepEqual([after.look.nameGradientCustom, after.look.nameGradient, after.look.nameColour, after.look.nameFont], [null, null, null, 'default']);
  assert.equal((await h.api('DELETE', `/api/party/profile/${ALICE.id}/look/name-style`, bob)).status, 404, 'nothing left to reset');
  await h.api('PUT', LOOK, alice, { nameGradientCustom: GOOD });
  const again = await h.api('DELETE', `/api/party/profile/${ALICE.id}/look/name-style`, bob);
  assert.equal(again.status, 200, 'a custom gradient alone counts as a name style');
  const log = h.db.raw.prepare('SELECT action FROM party_mod_log WHERE target_id = ? ORDER BY created, rowid').all(ALICE.id);
  assert.deepEqual(log.map((r) => r.action), ['profile_name_style_reset', 'profile_name_style_reset']);
});

test('the staff reset plan clears the custom gradient and the card data ignores a forged one', () => {
  const stored = { ...defaultLook(), nameGradientCustom: { ...GOOD } };
  const stmts = [];
  const db = { prepare: (sql) => ({ bind: (...args) => { stmts.push({ sql, args }); return { sql, args }; } }) };
  const plan = resetPlan(db, 'u1', 'name-style', { look: stored, banner: null }, 'Al', 1);
  assert.equal(plan.action, 'profile_name_style_reset');
  assert.match(stmts[0].sql, /DELETE FROM profile_custom/, 'only the gradient was set, so the look goes back to default');
  const forged = cardLook({ ...defaultLook(), nameGradientCustom: { a: 'red;}', b: '#000000', angle: 90 } }, null);
  assert.equal(forged.nameGradientCustom, null);
  assert.equal(publicLook({ ...defaultLook(), nameGradientCustom: { a: '#000000', b: '#ffffff', angle: 999 } }, null, null).nameGradientCustom, null);
});

test('the staff view describes the custom gradient and offers the name style reset', () => {
  const staff = readStaffProfile({ look: { nameGradientCustom: GOOD3, nameFont: 'default' }, canAct: true });
  assert.deepEqual(staff.look.nameGradientCustom, { ...GOOD3 });
  assert.equal(canReset(staff.look, 'name-style'), true);
  assert.equal(nameStyleText(staff.look), 'custom gradient #ff0080 to #ffd000 to #00c2ff at 90 degrees');
  assert.deepEqual(lookRows(staff.look).find(([k]) => k === 'Name style'), ['Name style', 'custom gradient #ff0080 to #ffd000 to #00c2ff at 90 degrees']);
  const forged = readStaffProfile({ look: { nameGradientCustom: { a: '<b>', b: '#000000', angle: 90 } } });
  assert.equal(forged.look.nameGradientCustom, null);
  assert.equal(canReset(forged.look, 'name-style'), false);
});

test('the profile header shows the custom gradient through custom properties only', () => {
  const p = normalizeProfile({ profile: { username: 'bea', name: 'Bea', level: 3, xp: 400, badges: [], achievements: [], season: [], party: { games: 4, wins: 1, favourites: [] } } });
  const { look } = readLook({ nameGradientCustom: GOOD, nameColour: '#112233' });
  const card = profileCard(p, { look, bannerImage: null });
  const name = card.querySelector('.profile-name');
  assert.ok(name.classList.contains('name-grad-custom'));
  assert.equal(name.classList.contains('has-name-colour'), false);
  assert.equal(name.style.props['--ngc-light'], gradientCss(GOOD, 'light'));
  assert.equal(name.style.props['--ngc-dark'], gradientCss(GOOD, 'dark'));
  assert.equal(name.style.props['--nc-light'], undefined);
  noStyleAttrs(card);
  assert.equal(nameGradientClass({ nameGradientCustom: { a: 'x', b: '#000000', angle: 1 }, nameGradient: 'ocean' }), 'name-grad-ocean');
  const css = readFileSync(new URL('../web/css/profile.css', import.meta.url), 'utf8');
  assert.match(css, /\.name-grad-custom \{\s*background-image: var\(--ngc-light\);/);
  assert.match(css, /:root\[data-theme="dark"\] \.name-grad-custom \{\s*background-image: var\(--ngc-dark\);/);
  assert.match(css, /\.public-site\.pt-mode-dark \.profile-name\.name-grad-custom \{\s*background-image: var\(--ngc-dark\);/);
  assert.match(css, /\.public-site\.pt-mode-light \.profile-name\.name-grad-custom \{\s*background-image: var\(--ngc-light\);/);
});

function editor(lookRaw = {}) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const seen = [];
  const p = normalizeProfile({ profile: { username: 'bea', name: 'Bea', level: 3, xp: 400, badges: [], achievements: [], season: [], party: { games: 4, wins: 1, favourites: [] } } });
  const ed = openProfileEditor({
    mount,
    profile: p,
    look: readLook(lookRaw).look,
    api: { post: async (path, body) => ({ look: body }), request: async () => ({}) },
    renderCard: (draft) => profileCard(p, { look: draft, bannerImage: null }),
    onLook: (l) => seen.push(l),
  });
  return { mount, ed, seen };
}

test('the editor has no native colour inputs left, only the in-page picker', () => {
  const { mount, ed } = editor();
  for (const tab of ['name', 'card', 'theme']) {
    ed.showTab(tab);
    assert.equal(mount.querySelectorAll('input').filter((i) => i.type === 'color').length, 0, tab);
    assert.ok(mount.querySelectorAll('.cp-trigger').length >= 1, tab);
  }
  ed.showTab('theme');
  mount.querySelector('.pe-theme[data-choice="custom"]').click();
  assert.equal(mount.querySelector('.pe-theme-custom').querySelectorAll('.cp-trigger').length, 3, 'main, second and highlight colours each get a picker');
  const src = readFileSync(new URL('../web/js/pages/profile-editor.js', import.meta.url), 'utf8');
  assert.equal(/type: 'color'/.test(src), false);
  mount.remove();
});

test('picking name, accent and theme colours with the picker updates the draft as hex', () => {
  const { mount, ed } = editor();
  ed.showTab('name');
  const trig = mount.querySelector('.cp-trigger');
  trig.click();
  const pop = mount.querySelector('.cp-pop');
  assert.equal(pop.hidden, false);
  const hue = pop.querySelector('.cp-hue');
  const e = new FakeEvent('keydown', { key: 'Home', bubbles: true });
  hue.dispatchEvent(e);
  assert.match(ed.draft.nameColour, /^#[0-9a-f]{6}$/);
  assert.equal(ed.draft.nameGradientCustom, null);
  assert.equal(mount.querySelector('.pe-hex').value, ed.draft.nameColour);
  const hexIn = pop.querySelector('.cp-hex');
  hexIn.value = 'navy';
  hexIn.dispatchEvent(new FakeEvent('input'));
  assert.equal(ed.draft.nameColour, '#000080');
  hexIn.dispatchEvent(new FakeEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(pop.hidden, true);
  assert.equal(document.activeElement, trig);
  ed.showTab('card');
  const accentTrig = mount.querySelector('.cp-trigger');
  accentTrig.click();
  mount.querySelector('.cp-pop').querySelector('.cp-palette').querySelectorAll('.cp-pick')[3].click();
  assert.equal(ed.draft.accent, '#2f8fe8');
  ed.showTab('theme');
  mount.querySelector('.pe-theme[data-choice="custom"]').click();
  const box = mount.querySelector('.pe-theme-custom');
  box.querySelector('.cp-trigger').click();
  const themeHex = box.querySelector('.cp-pop').querySelector('.cp-hex');
  themeHex.value = '#abc';
  themeHex.dispatchEvent(new FakeEvent('input'));
  assert.equal(ed.draft.themeCustom.base, '#aabbcc');
  const rowHex = box.querySelector('.pe-hex');
  rowHex.value = 'gold';
  fire(rowHex, 'change');
  assert.equal(ed.draft.themeCustom.base, '#ffd700', 'the hex box next to the swatch takes colour names too');
  noStyleAttrs(mount);
  mount.remove();
});

test('the custom gradient builder sets two or three colours and a direction and saves only valid data', async () => {
  const { mount, ed } = editor({ nameColour: '#e0a100' });
  ed.showTab('name');
  const swatch = walk(mount).find((n) => n.getAttribute?.('data-choice') === 'g:custom');
  assert.ok(swatch);
  assert.match(swatch.style.props['--sw-grad'], /^linear-gradient\(90deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
  const box = mount.querySelector('.pe-grad-custom');
  assert.equal(box.hidden, true, 'the builder only shows once custom gradient is picked');
  swatch.click();
  assert.equal(box.hidden, false);
  assert.deepEqual(ed.draft.nameGradientCustom, { ...CUSTOM_GRADIENT_START });
  assert.equal(ed.draft.nameColour, null);
  const preview = () => mount.querySelector('.pe-preview .profile-name');
  assert.ok(preview().classList.contains('name-grad-custom'));
  assert.equal(preview().style.props['--ngc-light'], gradientCss(CUSTOM_GRADIENT_START, 'light'));
  const demos = mount.querySelectorAll('.pe-demo-name');
  assert.ok(demos.every((d) => d.classList.contains('name-grad-custom')));
  assert.equal(demos[1].style.props['--ngc-dark'], gradientCss(CUSTOM_GRADIENT_START, 'dark'));
  const stopHex = (k) => box.querySelector(`.pe-grad-stop[data-stop="${k}"]`).querySelector('.pe-hex');
  stopHex('a').value = 'hotpink';
  fire(stopHex('a'), 'change');
  assert.equal(ed.draft.nameGradientCustom.a, '#ff69b4');
  stopHex('b').value = 'url(x)';
  fire(stopHex('b'), 'change');
  assert.equal(ed.draft.nameGradientCustom.b, CUSTOM_GRADIENT_START.b, 'bad colours are not taken');
  assert.match(box.textContent, /Use a color like/);
  const middle = box.querySelector('.pe-grad-mid');
  assert.equal(box.querySelector('.pe-grad-stop[data-stop="c"]').hidden, true);
  middle.checked = true;
  fire(middle, 'change');
  assert.match(ed.draft.nameGradientCustom.c, /^#[0-9a-f]{6}$/);
  assert.equal(box.querySelector('.pe-grad-stop[data-stop="c"]').hidden, false);
  const angle = box.querySelector('.pe-angle');
  assert.equal(angle.type, 'range');
  angle.value = '200';
  fire(angle, 'input');
  assert.equal(ed.draft.nameGradientCustom.angle, 200);
  assert.equal(angle.getAttribute('aria-valuetext'), '200 degrees');
  angle.value = '9999';
  fire(angle, 'input');
  assert.equal(ed.draft.nameGradientCustom.angle, 360);
  const diag = box.querySelectorAll('.pe-angle-chip').find((b) => b.getAttribute('data-angle') === '135');
  diag.click();
  assert.equal(ed.draft.nameGradientCustom.angle, 135);
  assert.equal(diag.getAttribute('aria-pressed'), 'true');
  const remembered = { ...ed.draft.nameGradientCustom };
  walk(mount).find((n) => n.getAttribute?.('data-choice') === 'g:ocean').click();
  assert.deepEqual([ed.draft.nameGradient, ed.draft.nameGradientCustom], ['ocean', null]);
  assert.equal(box.hidden, true);
  swatch.click();
  assert.deepEqual(ed.draft.nameGradientCustom, remembered, 'going back to custom keeps what you made');
  middle.checked = false;
  fire(middle, 'change');
  assert.equal('c' in ed.draft.nameGradientCustom, false);
  assert.doesNotThrow(() => cleanLook(ed.draft, { strict: true }));
  noStyleAttrs(mount);
  mount.remove();
});

test('the editor warns about low contrast against the theme but still lets you keep the colour', () => {
  const { mount, ed } = editor({ theme: 'custom', themeCustom: { base: '#ff0000', alt: '#ff0000', accent: '#ff0000' }, themeMode: 'light' });
  ed.showTab('name');
  const warn = mount.querySelector('.pe-contrast-warn');
  assert.equal(warn.hidden, true);
  walk(mount).find((n) => n.getAttribute?.('data-choice') === 'g:custom').click();
  const stopHex = (k) => mount.querySelector(`.pe-grad-stop[data-stop="${k}"]`).querySelector('.pe-hex');
  for (const k of ['a', 'b']) {
    stopHex(k).value = '#00bb99';
    fire(stopHex(k), 'change');
  }
  assert.equal(warn.hidden, false);
  assert.match(warn.textContent, /hard to read on your profile theme in light mode/);
  assert.equal(warn.getAttribute('role'), 'status');
  assert.deepEqual([ed.draft.nameGradientCustom.a, ed.draft.nameGradientCustom.b], ['#00bb99', '#00bb99'], 'the colours are kept anyway');
  assert.doesNotThrow(() => cleanLook(ed.draft, { strict: true }));
  stopHex('a').value = '#000000';
  fire(stopHex('a'), 'change');
  stopHex('b').value = '#000000';
  fire(stopHex('b'), 'change');
  assert.equal(warn.hidden, true);
  mount.remove();
});

test('the Party card draws the custom gradient from checked stops and drops a forged one', () => {
  const g = { angle: 135, light: gradientStops(GOOD3, 'light'), dark: gradientStops(GOOD3, 'dark') };
  assert.deepEqual(cl.readCustomGradient(g), g);
  assert.equal(cl.customGradientOf(g, false), `linear-gradient(135deg, ${g.dark.join(', ')})`);
  assert.equal(cl.customGradientOf(g, true), `linear-gradient(135deg, ${g.light.join(', ')})`);
  for (const bad of [
    { ...g, angle: 361 },
    { ...g, angle: '90' },
    { ...g, dark: ['red', '#000000'] },
    { ...g, light: ['#000000'] },
    { ...g, light: ['#000000', '#111111', '#222222', '#333333'] },
    { ...g, dark: ['#000000', 'url(x)'] },
    { ...g, light: g.light.slice(0, 2) },
    null,
    [],
  ]) {
    assert.equal(cl.readCustomGradient(bad), null, JSON.stringify(bad));
    assert.equal(cl.customGradientOf(bad), null);
  }
  const look = pcard.cleanLook({ nameGradientCustom: g, nameGradient: 'aurora', nameColour: { light: '#111111', dark: '#eeeeee' } });
  assert.deepEqual(look.customGrad, g);
  assert.equal(look.gradient, null, 'the custom gradient wins on the card too');
  assert.equal(look.colour, g.dark[0]);
  assert.equal(pcard.cleanLook({ nameGradientCustom: { ...g, angle: 'x' } }), null);
});

test('the Party card paints the custom gradient on the name with --pc-grad', async () => {
  const g = { angle: 45, light: gradientStops(GOOD, 'light'), dark: gradientStops(GOOD, 'dark') };
  const ID = '11111111-1111-4111-8111-111111111111';
  const { document: doc } = installDom({ url: 'https://yapos.dev/activity/' });
  const body = { hidden: false, name: 'Jolli', username: 'jolli', avatar: null, level: 2, progress: { into: 1, need: 10 }, shards: null, badges: [], badgeCount: 0, achievements: [], clan: null, party: { games: 1, wins: 0, bestStreak: 0, favourites: [] }, rank: null, page: true, look: { nameGradientCustom: g, nameFont: 'serif' } };
  const win = { document: doc, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), matchMedia: () => ({ matches: false }), fetch: async () => new Response(JSON.stringify({ profile: body }), { status: 200 }) };
  const { avatar, h } = await import('../web/activity/js/ui/dom.js');
  const players = [{ id: ID, name: 'Jolli', initials: 'J', hue: 30, avatar: null, isMe: true, isHost: true, present: true, joined: true }];
  const engine = { snapshot: () => ({ ready: true, me: ID, players, room: { phase: 'lobby' } }) };
  const root = h('div', { class: 'app' });
  doc.body.append(root);
  const face = avatar(players[0], 'md');
  root.append(face);
  const pc = pcard.createProfileCard({ win, engine });
  pc.bind(root);
  face.click();
  await flush();
  const name = pc.el.querySelector('.pcard-name');
  assert.ok(name.classList.contains('has-grad'));
  assert.equal(name.style.props['--pc-grad'], `linear-gradient(45deg, ${g.dark.join(', ')})`);
  assert.equal(name.style.props['--pc-name'], g.dark[0]);
  for (const n of walk(pc.el)) if (n.getAttribute) assert.equal(n.getAttribute('style'), null);
  const css = readFileSync(new URL('../web/activity/css/profilecard-look.css', import.meta.url), 'utf8');
  assert.match(css, /\.pcard-name\.has-grad \{\s*background-image: var\(--pc-grad\);/);
  pc.close();
  installDom({ url: 'https://dash.example.test/u/bea' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, FakeEvent } from './dom-shim.js';
import { NAME_FONTS, FONT_FILES, FONT_CATEGORIES, cleanLook, LookError, fontById } from '../web/js/profile-look.js';
import { FONTS } from '../web/activity/js/ui/profilecard.js';
import { SYSTEM_FONTS, FONT_SHEET, needsFontSheet, ensureFontSheet } from '../web/activity/js/ui/cardlook.js';
import { parseHeadersFile, headersFor } from '../dev.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..', 'web');
const fontsDir = path.join(web, 'fonts');
const siteCss = readFileSync(path.join(web, 'css', 'name-fonts.css'), 'utf8');
const actCss = readFileSync(path.join(web, 'activity', 'css', 'profilecard-fonts.css'), 'utf8');
const MAX_FONT_BYTES = 120 * 1024;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function faceOf(css, id) {
  const re = new RegExp(`@font-face \\{[^}]*font-family: "nf-${id}";[^}]*\\}`);
  const m = re.exec(css);
  return m ? m[0] : null;
}

test('there are lots of fonts, grouped, with unique ids, and the old ids still work', () => {
  const ids = NAME_FONTS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 45, `${ids.length} fonts`);
  for (const old of ['default', 'rounded', 'serif', 'mono', 'caps']) assert.ok(ids.includes(old), old);
  const cats = new Set(FONT_CATEGORIES.map((c) => c.id));
  for (const f of NAME_FONTS) {
    assert.ok(cats.has(f.category), `${f.id} has a known group`);
    assert.match(f.id, /^[a-z0-9]+$/);
    assert.ok(f.label);
  }
  for (const c of FONT_CATEGORIES) assert.ok(NAME_FONTS.filter((f) => f.category === c.id).length >= 2, `${c.id} has fonts`);
  assert.deepEqual(NAME_FONTS.filter((f) => f.system).map((f) => f.id).sort(), ['caps', 'default', 'mono', 'rounded', 'serif']);
  assert.deepEqual([...FONT_FILES].sort(), NAME_FONTS.filter((f) => !f.system).map((f) => f.id).sort());
  assert.equal(fontById('nope').id, 'default');
});

test('every font id is accepted and unknown ones are refused', () => {
  for (const f of NAME_FONTS) assert.equal(cleanLook({ nameFont: f.id }, { strict: true }).nameFont, f.id);
  for (const bad of ['Comic Sans', 'POPPINS', 'poppins ', 'nf-poppins', '../fonts/x', '', 5]) {
    assert.throws(() => cleanLook({ nameFont: bad }, { strict: true }), (e) => e instanceof LookError && e.code === 'bad_font', String(bad));
  }
  assert.equal(cleanLook({ nameFont: 'Comic Sans' }).nameFont, 'default');
});

test('every font has a small latin woff2 file and a licence, and no file is left over', () => {
  const files = readdirSync(fontsDir).filter((f) => f.endsWith('.woff2'));
  assert.deepEqual(files.map((f) => f.replace('.woff2', '')).sort(), [...FONT_FILES].sort());
  for (const id of FONT_FILES) {
    const file = path.join(fontsDir, `${id}.woff2`);
    assert.ok(existsSync(file), `${id}.woff2`);
    const size = statSync(file).size;
    assert.ok(size > 1000 && size <= MAX_FONT_BYTES, `${id}.woff2 is ${size} bytes`);
    assert.equal(readFileSync(file).subarray(0, 4).toString('latin1'), 'wOF2', `${id} is woff2`);
    const lic = path.join(fontsDir, 'LICENSES', `${id}.txt`);
    assert.ok(existsSync(lic), `licence for ${id}`);
    const text = readFileSync(lic, 'utf8');
    assert.match(text, new RegExp(`^.+\\(${id}\\.woff2,`));
    assert.match(text, /SIL Open Font License|Apache License/);
  }
  assert.deepEqual(readdirSync(path.join(fontsDir, 'LICENSES')).sort(), FONT_FILES.map((id) => `${id}.txt`).sort());
});

test('the site sheet has a swap, latin-only face and a class for every font', () => {
  for (const id of FONT_FILES) {
    for (const [name, css] of [['site', siteCss], ['activity', actCss]]) {
      const face = faceOf(css, id);
      assert.ok(face, `${name} @font-face for ${id}`);
      assert.match(face, new RegExp(`src: url\\("/fonts/${id}\\.woff2"\\) format\\("woff2"\\);`));
      assert.match(face, /font-display: swap;/);
      assert.match(face, /unicode-range: U\+0000-00FF,/);
    }
    const cls = new RegExp(`\\.name-font-${id} \\{[^}]*font-family: "nf-${id}", [^;]+;[^}]*--nf-size: |\\.name-font-${id} \\{[^}]*--nf-size: [0-9.]+;[^}]*font-family: "nf-${id}", `);
    assert.match(siteCss, cls, `site class for ${id}`);
    assert.match(actCss, new RegExp(`\\.pcard-name\\.font-${esc(id)} \\{[^}]*font-family: "nf-${id}", [^;]+;[^}]*font-size: [0-9.]+px;`), `activity class for ${id}`);
  }
  for (const css of [siteCss, actCss]) {
    assert.equal(/[^\x00-\x7f]/.test(css), false, 'plain ASCII');
    assert.equal(/\/\*|@import|https?:/.test(css), false);
    assert.equal(css.replace(/url\("\/fonts\/[a-z0-9]+\.woff2"\) format\("woff2"\)/g, '').includes('url('), false);
    const sizes = [...css.matchAll(/--nf-size: ([0-9.]+);/g)].map((m) => Number(m[1]));
    for (const s of sizes) assert.ok(s >= 0.55 && s <= 1.3, `size ${s}`);
  }
  const profileCss = readFileSync(path.join(web, 'css', 'profile.css'), 'utf8');
  for (const id of ['rounded', 'serif', 'mono', 'caps']) assert.match(profileCss, new RegExp(`\\.name-font-${id} \\{`));
  assert.match(siteCss, /\.profile-name\[class\*="name-font-"\] \{\s*font-size: calc\(26px \* var\(--nf-size, 1\)\);/);
  assert.match(siteCss, /\.pe-demo-name\[class\*="name-font-"\]/);
  const html = readFileSync(path.join(web, 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/css\/name-fonts\.css">/);
});

test('fonts are cached for a long time', () => {
  const rules = parseHeadersFile(readFileSync(path.join(web, '_headers'), 'utf8'));
  const hd = headersFor(rules, '/fonts/poppins.woff2', { secure: true });
  assert.match(hd.get('Cache-Control') || '', /max-age=31536000/);
  assert.equal(headersFor(rules, '/index.html', { secure: true }).get('Cache-Control'), null);
});

test('the activity knows every font and only loads the font sheet for a downloaded one', () => {
  assert.deepEqual([...FONTS].sort(), NAME_FONTS.filter((f) => f.id !== 'default').map((f) => f.id).sort());
  assert.deepEqual([...SYSTEM_FONTS].sort(), NAME_FONTS.filter((f) => f.system && f.id !== 'default').map((f) => f.id).sort());
  for (const id of FONT_FILES) assert.equal(needsFontSheet(id), true, id);
  for (const id of [...SYSTEM_FONTS, null, '', undefined]) assert.equal(needsFontSheet(id), false, String(id));
  assert.equal(FONT_SHEET, '/activity/css/profilecard-fonts.css');
  const { document } = installDom({ url: 'https://yapos.dev/activity/' });
  assert.equal(ensureFontSheet(document, 'serif'), false);
  assert.equal(document.querySelectorAll('link[data-pcard-fonts]').length, 0);
  assert.equal(ensureFontSheet(document, 'pacifico'), true);
  assert.equal(ensureFontSheet(document, 'bebas'), true);
  const links = document.querySelectorAll('link[data-pcard-fonts]');
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), FONT_SHEET);
  const activityHtml = readFileSync(path.join(web, 'activity', 'index.html'), 'utf8');
  assert.equal(activityHtml.includes('profilecard-fonts.css'), false);
});

test('the editor font picker groups fonts, previews the name and is keyboard friendly', async () => {
  installDom({ url: 'https://yapos.dev/me/profile' });
  const { fontPicker } = await import('../web/js/pages/profile-editor.js');
  const picks = [];
  const fp = fontPicker({ value: 'pacifico', sample: 'Jolli', onPick: (id) => picks.push(id) });
  document.body.append(fp.el);
  const chips = [...fp.el.querySelectorAll('.pe-font-cat')];
  assert.deepEqual(chips.map((c) => c.getAttribute('data-font-cat')), FONT_CATEGORIES.map((c) => c.id));
  assert.equal(fp.category, 'script');
  const radios = [...fp.el.querySelectorAll('[role="radio"]')];
  assert.equal(radios.length, NAME_FONTS.length);
  const shown = () => radios.filter((r) => !r.hidden);
  assert.deepEqual(shown().map((r) => r.getAttribute('data-choice')), NAME_FONTS.filter((f) => f.category === 'script').map((f) => f.id));
  const on = radios.find((r) => r.getAttribute('aria-checked') === 'true');
  assert.equal(on.getAttribute('data-choice'), 'pacifico');
  assert.equal(on.tabIndex, 0);
  assert.equal(radios.filter((r) => r.tabIndex === 0).length, 1);
  const sample = on.querySelector('.pe-font-sample');
  assert.equal(sample.textContent, 'Jolli');
  assert.ok(sample.classList.contains('name-font-pacifico'));
  assert.ok(chips.find((c) => c.getAttribute('data-font-cat') === 'script').classList.contains('has-pick'));
  chips.find((c) => c.getAttribute('data-font-cat') === 'retro').dispatchEvent(new FakeEvent('click', { bubbles: true }));
  assert.equal(fp.category, 'retro');
  assert.deepEqual(shown().map((r) => r.getAttribute('data-choice')), NAME_FONTS.filter((f) => f.category === 'retro').map((f) => f.id));
  assert.equal(shown()[0].tabIndex, 0, 'the first font in the group takes focus when the pick is elsewhere');
  shown()[0].dispatchEvent(new FakeEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(picks.at(-1), NAME_FONTS.filter((f) => f.category === 'retro')[1].id);
  shown()[0].dispatchEvent(new FakeEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(picks.at(-1), NAME_FONTS.filter((f) => f.category === 'retro').at(-1).id, 'arrows wrap inside the group');
  shown()[0].dispatchEvent(new FakeEvent('click', { bubbles: true }));
  assert.equal(fp.value, 'pressstart');
  assert.match(fp.el.querySelector('.pe-font-current').textContent, /Press Start/);
  fp.setSample('');
  assert.equal(radios.find((r) => r.getAttribute('data-choice') === 'bebas').querySelector('.pe-font-sample').textContent, 'Bebas Neue');
  fp.set('nope');
  assert.equal(fp.value, 'default');
});

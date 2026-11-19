import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/u/bea' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const cp = await import('../web/js/colour-picker.js');
const { readLook, sameLook, cleanLook } = await import('../web/js/profile-look.js');
const { profileCard } = await import('../web/js/pages/profile.js');
const { normalizeProfile } = await import('../web/js/community-data.js');
const { openProfileEditor } = await import('../web/js/pages/profile-editor.js');

const docPointer = () => (document.listeners.get('pointerdown') || []).length;

function editor(signal = null) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const p = normalizeProfile({ profile: { username: 'bea', name: 'Bea', level: 3, xp: 400, badges: [], achievements: [], season: [], party: { games: 4, wins: 1, favourites: [] } } });
  const done = [];
  const ed = openProfileEditor({
    mount,
    profile: p,
    look: readLook({}).look,
    api: { post: async (path, body) => ({ look: body }), request: async () => ({}) },
    signal,
    renderCard: (draft) => profileCard(p, { look: draft, bannerImage: null }),
    onDone: (r) => done.push(r),
  });
  return { mount, ed, done };
}

test('an open picker drops its document listener when the editor is left by navigation', () => {
  const before = docPointer();
  const ctl = new AbortController();
  const { mount, ed } = editor(ctl.signal);
  ed.showTab('name');
  mount.querySelector('.cp-trigger').click();
  assert.equal(docPointer(), before + 1);
  ctl.abort();
  assert.equal(docPointer(), before);
  mount.querySelector('.cp-trigger').click();
  assert.equal(docPointer(), before, 'a destroyed picker cannot reopen');
  mount.remove();
});

test('an open picker closes when the editor finishes or the tab changes', async () => {
  const before = docPointer();
  const { mount, ed, done } = editor();
  ed.showTab('name');
  mount.querySelector('.cp-trigger').click();
  assert.equal(docPointer(), before + 1);
  ed.showTab('card');
  assert.equal(docPointer(), before, 'switching tabs closes the picker');
  mount.querySelector('.cp-trigger').click();
  assert.equal(docPointer(), before + 1);
  await ed.cancel();
  assert.equal(done.length, 1);
  assert.equal(docPointer(), before);
  mount.remove();
});

test('a destroyed picker ignores late eyedropper results and drag frames', async () => {
  let resolve;
  class EyeDropper {
    open() {
      return new Promise((r) => {
        resolve = r;
      });
    }
  }
  const seen = [];
  const picker = cp.createColourPicker({ value: '#7c5cff', label: 'Name colour', storage: null, onInput: (x) => seen.push(x), win: { EyeDropper } });
  document.body.appendChild(cp.colourRow(picker));
  picker.open();
  picker.panel.querySelector('.cp-drop').click();
  picker.destroy();
  resolve({ sRGBHex: '#123456' });
  await flush();
  assert.deepEqual(seen, []);
  assert.equal(picker.value, '#7c5cff');
  assert.equal(picker.destroyed, true);
  picker.button.remove?.();
});

test('the same custom gradient in a different key order is not a change', () => {
  const a = cleanLook({ nameGradientCustom: { a: '#ff0080', b: '#00c2ff', c: '#ffd000', angle: 90 } });
  const b = { ...a, nameGradientCustom: { angle: 90, a: '#ff0080', b: '#00c2ff', c: '#ffd000' } };
  assert.equal(sameLook(a, b), true);
  assert.equal(sameLook(a, { ...a, nameGradientCustom: { a: '#ff0080', b: '#00c2ff', angle: 90 } }), false);
  assert.equal(sameLook(a, { ...a, nameGradientCustom: { ...a.nameGradientCustom, angle: 91 } }), false);
});

test('old saved profiles without the new field still read cleanly and stay exclusive', () => {
  const old = readLook({ nameColour: '#ff0000', nameGradient: 'ocean' }).look;
  assert.equal(old.nameGradientCustom, null);
  assert.equal(old.nameColour, null);
  assert.equal(old.nameGradient, 'ocean');
  const forged = cleanLook({ nameColour: '#ff0000', nameGradient: 'ocean', nameGradientCustom: { a: '#ff0000', b: '#0000ff', angle: 45 } });
  assert.equal(forged.nameColour, null);
  assert.equal(forged.nameGradient, null);
  assert.deepEqual(forged.nameGradientCustom, { a: '#ff0000', b: '#0000ff', angle: 45 });
  const evil = cleanLook({ nameGradientCustom: { a: '#ff0000;}body{x', b: '#0000ff', angle: 45 } });
  assert.equal(evil.nameGradientCustom, null);
  assert.throws(() => cleanLook({ nameGradientCustom: { a: '#ff0000', b: '#0000ff', angle: '45deg' } }, { strict: true }), (e) => e.code === 'bad_gradient');
});

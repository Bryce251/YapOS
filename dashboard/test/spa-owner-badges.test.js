import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, type, fire, FakeEvent } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/owner' });
document.documentElement = document.createElement('html');
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const maker = await import('../web/js/pages/owner-badges.js');
const { badgeInfo, normalizeProfile } = await import('../web/js/community-data.js');
const { modLogSentence, actionLabel } = await import('../web/js/pages/party-modlog.js');
const { cleanCard } = await import('../web/activity/js/ui/profilecard.js');

const IMG = '/badge-img/c-brain123-0123456789abcdef.webp';
const PNG_URL = 'data:image/png;base64,iVBORw0KGgo=';

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

const buttons = (root) => walk(root).filter((n) => n.localName === 'button');
const byLabel = (root, text) => buttons(root).find((b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text);

function mount({ list = [], encode } = {}) {
  const calls = [];
  const state = { list: list.slice() };
  const ctrl = new AbortController();
  const api = {
    get: async (path) => {
      calls.push(['GET', path]);
      return { badges: state.list, max: 100 };
    },
    post: async (path, body) => {
      calls.push(['POST', path, body]);
      const badge = { id: 'c-new00001', name: body.name, note: body.note, emoji: body.emoji || '\u{1F3C5}', image: IMG, holders: 0 };
      state.list.push(badge);
      return { badge };
    },
    patch: async (path, body) => {
      calls.push(['PATCH', path, body]);
      return { badge: { ...state.list[0], ...body, image: IMG } };
    },
    request: async (method, path) => {
      calls.push([method, path]);
      state.list = state.list.filter((b) => !path.endsWith(b.id));
      return { ok: true };
    },
  };
  const root = document.createElement('main');
  document.body.replaceChildren(root);
  root.appendChild(maker.badgeMakerCard({ api, signal: ctrl.signal }, { encode }));
  return { root, calls, stop: () => ctrl.abort() };
}

test('file checks: SVG and markup are refused, real pictures are known by their bytes', () => {
  assert.equal(maker.sniffFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), 'png');
  assert.equal(maker.sniffFile(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(maker.sniffFile(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8L')), 'webp');
  assert.equal(maker.sniffFile(new TextEncoder().encode('GIF89a')), 'gif');
  assert.equal(maker.sniffFile(new TextEncoder().encode('<svg xmlns="x">')), 'svg');
  assert.equal(maker.sniffFile(new TextEncoder().encode('  <?xml version="1.0"?><svg>')), 'svg');
  assert.equal(maker.sniffFile(new TextEncoder().encode('<html>')), 'markup');
  assert.equal(maker.sniffFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/svg+xml'), 'svg');
  assert.equal(maker.sniffFile(new Uint8Array([1, 2, 3])), null);
  assert.deepEqual(maker.coverRect(300, 200), { sx: 50, sy: 0, sw: 200, sh: 200 });
  assert.deepEqual(maker.coverRect(100, 160), { sx: 0, sy: 30, sw: 100, sh: 100 });
  assert.equal(maker.dataUrlBytes('data:image/png;base64,AAAA'), 3);
  assert.equal(maker.checkForm({ name: '', image: 'x' }), 'Give the badge a name.');
  assert.match(maker.checkForm({ name: 'A', image: '' }), /picture/);
  assert.equal(maker.checkForm({ name: 'A', image: '', editing: true }), null);
  assert.match(maker.deleteText({ name: 'Brain', holders: 3 }).body, /3 people have it\. Deleting it takes it off all of their profiles/);
  assert.match(maker.deleteText({ name: 'Brain', holders: 0 }).body, /Nobody has this badge yet/);
});

test('encodeBadge crops to a 128 square WebP and falls back to PNG when WebP is missing', () => {
  const draws = [];
  const fakeDoc = (webp) => ({
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ clearRect() {}, drawImage: (...a) => draws.push(a) }),
        toDataURL: (type) => (type === 'image/webp' && webp ? 'data:image/webp;base64,AAAA' : 'data:image/png;base64,AAAAAAAA'),
      };
      return canvas;
    },
  });
  const out = maker.encodeBadge({ width: 400, height: 200 }, { doc: fakeDoc(true) });
  assert.equal(out.type, 'WebP');
  assert.equal(out.size, 128);
  assert.deepEqual(draws[0].slice(1), [100, 0, 200, 200, 0, 0, 128, 128]);
  const png = maker.encodeBadge({ width: 64, height: 64 }, { doc: fakeDoc(false) });
  assert.equal(png.type, 'PNG');
  assert.match(png.dataUrl, /^data:image\/png/);
  assert.throws(() => maker.encodeBadge({ width: 64, height: 64 }, { doc: fakeDoc(false), max: 2 }), /too detailed/);
});

test('the badge maker renders, previews a picked file and posts the right body', async () => {
  const picked = [];
  const { root, calls, stop } = mount({ encode: async (f) => { picked.push(f); return { dataUrl: PNG_URL, type: 'PNG', size: 128, bytes: 1234 }; } });
  await flush();
  assert.match(root.textContent, /Badge maker/);
  assert.match(root.textContent, /0 of 100/);
  assert.match(root.textContent, /No badges of your own yet/);
  assert.deepEqual(calls[0], ['GET', maker.OWNER_BADGES_PATH]);
  const file = walk(root).find((n) => n.localName === 'input' && n.type === 'file');
  assert.equal(file.getAttribute('accept'), maker.ACCEPT);
  assert.equal(maker.ACCEPT.includes('svg'), false);

  byLabel(root, 'Make badge').click();
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'POST').length, 0, 'nothing is sent without a name and picture');

  const inputs = walk(root).filter((n) => n.localName === 'input' && n.type === 'text');
  type(inputs[0], 'Galaxy brain');
  type(inputs[1], 'Can only be given by Jolli');
  type(inputs[2], '\u{1F30C}');
  file.files = [{ name: 'brain.png', type: 'image/png', size: 5000 }];
  fire(file, 'change');
  await flush();
  assert.equal(picked[0].name, 'brain.png');
  assert.match(root.textContent, /Ready: PNG, 128 × 128, 1\.2 KB/);
  const previews = walk(root).filter((n) => n.localName === 'img' && n.src === PNG_URL);
  assert.ok(previews.length >= 3, 'the preview shows the picture at each size');
  assert.ok(previews.every((img) => img.alt === 'Galaxy brain'));
  assert.ok(previews.some((img) => img.className.includes('bm-art-44')) && previews.some((img) => img.className.includes('bm-art-18')));
  assert.match(root.textContent, /In bot messages: \u{1F30C} Galaxy brain/u);

  byLabel(root, 'Make badge').click();
  await flush();
  const post = calls.find((c) => c[0] === 'POST');
  assert.deepEqual(post, ['POST', maker.OWNER_BADGES_PATH, { name: 'Galaxy brain', note: 'Can only be given by Jolli', emoji: '\u{1F30C}', image: PNG_URL }]);
  await flush();
  assert.match(root.textContent, /1 of 100/);
  const row = walk(root).find((n) => n.dataset?.id === 'c-new00001');
  assert.ok(row);
  const art = walk(row).find((n) => n.localName === 'img');
  assert.equal(art.src, IMG);
  assert.equal(art.alt, 'Galaxy brain');
  assert.equal(art.title, 'Can only be given by Jolli');
  stop();
});

test('drag and drop works, a bad file shows a plain reason, and edits send only a new picture when picked', async () => {
  const list = [{ id: 'c-brain123', name: 'Brain', note: '', emoji: '\u{1F9E0}', image: IMG, holders: 2 }];
  const { root, calls, stop } = mount({ list, encode: async (f) => { if (f.name.endsWith('.svg')) throw new Error(maker.NO_SVG); return { dataUrl: PNG_URL, type: 'WebP', size: 128, bytes: 900 }; } });
  await flush();
  assert.match(root.textContent, /2 people have it/);
  const drop = walk(root).find((n) => n.className === 'bm-drop');
  const over = new FakeEvent('dragover', { bubbles: true });
  drop.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  assert.ok(drop.classList.contains('is-drag'));
  const bad = new FakeEvent('drop', { bubbles: true });
  bad.dataTransfer = { files: [{ name: 'evil.svg', type: 'image/svg+xml', size: 10 }] };
  drop.dispatchEvent(bad);
  await flush();
  assert.match(root.textContent, /SVG files can't be used/);

  byLabel(root, 'Edit Brain').click();
  await flush();
  assert.match(root.textContent, /Edit “Brain”/);
  const inputs = walk(root).filter((n) => n.localName === 'input' && n.type === 'text');
  assert.equal(inputs[0].value, 'Brain');
  type(inputs[0], 'Big brain');
  byLabel(root, 'Save changes').click();
  await flush();
  const patch = calls.find((c) => c[0] === 'PATCH');
  assert.deepEqual(patch, ['PATCH', `${maker.OWNER_BADGES_PATH}/c-brain123`, { name: 'Big brain', note: '', emoji: '\u{1F9E0}' }]);
  assert.match(root.textContent, /New badge/);

  byLabel(root, 'Delete Brain').click();
  await flush();
  const dialog = document.body.querySelector('.dialog-panel');
  assert.ok(dialog);
  assert.match(dialog.textContent, /Delete “Brain”\?/);
  assert.match(dialog.textContent, /2 people have it/);
  byLabel(dialog, 'Delete badge').click();
  await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'DELETE'), ['DELETE', `${maker.OWNER_BADGES_PATH}/c-brain123`]);
  stop();
});

test('badge pictures reach profiles, Party cards and the mod log', () => {
  const p = normalizeProfile({ profile: { username: 'pip', badges: ['c-brain123', 'einstein'] }, catalog: { badges: [{ id: 'c-brain123', label: 'Brain', emoji: '\u{1F9E0}', image: IMG, note: 'Only from Jolli' }, { id: 'evil', label: 'Evil', emoji: 'x', image: 'https://evil.example/x.png' }] } });
  assert.deepEqual(p.badges[0], { id: 'c-brain123', label: 'Brain', emoji: '\u{1F9E0}', image: IMG, note: 'Only from Jolli' });
  assert.equal(p.badges[1].note, 'Can only be given by Jolli');
  assert.equal(badgeInfo({ id: 'evil', label: 'Evil', image: 'javascript:alert(1)' }).image, undefined);
  const card = cleanCard({ name: 'Pip', badges: [{ id: 'c-brain123', label: 'Brain', emoji: '\u{1F9E0}', image: IMG, note: 'Only from Jolli' }, { id: 'x', label: 'X', image: '//evil.example/a.png' }] });
  assert.equal(card.badges[0].image, IMG);
  assert.equal(card.badges[0].note, 'Only from Jolli');
  assert.equal(card.badges[1].image, undefined);
  const who = { actor: { name: 'Jolli' }, target: null };
  assert.equal(modLogSentence({ ...who, action: 'owner_badge_create', detail: { name: 'Brain' } }), 'Jolli made a new badge, “Brain”');
  assert.equal(modLogSentence({ ...who, action: 'owner_badge_edit', detail: { name: 'Big brain', before: 'Brain', changed: ['name'] } }), 'Jolli renamed the badge “Brain” to “Big brain”');
  assert.equal(modLogSentence({ ...who, action: 'owner_badge_edit', detail: { name: 'Brain', before: 'Brain', changed: ['picture'] } }), 'Jolli changed the picture of the badge “Brain”');
  assert.equal(modLogSentence({ ...who, action: 'owner_badge_delete', detail: { name: 'Brain', holders: 3 } }), 'Jolli deleted the badge “Brain” and took it off 3 people');
  assert.equal(actionLabel('owner_badge_delete'), 'Owner: badges deleted');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, type, flush } from './dom-shim.js';

const SID = '44444444-4444-4444-8444-444444444444';
const { document } = installDom({ url: `https://dash.example.test/servers/${SID}/apps/automod` });
const { state, setDetail } = await import('../web/js/state.js');
const { renderAppSettings, sectionOf } = await import('../web/js/pages/app-settings.js');
const { normalizeField, toEditValue, fromEditValue, validateField, mapItems, sameValue, splitEmoji } = await import('../web/js/forms.js');
const { fillPlaceholders, placeholdersIn } = await import('../web/js/settings-editors.js');

const lookups = {
  channels: [{ id: 'c-1', name: 'general', kind: 'text' }, { id: 'c-2', name: 'memes', kind: 'text' }],
  roles: [{ id: 'r-1', name: 'Member', position: 1, manageable: true }, { id: 'r-2', name: 'Trusted', position: 2, manageable: true }],
};

const automodSchema = [
  { key: 'strictness', label: 'Strictness', type: 'select', web: true, options: [{ value: 'relaxed', label: 'Relaxed' }, { value: 'normal', label: 'Normal' }, { value: 'strict', label: 'Strict' }] },
  { key: 'filters', label: 'Filters on/off', type: 'complex', web: true, editor: 'toggles', labels: { spam: '🌊 Spam & flood', links: '🔗 Links', raid: '🛡️ Raid shield' } },
  { key: 'actions', label: 'What each filter does', type: 'complex', web: true, editor: 'choices', labels: { spam: '🌊 Spam & flood', links: '🔗 Links' }, options: [{ value: 'delete', label: '🗑️ Delete' }, { value: 'timeout', label: '⏳ Delete + 10m timeout' }] },
  { key: 'filterExempt', label: 'Per-filter skipped channels', type: 'complex', web: true, editor: 'channelMap', labels: { spam: '🌊 Spam & flood', links: '🔗 Links' } },
  { key: 'spam.max', label: 'Flood: max messages', type: 'number', web: true, min: 2, max: 50, step: 1 },
  { key: 'verify', label: 'Verification gate', type: 'complex', web: false, note: 'Use /automod verify' },
];

function makeCtx(api) {
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  const ctx = { api, params: { sid: SID, app: 'automod' }, signal: ctrl.signal, main, setChrome() {}, setTitle() {}, setLeaveGuard(g) { ctx.guard = g; }, guard: null, abort: () => ctrl.abort() };
  return ctx;
}

const detail = (settings) => ({ overview: { id: SID, name: 'Test Town' }, apps: [{ id: 'automod', name: 'Automod', enabled: true, canDisable: true }], settings, updatedAt: 1, level: 'admin' });

test('complex settings with a known shape get an editor instead of read-only text', () => {
  const f = normalizeField({ key: 'filters', type: 'complex', web: true });
  assert.equal(f.editor, 'toggles');
  assert.equal(f.readOnly, false);
  assert.equal(mapItems(f, {}).length, 7);
  assert.equal(normalizeField({ key: 'rules', type: 'complex', web: true }).readOnly, true);
  assert.equal(normalizeField({ key: 'verify', type: 'complex', web: false }).readOnly, true);
  assert.equal(normalizeField({ key: 'x', type: 'complex', web: true, editor: 'roleMap', labels: { a: '🎫 Support' } }).editor, 'roleMap');
  assert.deepEqual(splitEmoji('🛡️ Raid shield'), { emoji: '🛡️', name: 'Raid shield' });
  assert.deepEqual(splitEmoji('Plain'), { emoji: '', name: 'Plain' });
});

test('role rewards round-trip and catch bad rows', () => {
  const f = normalizeField({ key: 'rewards', type: 'complex', web: true, max: 2 });
  const edit = toEditValue(f, { 10: 'r-2', 5: 'r-1' });
  assert.deepEqual(edit, [{ level: '5', role: 'r-1' }, { level: '10', role: 'r-2' }]);
  assert.deepEqual(fromEditValue(f, edit), { 5: 'r-1', 10: 'r-2' });
  assert.equal(validateField(f, edit), '');
  assert.match(validateField(f, [{ level: '0', role: 'r-1' }]), /1 to 1000/);
  assert.match(validateField(f, [{ level: '5', role: 'r-1' }, { level: '5', role: 'r-2' }]), /used twice/);
  assert.match(validateField(f, [{ level: '5', role: '' }]), /Pick a role/);
  assert.match(validateField(f, [{ level: '1', role: 'a' }, { level: '2', role: 'b' }, { level: '3', role: 'c' }]), /at most 2/);
});

test('warning steps become the text the bot understands', () => {
  const f = normalizeField({ key: 'escalation', type: 'complex', web: true });
  const edit = toEditValue(f, [{ at: 5, action: 'kick' }, { at: 3, action: 'timeout', durationMs: 3600000 }]);
  assert.deepEqual(edit, [{ at: '3', action: 'timeout', duration: '1h' }, { at: '5', action: 'kick', duration: '' }]);
  assert.equal(fromEditValue(f, edit), '3 timeout 1h, 5 kick');
  assert.equal(fromEditValue(f, []), '');
  assert.match(validateField(f, [{ at: '3', action: 'timeout', duration: '' }]), /how long/);
  assert.match(validateField(f, [{ at: '3', action: 'kick', duration: '' }, { at: '3', action: 'ban', duration: '' }]), /two steps/);
});

test('objects compare by value so toggling back is not a change', () => {
  assert.equal(sameValue({ a: true, b: ['x'] }, { a: true, b: ['x'] }), true);
  assert.equal(sameValue({ a: true }, { a: false }), false);
  assert.equal(sameValue({ a: true }, { a: true, b: false }), false);
});

test('placeholders come from the help text and fill in the preview', () => {
  assert.deepEqual(placeholdersIn('Placeholders: {user} {username} {level} {user}.'), ['user', 'username', 'level']);
  assert.equal(fillPlaceholders('GG {user}, level {level} in {server} {nope}', { serverName: 'Test Town' }), 'GG @Alex, level 5 in Test Town {nope}');
});

test('settings are grouped into friendly sections', () => {
  const f = (raw) => normalizeField({ web: true, ...raw });
  assert.equal(sectionOf(f({ key: 'a', type: 'boolean' })), 'switches');
  assert.equal(sectionOf(f({ key: 'filters', type: 'complex' })), 'switches');
  assert.equal(sectionOf(f({ key: 'c', type: 'roles' })), 'places');
  assert.equal(sectionOf(f({ key: 'filterExempt', type: 'complex' })), 'places');
  assert.equal(sectionOf(f({ key: 'escalation', type: 'complex' })), 'behavior');
  assert.equal(sectionOf(f({ key: 'd', type: 'select', options: [{ value: 1 }] })), 'behavior');
  assert.equal(sectionOf(f({ key: 'e', type: 'text' })), 'messages');
  assert.equal(sectionOf(f({ key: 'g', type: 'number' })), 'numbers');
});

test('the automod page uses tiles, option cards and chips, and saves only what changed', async () => {
  state.details.clear();
  const values = { strictness: 'normal', filters: { spam: true, links: false, raid: false }, actions: { spam: 'delete', links: 'delete' }, filterExempt: {}, 'spam.max': 5, verify: { enabled: false } };
  setDetail(SID, detail({ automod: { values, schema: automodSchema }, lookups }));
  const sent = [];
  const ctx = makeCtx({
    get: async () => detail({ automod: { values, schema: automodSchema }, lookups }),
    job: () => new Promise(() => {}),
    run: async (method, path, body) => {
      sent.push(body);
      return { data: { ok: true, applied: body.settings, errors: {} } };
    },
  });
  renderAppSettings(ctx);
  await flush();
  const main = ctx.main;
  assert.equal(main.querySelectorAll('.toggle-tile').length, 3);
  assert.equal(main.querySelectorAll('.option-card').length, 3);
  assert.equal(main.querySelectorAll('.map-row').length, 4);
  assert.ok(main.querySelector('.range'));
  assert.ok(main.querySelector('.settings-toolbar'));
  assert.match(main.textContent, /Managed with commands/);
  assert.match(main.textContent, /Raid shield/);

  const links = main.querySelectorAll('.toggle-tile').find((t) => t.dataset.key === 'links');
  links.querySelector('.toggle-name').click();
  assert.ok(links.classList.contains('is-on'));
  const strict = main.querySelectorAll('.option-card').find((c) => c.dataset.value === 'strict');
  strict.click();
  assert.equal(strict.getAttribute('aria-checked'), 'true');
  const timeoutChip = main.querySelectorAll('.choice-chip').filter((c) => c.dataset.value === 'timeout')[1];
  timeoutChip.click();
  main.querySelectorAll('.stepper-btn')[1].click();
  assert.equal(ctx.guard.isDirty(), true);
  main.querySelectorAll('button').find((b) => /^Save$/.test(b.textContent.trim())).click();
  await flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].settings, {
    strictness: 'strict',
    filters: { spam: true, links: true, raid: false },
    actions: { spam: 'delete', links: 'timeout' },
    'spam.max': 6,
  });
  assert.equal(ctx.guard.isDirty(), false);
  ctx.abort();
});

test('searching hides settings that do not match and says when nothing does', async () => {
  state.details.clear();
  const values = { strictness: 'normal', filters: { spam: true }, actions: {}, filterExempt: {}, 'spam.max': 5 };
  setDetail(SID, detail({ automod: { values, schema: automodSchema }, lookups }));
  const ctx = makeCtx({ get: async () => detail({ automod: { values, schema: automodSchema }, lookups }), job: () => new Promise(() => {}), run: async () => ({ data: {} }) });
  renderAppSettings(ctx);
  await flush();
  const search = ctx.main.querySelector('.settings-search input');
  type(search, 'flood');
  const field = (key) => ctx.main.querySelectorAll('.field').find((f) => f.dataset.key === key);
  assert.equal(field('spam.max').hidden, false);
  assert.equal(field('strictness').hidden, true);
  type(search, 'zzzz');
  assert.equal(ctx.main.querySelector('.settings-nomatch').hidden, false);
  ctx.abort();
});

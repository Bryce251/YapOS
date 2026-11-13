import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, type, flush } from './dom-shim.js';

const SID = '44444444-4444-4444-8444-444444444444';
const { document } = installDom({ url: `https://dash.example.test/servers/${SID}/apps/automod` });
const { state, setDetail } = await import('../web/js/state.js');
const { renderAppSettings, sectionOf } = await import('../web/js/pages/app-settings.js');
const { normalizeField, toEditValue, fromEditValue, validateField, mapItems, sameValue, splitEmoji, describeReadOnly } = await import('../web/js/forms.js');
const { fillPlaceholders, placeholdersIn } = await import('../web/js/settings-editors.js');
const { fieldRow } = await import('../web/js/fields.js');

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

const bigNumber = (extra = {}) => normalizeField({ key: 'maxBet', label: 'Biggest bet', type: 'number', web: true, min: 1, max: 1e15, step: 1, ...extra });

test('a number setting that allows no limit round-trips inf', () => {
  const f = bigNumber({ unlimited: true });
  assert.equal(f.unlimited, true);
  assert.equal(toEditValue(f, 'inf'), 'inf');
  assert.equal(toEditValue(f, Infinity), 'inf');
  assert.equal(toEditValue(f, 'unlimited'), 'inf');
  assert.equal(toEditValue(f, 500), '500');
  assert.equal(fromEditValue(f, ' INF '), 'inf');
  assert.equal(fromEditValue(f, '2500'), 2500);
  assert.equal(fromEditValue(f, ''), null);
  assert.equal(validateField(f, 'inf'), '');
  assert.equal(validateField(f, '1000000000'), '');
  assert.match(validateField(f, '0'), /1 or more/);
});

test('a plain number setting says inf is not a number and keeps a readable ceiling', () => {
  const f = bigNumber();
  assert.equal(f.unlimited, false);
  assert.equal(toEditValue(f, 'inf'), '');
  assert.match(validateField(f, 'inf'), /needs a number/);
  assert.equal(validateField(f, '1000000000'), '');
  assert.match(validateField(f, '2000000000000000'), /too big/);
  assert.doesNotMatch(validateField(f, '2000000000000000'), /\d{7}/);
  assert.equal(validateField(bigNumber({ max: 50 }), '51'), 'Use 50 or less.');
});

test('the no limit toggle flips a number field between any amount and a typed number', () => {
  const f = bigNumber({ unlimited: true });
  let latest = '750';
  const row = fieldRow(f, { edit: '750', rawValue: 750, lookups, onChange: (v) => { latest = v; } });
  assert.equal(row.el.querySelector('.range'), null);
  assert.equal(row.el.querySelector('.range-limits'), null);
  const chip = row.el.querySelector('.limit-chip');
  const input = row.el.querySelector('.stepper-input');
  chip.click();
  assert.equal(latest, 'inf');
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.equal(input.disabled, true);
  assert.equal(input.placeholder, 'Any amount');
  chip.click();
  assert.equal(latest, '750');
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  assert.equal(input.disabled, false);
  type(input, 'inf');
  assert.equal(latest, 'inf');
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  row.setValue('750');
  assert.equal(input.value, '750');
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  row.el.querySelectorAll('.stepper-btn')[1].click();
  assert.equal(latest, '751');
  assert.equal(fromEditValue(f, latest), 751);
});

test('a big number field gets a box wide enough for the digits', () => {
  const wide = fieldRow(bigNumber(), { edit: '1000000000000000', rawValue: 1e15, lookups, onChange: () => {} });
  assert.ok(wide.el.querySelector('.number-control').classList.contains('has-big'));
  const small = fieldRow(normalizeField({ key: 'slow', label: 'Slowmode', type: 'number', web: true, min: 0, max: 60, step: 1 }), { edit: '5', rawValue: 5, lookups, onChange: () => {} });
  assert.equal(small.el.querySelector('.number-control').classList.contains('has-big'), false);
});

test('a locked number setting reads as plain language, never Infinity', () => {
  const locked = normalizeField({ key: 'maxBet', label: 'Biggest bet', type: 'number', min: 1, max: 1e15, unlimited: true });
  assert.equal(locked.readOnly, true);
  assert.equal(describeReadOnly(locked, 'inf', lookups), 'Any amount');
  assert.equal(describeReadOnly(locked, Infinity, lookups), 'Any amount');
  assert.equal(describeReadOnly(locked, Number.NaN, lookups), 'Not set');
  assert.equal(describeReadOnly(locked, 2500, lookups), '2500');
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

const ownerSchema = [
  { key: 'xpRate', label: 'XP per message', type: 'number', web: true, owner: true, min: 1, max: 100, step: 1, help: 'How fast XP is earned everywhere.' },
  { key: 'levelUp', label: 'Level up message', type: 'string', web: true, maxLength: 200 },
];

const ownerDetail = (extra = {}) => ({
  overview: { id: SID, name: 'Test Town' },
  apps: [{ id: 'automod', name: 'Levels', enabled: true, canDisable: true }],
  settings: { automod: { values: { xpRate: 15, levelUp: 'gg' }, schema: ownerSchema }, lookups },
  updatedAt: 1,
  level: 'admin',
  ...extra,
});

test('an owner-only field carries its flag through normalizeField', () => {
  assert.equal(normalizeField({ key: 'xpRate', type: 'number', web: true, owner: true }).owner, true);
  assert.equal(normalizeField({ key: 'xpRate', type: 'number', web: true }).owner, false);
});

test('an owner-only field is shown locked with a plain note', () => {
  const f = normalizeField(ownerSchema[0]);
  const row = fieldRow(f, { edit: '15', rawValue: 15, lookups, locked: true, onChange: () => {} });
  assert.equal(row.locked(), true);
  assert.equal(row.el.querySelector('.stepper-input').disabled, true);
  for (const b of row.el.querySelectorAll('button')) assert.equal(b.disabled, true);
  const note = row.el.querySelector('.field-lock');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /Only the bot owner can change this\./);
  assert.match(row.el.querySelector('.field-tag-owner').textContent, /Bot owner/);
});

test('the bot owner still gets a working control', () => {
  const f = normalizeField(ownerSchema[0]);
  let latest = '';
  const row = fieldRow(f, { edit: '15', rawValue: 15, lookups, locked: false, onChange: (v) => { latest = v; } });
  assert.equal(row.locked(), false);
  assert.equal(row.el.querySelector('.stepper-input').disabled, false);
  assert.equal(row.el.querySelector('.field-lock').hidden, true);
  type(row.el.querySelector('.stepper-input'), '20');
  assert.equal(latest, '20');
});

test('the settings page locks owner-only fields for everyone else', async () => {
  state.details.clear();
  setDetail(SID, ownerDetail());
  const ctx = makeCtx({ get: async () => ownerDetail(), job: () => new Promise(() => {}), run: async () => ({ data: {} }) });
  renderAppSettings(ctx);
  await flush();
  const locked = ctx.main.querySelector('.field.is-locked');
  assert.ok(locked, 'the owner-only field is locked');
  assert.equal(locked.dataset.key, 'xpRate');
  assert.equal(ctx.main.querySelectorAll('.field.is-locked').length, 1);
  ctx.abort();
});

test('a refused owner-only save shows what the server said instead of going quiet', async () => {
  state.details.clear();
  state.user = { id: 'owner-1', botOwner: true };
  setDetail(SID, ownerDetail({ botOwner: true }));
  const ctx = makeCtx({
    get: async () => ownerDetail({ botOwner: true }),
    job: () => new Promise(() => {}),
    run: async () => ({ data: { ok: false, applied: {}, errors: { xpRate: 'Only the bot owner can change this.' } } }),
  });
  renderAppSettings(ctx);
  await flush();
  const row = ctx.main.querySelectorAll('.field').find((f) => f.dataset.key === 'xpRate');
  assert.equal(row.classList.contains('is-locked'), false);
  type(row.querySelector('.stepper-input'), '20');
  ctx.main.querySelectorAll('button').find((b) => /^Save$/.test(b.textContent.trim())).click();
  await flush();
  assert.match(row.querySelector('.field-error').textContent, /Only the bot owner can change this\./);
  assert.equal(row.classList.contains('is-locked'), true);
  assert.equal(row.querySelector('.stepper-input').disabled, true);
  state.user = null;
  ctx.abort();
});

test('a locked owner-only field stays locked when its value is refreshed', () => {
  const f = normalizeField({ key: 'dailyAmount', label: 'Daily Shards', type: 'number', web: true, owner: true, unlimited: true, min: 0, max: 1000, step: 1 });
  const row = fieldRow(f, { edit: '250', rawValue: 250, lookups, locked: true, onChange: () => {} });
  assert.equal(row.el.querySelector('.stepper-input').disabled, true);
  row.setValue('300');
  assert.equal(row.locked(), true);
  assert.equal(row.el.querySelector('.stepper-input').disabled, true);
  for (const b of row.el.querySelectorAll('button')) assert.equal(b.disabled, true);
});

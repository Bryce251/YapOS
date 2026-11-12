import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addWord, buildPatch, channelMatches, describeComplex, dirtyKeys, fromEditValue, initialEdits, normalizeSchema,
  readChangeResult, sameValue, toEditValue, validateAll, validateField,
} from '../web/js/forms.js';

const schema = normalizeSchema([
  { key: 'on', label: 'On', type: 'boolean', default: false, web: true },
  { key: 'max', label: 'Max', type: 'number', min: 1, max: 10, step: 1, default: 5, web: true },
  { key: 'msg', label: 'Message', type: 'text', maxLength: 10, web: true },
  { key: 'ch', label: 'Channel', type: 'channel', web: true },
  { key: 'roles', label: 'Roles', type: 'roles', web: true },
  { key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 2, label: 'Two' }], web: true },
  { key: 'dur', label: 'Duration', type: 'duration', web: true },
  { key: 'col', label: 'Color', type: 'color', web: true },
  { key: 'words', label: 'Words', type: 'words', web: true },
  { key: 'rules', label: 'Rules', type: 'complex', web: true, note: 'Use /automod' },
  { key: 'hidden', label: 'Hidden', type: 'number', web: false },
  { key: 'max', label: 'Duplicate', type: 'number', web: true },
  { label: 'No key', type: 'string', web: true },
  { key: 'weird', type: 'mystery', web: true },
]);

const field = (k) => schema.find((f) => f.key === k);

test('schema normalization', () => {
  assert.deepEqual(schema.map((f) => f.key), ['on', 'max', 'msg', 'ch', 'roles', 'mode', 'dur', 'col', 'words', 'rules', 'hidden', 'weird']);
  assert.equal(field('rules').readOnly, true);
  assert.equal(field('hidden').readOnly, true);
  assert.equal(field('weird').type, 'complex');
  assert.equal(field('on').readOnly, false);
  assert.equal(field('roles').multi, true);
  assert.equal(field('words').multi, true);
});

test('edit values round trip', () => {
  assert.equal(toEditValue(field('max'), undefined), '5');
  assert.equal(fromEditValue(field('max'), '7'), 7);
  assert.equal(fromEditValue(field('max'), ''), null);
  assert.equal(toEditValue(field('dur'), 600000), '10m');
  assert.equal(toEditValue(field('dur'), '1h'), '1h');
  assert.equal(fromEditValue(field('dur'), ' 2h '), '2h');
  assert.equal(toEditValue(field('col'), 0xff0000), '#ff0000');
  assert.deepEqual(toEditValue(field('roles'), 'r1'), ['r1']);
  assert.deepEqual(toEditValue(field('roles'), null), []);
  assert.deepEqual(toEditValue(field('words'), 'a, b'), ['a', 'b']);
  assert.equal(fromEditValue(field('mode'), '2'), 2);
  assert.equal(fromEditValue(field('ch'), ''), null);
});

test('validation', () => {
  assert.equal(validateField(field('max'), '11'), 'Use 10 or less.');
  assert.equal(validateField(field('max'), '0'), 'Use 1 or more.');
  assert.equal(validateField(field('max'), '2.5'), 'Use a whole number.');
  assert.equal(validateField(field('max'), 'x'), 'Enter a number.');
  assert.equal(validateField(field('max'), '4'), '');
  assert.match(validateField(field('msg'), 'x'.repeat(11)), /under 11/);
  assert.equal(validateField(field('col'), '#12345'), 'Use a hex color like #f2613f.');
  assert.equal(validateField(field('dur'), 'later'), 'Use a duration like 10m, 2h or 1d 12h.');
  assert.equal(validateField(field('rules'), 'anything'), '');
});

test('dirty tracking and patch', () => {
  const base = initialEdits(schema, { on: false, max: 5, roles: ['a'], words: ['x'] });
  const current = { ...base, roles: base.roles.slice(), words: base.words.slice() };
  assert.deepEqual(dirtyKeys(schema, base, current), []);
  current.on = true;
  current.max = '8';
  current.roles = ['a', 'b'];
  current.words = ['x'];
  assert.deepEqual(dirtyKeys(schema, base, current), ['on', 'max', 'roles']);
  assert.deepEqual(buildPatch(schema, base, current), { on: true, max: 8, roles: ['a', 'b'] });
  assert.equal('rules' in base, false);
  current.max = '99';
  assert.deepEqual(Object.keys(validateAll(schema, current)), ['max']);
});

test('helpers', () => {
  assert.equal(sameValue(['a'], ['a']), true);
  assert.equal(sameValue(['a'], ['b']), false);
  assert.equal(sameValue('1', 1), false);
  assert.deepEqual(addWord(['Spam'], 'spam, eggs,  ham'), ['Spam', 'eggs', 'ham']);
  assert.deepEqual(addWord(['a'], 'b, c', { maxLength: 2 }), ['a', 'b']);
  assert.equal(channelMatches('channel', { kind: 'text' }), true);
  assert.equal(channelMatches('channel', { kind: 'voice' }), false);
  assert.equal(channelMatches('voice_channel', { kind: 'voice' }), true);
  assert.equal(channelMatches('category', { kind: 'category' }), true);
  assert.equal(channelMatches('category', { kind: 'text' }), false);
  assert.equal(describeComplex([1, 2]), '2 items');
  assert.equal(describeComplex({}), 'Not set');
  assert.equal(describeComplex(null), 'Not set');
});

test('change results', () => {
  const ok = readChangeResult({ grant: true, ok: true, applied: { max: 3 }, errors: {}, snapshot: { apps: [] } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.applied, { max: 3 });
  assert.deepEqual(ok.snapshot, { apps: [] });
  const partial = readChangeResult({ grant: true, applied: { a: 1 }, errors: { b: 'That role is above mine.' } });
  assert.equal(partial.ok, false);
  assert.equal(partial.message, '');
  assert.equal(partial.errors.b, 'That role is above mine.');
  const denied = readChangeResult({ grant: false });
  assert.equal(denied.denied, true);
  assert.equal(denied.message, 'You need to be an admin of this server.');
  assert.equal(readChangeResult(null).ok, true);
});

test('read-only fields show readable values instead of ids or counts', async () => {
  const { describeReadOnly } = await import('../web/js/forms.js');
  const lookups = {
    channels: [
      { id: 'c-1', name: 'general', kind: 'text' },
      { id: 'v-1', name: 'Lounge', kind: 'voice' },
      { id: 'k-1', name: 'Voice rooms', kind: 'category' },
    ],
    roles: [{ id: 'r-1', name: 'Member' }, { id: 'r-2', name: 'Trusted' }],
  };
  const f = (type, key = 'x') => normalizeSchema([{ key, type, web: false }])[0];
  assert.equal(describeReadOnly(f('channel'), 'c-1', lookups), '#general');
  assert.equal(describeReadOnly(f('voice_channel'), 'v-1', lookups), '#Lounge');
  assert.equal(describeReadOnly(f('category'), 'k-1', lookups), 'Voice rooms');
  assert.equal(describeReadOnly(f('channel'), 'c-gone', lookups), 'Unknown channel');
  assert.equal(describeReadOnly(f('channel'), null, lookups), 'Not set');
  assert.equal(describeReadOnly(f('roles'), ['r-1', 'r-2'], lookups), '@Member, @Trusted');
  assert.equal(describeReadOnly(f('role'), 'r-9', lookups), 'Unknown role');
  assert.equal(describeReadOnly(f('roles'), [], lookups), 'None');
  assert.equal(describeReadOnly(f('boolean'), true, lookups), 'On');
  assert.equal(describeReadOnly(f('boolean'), false, lookups), 'Off');
  const filters = { spam: true, mentions: true, caps: false, links: false, invites: true, words: true, raid: false };
  assert.equal(describeReadOnly(f('complex'), filters, lookups), 'On: spam, mentions, invites, words');
  assert.equal(describeReadOnly(f('complex'), { spam: false, caps: false }, lookups), 'All off');
  assert.equal(describeReadOnly(f('complex'), { spam: 'delete', links: 'timeout' }, lookups), 'spam: delete, links: timeout');
  assert.equal(describeReadOnly(f('complex'), { enabled: false, channelId: 'c-1', roleId: 'r-1' }, lookups), 'Off');
  assert.equal(describeReadOnly(f('complex'), { 5: 'r-1', 10: 'r-2' }, lookups), '5: @Member, 10: @Trusted');
  assert.equal(describeReadOnly(f('complex'), [{ at: 3, action: 'timeout', durationMs: 3600000 }, { at: 5, action: 'kick' }], lookups), '3: timeout, 5: kick');
  assert.equal(describeReadOnly(f('complex'), { a: { deep: 1 }, b: { deep: 2 } }, lookups), '2 entries');
  assert.ok(describeReadOnly(f('complex'), Array.from({ length: 400 }, (_, i) => `word${i}`), lookups).length <= 240);
});

test('word lists use the schema max as their limit', async () => {
  const { wordLimit } = await import('../web/js/forms.js');
  const [words] = normalizeSchema([{ key: 'words.list', type: 'words', max: 500, web: true }]);
  assert.equal(wordLimit(words), 500);
  assert.equal(validateField(words, Array.from({ length: 500 }, (_, i) => `w${i}`)), '');
  assert.match(validateField(words, Array.from({ length: 600 }, (_, i) => `w${i}`)), /at most 500 words/);
  const [old] = normalizeSchema([{ key: 'w', type: 'words', maxLength: 3, web: true }]);
  assert.equal(wordLimit(old), 3);
  const [free] = normalizeSchema([{ key: 'w', type: 'words', web: true }]);
  assert.equal(wordLimit(free), null);
  assert.equal(validateField(free, Array.from({ length: 900 }, (_, i) => `w${i}`)), '');
});

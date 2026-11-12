import test from 'node:test';
import assert from 'node:assert/strict';
import { medalFor, normalizeBoard, normalizeWrapped } from '../web/js/public-data.js';

test('levels board', () => {
  const rows = normalizeBoard([
    { rank: 2, id: 'b', name: 'Bea', avatar_url: '', level: 9, xp: 1200, messages: 400 },
    { rank: 1, id: 'a', name: 'Al', level: 12, xp: 3000 },
    null,
  ], 'levels');
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
  assert.equal(rows[0].primary, 12);
  assert.equal(rows[1].secondary, '1,200 XP · 400 messages');
});

test('coins board', () => {
  const rows = normalizeBoard([{ rank: 1, id: 'a', name: 'Al', balance: 1500 }], 'economy');
  assert.equal(rows[0].primary, 1500);
  assert.equal(rows[0].primaryLabel, 'coins');
  assert.deepEqual(normalizeBoard(undefined, 'economy'), []);
});

test('medals', () => {
  assert.equal(medalFor(1), 'gold');
  assert.equal(medalFor(2), 'silver');
  assert.equal(medalFor(3), 'bronze');
  assert.equal(medalFor(4), '');
});

test('wrapped from structured data', () => {
  const w = normalizeWrapped({
    month: 'October 2026',
    messages: 12034,
    activeMembers: 88,
    voiceSeconds: 7200,
    busiestHour: 21,
    busiestDay: 5,
    topChatters: [{ name: 'Al', count: 900 }, { name: 'Bea', count: 700 }],
    topReactions: [['🔥', 40]],
    memberOfMonth: { name: 'Al', messages: 900 },
  });
  assert.equal(w.month, 'October 2026');
  assert.equal(w.empty, false);
  const stats = Object.fromEntries(w.stats.map((s) => [s.label, s.value]));
  assert.equal(stats.Messages, '12,034');
  assert.equal(stats['Active members'], '88');
  assert.equal(stats['Voice time'], '2 h');
  assert.equal(stats['Busiest hour'], '9pm UTC');
  assert.equal(stats['Busiest day'], 'Friday');
  assert.equal(w.lists.find((l) => l.title === 'Top chatters').items[0].value, '900');
  assert.equal(w.lists.find((l) => l.title === 'Top reactions').items[0].label, '🔥');
  assert.equal(w.highlights[0].label, 'Al');
});

test('wrapped from embed fields', () => {
  const w = normalizeWrapped({
    title: 'Server Wrapped · October',
    fields: [
      { name: '💬 Messages', value: '**1,234**' },
      { name: '🏆 Top chatters', value: '🥇 <@abc> · 10\n🥈 <@def> · 5' },
      { name: '⏰ Busiest time', value: '9pm UTC\nFridays' },
      { name: '🔥 Most reacted message', value: '4 reactions · [jump to it](https://x/y)' },
    ],
  });
  assert.equal(w.title, 'Server Wrapped · October');
  assert.deepEqual(w.stats, [{ label: 'Messages', value: '1,234' }]);
  assert.deepEqual(w.lists.map((l) => l.title), ['Busiest time']);
});

test('wrapped from the bot service shape', () => {
  const w = normalizeWrapped({ month: '2026-10', card: { title: '🎁 Cozy Corner Wrapped · October 2026', description: 'Here is how the month went.', fields: [{ name: '👥 Active members', value: '**88**', inline: true }] } });
  assert.equal(w.month, 'October 2026');
  assert.equal(w.title, 'Cozy Corner Wrapped · October 2026');
  assert.equal(w.note, 'Here is how the month went.');
  assert.deepEqual(w.stats, [{ label: 'Active members', value: '88' }]);
  const empty = normalizeWrapped({ month: '2026-10', card: { title: 'x', description: 'No recap for October 2026 yet.' } });
  assert.equal(empty.empty, true);
  assert.equal(empty.note, 'No recap for October 2026 yet.');
});

test('wrapped empty states', () => {
  assert.equal(normalizeWrapped(null), null);
  assert.equal(normalizeWrapped({ month: 'x' }).empty, true);
});

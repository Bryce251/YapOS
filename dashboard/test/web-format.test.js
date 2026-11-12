import test from 'node:test';
import assert from 'node:assert/strict';
import {
  caseTone, caseTypeLabel, formatCompact, formatDurationMs, formatNumber, formatUptime, hueFrom, initials, isValidSlug,
  levelLabel, looksLikeDuration, plural, relativeTime, safeImageUrl, slugify, toHexColor, toMillis, truncate,
} from '../web/js/format.js';

test('numbers', () => {
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatNumber('42'), '42');
  assert.equal(formatNumber(null), '–');
  assert.equal(formatCompact(9999), '9,999');
  assert.equal(formatCompact(12500), '12.5K');
  assert.equal(plural(1, 'case'), '1 case');
  assert.equal(plural(3, 'case'), '3 cases');
});

test('time', () => {
  const now = Date.UTC(2026, 10, 12, 12, 0, 0);
  assert.equal(toMillis(1700000000), 1700000000000);
  assert.equal(toMillis(1700000000000), 1700000000000);
  assert.equal(toMillis('2026-11-12T12:00:00Z'), now);
  assert.equal(toMillis('nope'), null);
  assert.equal(relativeTime(now - 10000, now), 'just now');
  assert.equal(relativeTime(now - 5 * 60000, now), '5 minutes ago');
  assert.equal(relativeTime(now - 3600000, now), '1 hour ago');
  assert.equal(relativeTime(now - 3 * 86400000, now), '3 days ago');
  assert.equal(relativeTime(now + 2 * 3600000, now), 'in 2 hours');
  assert.equal(relativeTime(null, now), '');
});

test('durations', () => {
  assert.equal(formatUptime(30), '30s');
  assert.equal(formatUptime(3725), '1h 2m');
  assert.equal(formatUptime(2 * 86400 + 3 * 3600 + 60), '2d 3h');
  assert.equal(formatUptime(-1), '–');
  assert.equal(formatDurationMs(600000), '10m');
  assert.equal(formatDurationMs(9000000), '2h30m');
  assert.equal(formatDurationMs(500), '500ms');
  assert.equal(looksLikeDuration('10m'), true);
  assert.equal(looksLikeDuration('2h 30m'), true);
  assert.equal(looksLikeDuration('15'), true);
  assert.equal(looksLikeDuration(''), true);
  assert.equal(looksLikeDuration('soon'), false);
  assert.equal(looksLikeDuration('10m!'), false);
});

test('initials and hue', () => {
  assert.equal(initials('Jolli Bean'), 'JB');
  assert.equal(initials('yapper'), 'YA');
  assert.equal(initials('  '), '?');
  assert.equal(initials('🎉 Party'), 'PA');
  assert.equal(hueFrom('abc'), hueFrom('abc'));
  assert.ok(hueFrom('abc') >= 0 && hueFrom('abc') < 360);
});

test('image urls only from allowed https hosts', () => {
  assert.equal(safeImageUrl('https://files.yapper.website/a.png'), 'https://files.yapper.website/a.png');
  assert.equal(safeImageUrl('https://www.yapin.gg/x.png'), 'https://www.yapin.gg/x.png');
  assert.equal(safeImageUrl('http://files.yapper.website/a.png'), '');
  assert.equal(safeImageUrl('javascript:alert(1)'), '');
  assert.equal(safeImageUrl('https://evil.example/a.png'), '');
  assert.equal(safeImageUrl(42), '');
});

test('slugs', () => {
  assert.equal(slugify('Café Gamers!!'), 'cafe-gamers');
  assert.equal(slugify('ab'), '');
  assert.equal(slugify('x'.repeat(40)).length, 32);
  assert.equal(isValidSlug('my-server'), true);
  assert.equal(isValidSlug('My-Server'), false);
  assert.equal(isValidSlug('ab'), false);
  assert.equal(isValidSlug('a'.repeat(33)), false);
});

test('labels and colors', () => {
  assert.equal(caseTypeLabel('warn'), 'Warning');
  assert.equal(caseTypeLabel('custom_thing'), 'Custom thing');
  assert.equal(caseTone('ban'), 'danger');
  assert.equal(caseTone('unban'), 'success');
  assert.equal(levelLabel('owner'), 'Owner');
  assert.equal(levelLabel(''), 'Member');
  assert.equal(toHexColor(0xf2613f), '#f2613f');
  assert.equal(toHexColor('#ABC'), '#aabbcc');
  assert.equal(toHexColor('f2613f'), '#f2613f');
  assert.equal(toHexColor('red'), '');
  assert.equal(truncate('hello world', 6), 'hello…');
  assert.equal(truncate('hi', 6), 'hi');
});

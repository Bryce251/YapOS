import test from 'node:test';
import assert from 'node:assert/strict';
import { caseTypes, filterCases, normalizeCases, readCasesPage, sortCases } from '../web/js/cases.js';

const T = Date.UTC(2026, 9, 1);
const raw = [
  { n: 3, type: 'ban', user: { id: 'u1', name: 'Ava' }, mod: { id: 'm1', name: 'Mo' }, reason: 'Raid spam', at: T + 3000, active: true },
  { n: 2, type: 'warn', user: { id: 'u2', name: 'ben' }, mod: { id: 'm2', name: 'Zed' }, reason: 'Caps', at: T + 2000 },
  { n: 1, type: 'timeout', user: { id: 'u1', name: 'Ava' }, mod: { id: 'm2', name: 'Zed' }, reason: '', at: T + 1000, duration: 600000, active: false },
  { n: 12, type: 'warn', user: 'u3', mod: null, reason: 'Links', at: new Date(T + 4000).toISOString() },
];
const list = normalizeCases(raw);

test('normalizes odd shapes', () => {
  assert.equal(list[3].user.id, 'u3');
  assert.equal(list[3].mod.name, 'Unknown');
  assert.equal(list[3].at, T + 4000);
  assert.equal(list[0].typeLabel, 'Ban');
  assert.deepEqual(normalizeCases(null), []);
});

test('search and filters', () => {
  assert.deepEqual(filterCases(list, { q: 'ava' }).map((c) => c.n), [3, 1]);
  assert.deepEqual(filterCases(list, { q: '#12' }).map((c) => c.n), [12]);
  assert.deepEqual(filterCases(list, { q: '#1' }).map((c) => c.n), [1]);
  assert.deepEqual(filterCases(list, { q: 'zed caps' }).map((c) => c.n), [2]);
  assert.deepEqual(filterCases(list, { type: 'warn' }).map((c) => c.n), [2, 12]);
  assert.deepEqual(filterCases(list, { status: 'active' }).map((c) => c.n), [3]);
  assert.deepEqual(filterCases(list, { status: 'ended' }).map((c) => c.n), [2, 1, 12]);
  assert.deepEqual(filterCases(list, { q: 'nothing-like-this' }), []);
});

test('sorting', () => {
  assert.deepEqual(sortCases(list, { key: 'n', dir: 'desc' }).map((c) => c.n), [12, 3, 2, 1]);
  assert.deepEqual(sortCases(list, { key: 'at', dir: 'asc' }).map((c) => c.n), [1, 2, 3, 12]);
  assert.deepEqual(sortCases(list, { key: 'user', dir: 'asc' }).map((c) => c.user.name), ['Ava', 'Ava', 'ben', 'u3']);
  assert.deepEqual(sortCases(list, { key: 'bogus' }).map((c) => c.n), [12, 3, 2, 1]);
});

test('type options', () => {
  assert.deepEqual(caseTypes(list).map((t) => t.value), ['ban', 'timeout', 'warn']);
});

test('reads worker case pages', () => {
  assert.deepEqual(readCasesPage({ cases: [1, 2], total: 120, page: 1, pages: 3, pageSize: 50 }), { cases: [1, 2], more: true, total: 120 });
  assert.equal(readCasesPage({ cases: [1], total: 120, page: 3, pages: 3 }).more, false);
  assert.deepEqual(readCasesPage([1, 2]), { cases: [1, 2], more: false });
  assert.equal(readCasesPage(null).cases.length, 0);
});

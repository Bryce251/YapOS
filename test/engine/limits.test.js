import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNLIMITED,
  HARD_CAP,
  isUnlimited,
  parseLimit,
  readLimit,
  storeLimit,
  fmtNumber,
  limitText,
  atMost,
  withinLimit,
  limitHelp,
} from '../../engine/limits.js';

test('limits: plain numbers, commas and spare spaces all read as whole numbers', () => {
  assert.equal(parseLimit('0'), 0);
  assert.equal(parseLimit('7'), 7);
  assert.equal(parseLimit(' 42 '), 42);
  assert.equal(parseLimit('1,000'), 1000);
  assert.equal(parseLimit('12,345,678'), 12345678);
  assert.equal(parseLimit(250), 250);
});

test('limits: k, m, b and t shortcuts work', () => {
  assert.equal(parseLimit('2k'), 2000);
  assert.equal(parseLimit('5M'), 5_000_000);
  assert.equal(parseLimit('3b'), 3_000_000_000);
  assert.equal(parseLimit('1t'), 1_000_000_000_000);
  assert.equal(parseLimit('1.5k'), 1500);
  assert.equal(parseLimit('2.25m'), 2_250_000);
  assert.equal(parseLimit('0.5k'), 500);
});

test('limits: the old million ceiling is gone', () => {
  assert.ok(HARD_CAP > 1_000_000);
  assert.equal(parseLimit('1000001'), 1_000_001);
  assert.equal(parseLimit('1,000,001'), 1_000_001);
  assert.equal(parseLimit('50m'), 50_000_000);
  assert.equal(parseLimit('999,999,999,999'), 999_999_999_999);
  assert.equal(readLimit('25m', 1000), 25_000_000);
  assert.equal(parseLimit('2m', { max: HARD_CAP }), 2_000_000);
});

test('limits: a coins word on the end is ignored', () => {
  assert.equal(parseLimit('100 coins'), 100);
  assert.equal(parseLimit('1 coin'), 1);
  assert.equal(parseLimit('2,500 COINS'), 2500);
  assert.equal(parseLimit('10k coins'), 10_000);
});

test('limits: spaces inside a number are closed up rather than refused', () => {
  assert.equal(parseLimit('1 000'), 1000);
  assert.equal(parseLimit('5 5'), 55);
});

test('limits: anything that is not a whole number or not a number at all is turned down', () => {
  assert.equal(parseLimit('1.1'), null);
  assert.equal(parseLimit('1.0001k'), null);
  assert.equal(parseLimit('abc'), null);
  assert.equal(parseLimit(''), null);
  assert.equal(parseLimit('  '), null);
  assert.equal(parseLimit(null), null);
  assert.equal(parseLimit(undefined), null);
  assert.equal(parseLimit('5 / 5'), null);
  assert.equal(parseLimit('$5'), null);
  assert.equal(parseLimit('1e5'), null);
  assert.equal(parseLimit(NaN), null);
  assert.equal(parseLimit(-Infinity), null);
});

test('limits: negatives and out-of-range amounts are turned down', () => {
  assert.equal(parseLimit('-5'), null);
  assert.equal(parseLimit(-5), null);
  assert.equal(parseLimit('2000t'), null);
  assert.equal(parseLimit(String(HARD_CAP)), HARD_CAP);
  assert.equal(parseLimit(HARD_CAP + 1), null);
});

test('limits: min and max options bound what is allowed', () => {
  assert.equal(parseLimit('5', { min: 10 }), null);
  assert.equal(parseLimit('10', { min: 10 }), 10);
  assert.equal(parseLimit('50', { max: 10 }), null);
  assert.equal(parseLimit('10', { max: 10 }), 10);
  assert.equal(parseLimit('-1', { min: -100 }), null);
});

test('limits: turning off unlimited makes inf words plain junk', () => {
  assert.equal(parseLimit('inf', { unlimited: false }), null);
  assert.equal(parseLimit('unlimited', { unlimited: false }), null);
  assert.equal(parseLimit(Infinity, { unlimited: false }), null);
  assert.equal(parseLimit('500', { unlimited: false }), 500);
});

test('limits: every way of saying no limit counts, however it is typed', () => {
  const words = ['inf', 'infinite', 'infinity', 'unlimited', 'nolimit', 'nocap', 'none', 'any', 'forever', '∞'];
  for (const word of words) {
    assert.equal(isUnlimited(word), true, `${word} should mean no limit`);
    assert.equal(parseLimit(word), UNLIMITED, `${word} should parse as no limit`);
  }
  assert.equal(isUnlimited('INF'), true);
  assert.equal(isUnlimited('  Infinity  '), true);
  assert.equal(isUnlimited('No Limit'), true);
  assert.equal(isUnlimited('no-limit'), true);
  assert.equal(isUnlimited('NO_CAP'), true);
  assert.equal(isUnlimited('Un-Limited'), true);
  assert.equal(isUnlimited('any amount'), true);
  assert.equal(isUnlimited(Infinity), true);
  assert.equal(UNLIMITED, Infinity);
});

test('limits: words that only look like inf are left alone', () => {
  for (const word of ['info', 'infant', 'information', 'max', 'maximum', 'all', 'lots', 'cap', 'no', 'limit', '10', '', '  ']) {
    assert.equal(isUnlimited(word), false, `${word} should not mean no limit`);
  }
  assert.equal(parseLimit('max'), null);
  assert.equal(parseLimit('10'), 10);
  assert.equal(isUnlimited(0), false);
  assert.equal(isUnlimited(1_000_000), false);
  assert.equal(isUnlimited(NaN), false);
  assert.equal(isUnlimited(null), false);
  assert.equal(isUnlimited(undefined), false);
});

test('limits: reading a setting falls back when there is nothing usable saved', () => {
  assert.equal(readLimit(undefined, 500), 500);
  assert.equal(readLimit(null, 500), 500);
  assert.equal(readLimit('', 500), 500);
  assert.equal(readLimit('junk', 500), 500);
  assert.equal(readLimit('2k', 500), 2000);
  assert.equal(readLimit(1234, 500), 1234);
  assert.equal(readLimit('inf', 500), UNLIMITED);
  assert.equal(readLimit('inf', 500, { unlimited: false }), 500);
  assert.equal(readLimit('5', 500, { min: 10 }), 500);
});

test('limits: no limit is always saved as the word inf so it survives JSON', () => {
  assert.equal(storeLimit(Infinity), 'inf');
  assert.equal(storeLimit(UNLIMITED), 'inf');
  assert.equal(storeLimit('unlimited'), 'inf');
  assert.equal(storeLimit('NO CAP'), 'inf');
  assert.equal(storeLimit(2500), 2500);
  assert.equal(storeLimit(0), 0);

  assert.equal(JSON.stringify(Infinity), 'null');
  assert.equal(JSON.stringify({ maxBet: storeLimit(Infinity) }), '{"maxBet":"inf"}');
  assert.equal(JSON.stringify({ maxBet: storeLimit(7500) }), '{"maxBet":7500}');

  const saved = JSON.parse(JSON.stringify({ maxBet: storeLimit(Infinity), daily: storeLimit(250) }));
  assert.equal(readLimit(saved.maxBet, 0), UNLIMITED);
  assert.equal(isUnlimited(saved.maxBet), true);
  assert.equal(readLimit(saved.daily, 0), 250);
});

test('limits: numbers are shown with commas and no limit is shown in words', () => {
  assert.equal(fmtNumber(1234567), '1,234,567');
  assert.equal(fmtNumber(0), '0');
  assert.equal(limitText(1500), '1,500');
  assert.equal(limitText(Infinity), 'any amount');
  assert.equal(limitText('inf'), 'any amount');
  assert.equal(limitText('inf', { word: 'no limit' }), 'no limit');
  assert.equal(limitText(42, { fmt: (n) => `${n} coins` }), '42 coins');
});

test('limits: capping an amount does nothing when the cap is off', () => {
  assert.equal(atMost(10, 5), 5);
  assert.equal(atMost(3, 5), 3);
  assert.equal(atMost(5, 5), 5);
  assert.equal(atMost(10, Infinity), 10);
  assert.equal(atMost(10, 'inf'), 10);
  assert.equal(atMost(HARD_CAP, 'unlimited'), HARD_CAP);
});

test('limits: everything is within an unlimited cap', () => {
  assert.equal(withinLimit(5, 10), true);
  assert.equal(withinLimit(10, 10), true);
  assert.equal(withinLimit(11, 10), false);
  assert.equal(withinLimit(HARD_CAP, Infinity), true);
  assert.equal(withinLimit(HARD_CAP, 'inf'), true);
  assert.equal(withinLimit(1, 'none'), true);
});

test('limits: the help line says what to type', () => {
  assert.equal(limitHelp('no limit'), 'Use a whole number from 0 up, like `500`, or `inf` for no limit.');
  assert.equal(
    limitHelp('any amount', { min: 1000, example: '5k', word: 'unlimited' }),
    'Use a whole number from 1,000 up, like `5k`, or `unlimited` for any amount.',
  );
  assert.ok(!limitHelp('no limit').includes('1,000,000'));
});

test('limits: no limit never reaches the user or the save file as Infinity', () => {
  const shown = [limitText(UNLIMITED), limitText('inf'), limitText(readLimit('inf', 1000)), limitText(storeLimit(UNLIMITED))];
  for (const text of shown) {
    assert.equal(text, 'any amount');
    assert.ok(!/infinity|∞|null|nan/i.test(text), `${text} should not leak a raw value`);
  }
  assert.equal(limitText(readLimit(undefined, UNLIMITED)), 'any amount');
  assert.equal(JSON.stringify({ maxBet: storeLimit(parseLimit('inf')) }), '{"maxBet":"inf"}');
  assert.equal(limitText(parseLimit('no limit'), { word: 'no cap' }), 'no cap');
});

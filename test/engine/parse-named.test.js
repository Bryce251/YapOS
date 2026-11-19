import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNamedArgs, namedToArgs, normalizeCommandArgs, tokenize } from '../../engine/parse.js';

const BAN = [
  { name: 'user', type: 'user', required: true },
  { name: 'days', type: 'integer' },
  { name: 'reason', type: 'string' },
];
const U = 'a0000000-0000-4000-8000-000000000004';

test('name=value pairs with quotes map onto positional args in option order', () => {
  const out = normalizeCommandArgs({ args: `reason="spam and ads" days=7 user=<@${U}>` }, BAN);
  assert.equal(out.args, `<@${U}> 7 spam and ads`);
  assert.deepEqual(out.values, { user: `<@${U}>`, days: '7', reason: 'spam and ads' });
  assert.deepEqual(tokenize(out.args), [`<@${U}>`, '7', 'spam', 'and', 'ads']);
});

test('escaped quotes and backslashes inside a quoted value', () => {
  const p = parseNamedArgs('user=<@x> reason="he said \\"hi\\" \\\\ then left"', ['user', 'reason']);
  assert.equal(p.values.reason, 'he said "hi" \\ then left');
  const lone = parseNamedArgs('reason="a \\n b"', ['reason']);
  assert.equal(lone.values.reason, 'a \\n b', 'other backslashes stay as typed');
});

test('an unclosed quote takes the rest of the text', () => {
  const p = parseNamedArgs('user=<@x> reason="spam and ads', ['user', 'reason']);
  assert.equal(p.values.reason, 'spam and ads');
});

test('missing values are left out instead of becoming empty args', () => {
  const out = normalizeCommandArgs({ args: `user=<@${U}> days= reason=""` }, BAN);
  assert.equal(out.args, `<@${U}>`);
  assert.deepEqual(out.values, { user: `<@${U}>` });
});

test('unknown names and loose words fall back to plain text at the end', () => {
  const out = normalizeCommandArgs({ args: `user=<@${U}> colour=red extra words` }, BAN);
  assert.equal(out.args, `<@${U}> colour=red extra words`);
  const p = parseNamedArgs('user=<@x> foo="a b"', ['user']);
  assert.deepEqual(p.extra, ['foo="a b"']);
});

test('a middle value with spaces is quoted so it stays one token', () => {
  const opts = [{ name: 'action', type: 'string' }, { name: 'name', type: 'string' }, { name: 'tag', type: 'string' }];
  const out = normalizeCommandArgs({ args: 'action=create tag=OWL name="Night Owls"' }, opts);
  assert.equal(out.args, 'create "Night Owls" OWL');
  assert.deepEqual(tokenize(out.args), ['create', 'Night Owls', 'OWL']);
  const q = namedToArgs({ action: 'note', name: 'say "hi" now' }, opts.slice(0, 2).concat({ name: 'x', type: 'user' }));
  assert.deepEqual(tokenize(q), ['note', 'say "hi" now']);
});

test('names match without caring about case, and the last repeat wins', () => {
  const out = normalizeCommandArgs({ args: 'USER=<@a> user=<@b> Days=3' }, BAN);
  assert.equal(out.args, '<@b> 3');
});

test('plain typed shortcuts are never rewritten', () => {
  for (const args of ['timeout @sam 10m spamming', `<@${U}> 7 reason=spam`, '', '   ', 'user is here', '"user=<@x>" quoted', '=7 user']) {
    assert.equal(normalizeCommandArgs({ args }, BAN), null, args);
  }
  assert.equal(normalizeCommandArgs({ args: 'user=<@x>' }, []), null, 'no options, nothing to map');
  assert.equal(normalizeCommandArgs({ args: 'user=<@x>' }, null), null);
});

test('options handed over by the event fill empty args', () => {
  const arr = normalizeCommandArgs({ args: '', options: [{ name: 'user', value: `<@${U}>` }, { name: 'reason', value: 'spam and ads' }] }, BAN);
  assert.equal(arr.args, `<@${U}> spam and ads`);
  const obj = normalizeCommandArgs({ args: '', options: { days: 2, user: { id: U } } }, BAN);
  assert.equal(obj.args, `${U} 2`);
  assert.equal(normalizeCommandArgs({ args: 'typed text', options: { user: 'x' } }, BAN), null, 'typed args win');
});

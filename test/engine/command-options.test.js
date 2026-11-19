import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { defineApp } from '../../engine/apps.js';
import { DEFAULT_COMMAND_OPTIONS, optionsProblem, isRefusal } from '../../engine/commands.js';

const S = IDS.server;
const U = IDS.member;

const putCommands = (h) => h.bot.api('PUT', '/commands', { commands: [...h.bot.commands].map(([name, c]) => ({ name, description: c.description })), interactions: true });
const lastPut = (h) => { const c = h.fake.callsTo('PUT', /^\/commands$/); return c[c.length - 1]?.body; };
const byName = (body, n) => body.commands.find((c) => c.name === n);

function probeApp(seen, options) {
  return defineApp({
    id: 'probe',
    commands: { probe: { description: 'Probe', options, run: async (ctx) => { seen.push({ argv: ctx.argv, args: ctx.args, named: ctx.source.namedArgs }); } } },
  });
}

test('every built-in options list is valid for Yapin', () => {
  for (const [name, list] of Object.entries(DEFAULT_COMMAND_OPTIONS)) assert.equal(optionsProblem(list), null, `/${name}`);
});

test('bad option lists are caught when the app is defined', () => {
  assert.match(optionsProblem([{ name: 'a', type: 'string' }, { name: 'b', type: 'user', required: true }]), /after an optional/);
  assert.match(optionsProblem(Array.from({ length: 11 }, (_, i) => ({ name: `o${i}`, type: 'string' }))), /up to 10/);
  assert.match(optionsProblem([{ name: 'a', type: 'string', choices: Array.from({ length: 26 }, (_, i) => `c${i}`) }]), /1 to 25/);
  assert.match(optionsProblem([{ name: 'a', type: 'user', choices: ['x'] }]), /can't have choices/);
  assert.match(optionsProblem([{ name: 'a', type: 'date' }]), /unknown type/);
  assert.match(optionsProblem([{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }]), /twice/);
  assert.throws(() => defineApp({ id: 'bad', commands: { bad: { description: 'x', options: [{ name: 'Bad Name', type: 'string' }], run() {} } } }), /bad option name/);
});

test('PUT /commands carries options for hub commands and leaves others plain', async () => {
  const h = await createHarness({ apps: ['mod', 'tickets'] });
  await putCommands(h);
  const body = lastPut(h);
  const ban = byName(body, 'ban');
  assert.deepEqual(ban.options.map((o) => o.name), ['user', 'length', 'reason']);
  assert.equal(ban.options[0].type, 'user');
  assert.equal(ban.options[0].required, true);
  assert.ok(byName(body, 'mod').options[0].choices.length <= 25);
  assert.ok(byName(body, 'mod').options[0].choices.every((c) => c.name && c.value));
  assert.ok(byName(body, 'tickets').options);
  assert.equal(byName(body, 'menu').options, undefined, 'commands without hints stay name + description');
  assert.equal(body.interactions, true);
  assert.equal(h.engine.caps.state(null, 'command_options'), true);
});

test('a refused PUT is sent again without options and hints stay off', async () => {
  const h = await createHarness({ apps: ['mod'] });
  h.fake.fail('PUT', /^\/commands$/, { status: 400, error: 'Unknown field options', times: 1 });
  const out = await putCommands(h);
  assert.ok(out);
  const puts = h.fake.callsTo('PUT', /^\/commands$/);
  assert.ok(puts.at(-2).body.commands.some((c) => c.options), 'first try had options');
  assert.ok(puts.at(-1).body.commands.every((c) => !c.options), 'retry had none');
  assert.equal(h.engine.caps.state(null, 'command_options'), false);
  await putCommands(h);
  assert.ok(lastPut(h).commands.every((c) => !c.options), 'later syncs skip options while marked off');
  assert.equal(h.engine.commandOptions.stats.refused, 1);
});

test("a feature-off answer also falls back", async () => {
  const h = await createHarness({ apps: ['mod'] });
  h.fake.fail('PUT', /^\/commands$/, { status: 403, error: "This isn't on for this server yet", times: 1 });
  await putCommands(h);
  assert.ok(lastPut(h).commands.every((c) => !c.options));
  assert.equal(h.engine.caps.state(null, 'command_options'), false);
});

test('other failures are not hidden by the fallback', async () => {
  const h = await createHarness({ apps: ['mod'] });
  h.fake.fail('PUT', /^\/commands$/, { status: 401, error: 'Bad token', times: 1 });
  await assert.rejects(putCommands(h), /Bad token/);
  assert.equal(isRefusal({ status: 500, message: 'boom' }), false);
  assert.equal(isRefusal({ status: 0, message: 'fetch failed' }), false);
});

test('other API calls pass through untouched', async () => {
  const h = await createHarness({ apps: ['mod'] });
  await h.bot.api('PUT', '/commands', { commands: [{ name: 'nothing', description: 'x' }] });
  assert.equal(lastPut(h).commands[0].options, undefined);
  const me = await h.bot.api('GET', '/me');
  assert.ok(me);
});

test('a command app can declare its own options, or turn the default ones off', async () => {
  const h = await createHarness({ apps: [] });
  const seen = [];
  const app = probeApp(seen, [{ name: 'user', type: 'user' }, { name: 'note', type: 'string' }]);
  await app.setup(h.bot);
  await putCommands(h);
  assert.deepEqual(byName(lastPut(h), 'probe').options.map((o) => o.name), ['user', 'note']);
  await app.teardown();
  assert.equal(h.engine.commandOptions.optionsFor('probe'), null);
  const off = defineApp({ id: 'modoff', commands: { ban: { description: 'x', options: null, run() {} } } });
  await off.setup(h.bot);
  assert.equal(h.engine.commandOptions.optionsFor('ban'), null);
});

test('form-style args reach the command as normal argv, typed ones are untouched', async () => {
  const h = await createHarness({ apps: [] });
  const seen = [];
  await probeApp(seen, [{ name: 'user', type: 'user' }, { name: 'note', type: 'string' }]).setup(h.bot);
  await h.slash('probe', `note="keeps \\"arguing\\" in general" user=<@${U}>`);
  assert.equal(seen[0].args, `<@${U}> keeps "arguing" in general`);
  assert.deepEqual(seen[0].argv, [`<@${U}>`, 'keeps', 'arguing', 'in', 'general']);
  assert.equal(seen[0].named.user, `<@${U}>`);
  await h.message(`!probe <@${U}> plain words`);
  assert.deepEqual(seen[1].argv, [`<@${U}>`, 'plain', 'words']);
  assert.equal(seen[1].named, undefined);
});

test('/timeout and /mod work with name=value pairs', async () => {
  const h = await createHarness({ apps: ['mod'] });
  await h.slash('timeout', `user=<@${U}> reason="spam and ads" length=10m`, { user: IDS.mod });
  const t = h.fake.state.timeouts[`${S}:${U}`];
  assert.ok(t, 'timed out');
  assert.equal(t.minutes, 10);
  assert.equal(t.reason, 'spam and ads');
  await h.slash('mod', `action=untimeout user=<@${U}>`, { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[`${S}:${U}`], undefined);
  await h.slash('mod', `timeout <@${IDS.member2}> 5m typed`, { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[`${S}:${IDS.member2}`].minutes, 5);
});

test('the command count is unchanged', async () => {
  const h = await createHarness({ apps: ['mod', 'tickets', 'roles', 'verify', 'clans'] });
  const before = h.bot.commands.size;
  await putCommands(h);
  assert.equal(lastPut(h).commands.length, before);
});

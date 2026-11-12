import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarness, IDS } from '../harness.js';
import { createJsonStore, keyToFileName, fileNameToKey } from '../../engine/storage.js';
import { createBackups } from '../../engine/backup.js';
import { createFreshness } from '../../engine/freshness.js';
import { customId } from '../../engine/router.js';
import { row, button } from '../../engine/ui.js';

const S = IDS.server;
const G = IDS.channels.general;
const HOURS = 3 * 60 * 60_000;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yapos-review-'));
const quiet = () => {
  const lines = [];
  const put = (lvl) => (...a) => lines.push(`${lvl} ${a.join(' ')}`);
  return { lines, debug: put('debug'), info: put('info'), warn: put('warn'), error: put('error') };
};

function modStub() {
  const calls = [];
  return {
    calls,
    async warn(sid, targetId, opts) { calls.push({ fn: 'warn', targetId, ...opts }); return { case: { id: calls.length }, count: 1, escalated: null }; },
    async timeout(sid, targetId, opts) { calls.push({ fn: 'timeout', targetId, ...opts }); return { id: calls.length }; },
    async addCase() { return { id: 1 }; },
    async log() {},
  };
}

test('a late burst of old chat replayed after sleep does not trip the flood filter', async () => {
  const h = await createHarness({ apps: ['automod'] });
  const stub = modStub();
  h.engine.services.set('mod', stub);
  const sent = [];
  for (let i = 0; i < 8; i++) sent.push(await h.message(`old message ${i}`, { lateBy: HOURS - i * 1000 }));
  assert.equal(stub.calls.filter((c) => c.fn === 'timeout').length, 0);
  assert.ok(sent.every((m) => !h.fake.state.messages[G].find((x) => x.id === m.id)?.deleted));
  for (let i = 0; i < 7; i++) await h.message(`fresh message ${i}`);
  assert.equal(stub.calls.filter((c) => c.fn === 'timeout').length, 1, 'fresh floods are still caught');
});

test('a late message with a banned word is still caught by the word filter', async () => {
  const h = await createHarness({ apps: ['automod'] });
  h.engine.services.set('mod', modStub());
  await h.slash('automod', 'words add badword', { user: IDS.admin });
  assert.ok(h.engine.settings.appConfig(S, 'automod').words.list.includes('badword'));
  const m = await h.message('this has badword in it', { lateBy: HOURS });
  assert.ok(h.fake.state.messages[G].find((x) => x.id === m.id)?.deleted);
});

test('events a few seconds old or slightly in the future are fresh', () => {
  const t = 5_000_000;
  const f = createFreshness({ bot: { commands: new Map(), prefixes: ['!'] }, now: () => t });
  for (const offset of [-119_000, -5_000, 0, 3_000, 60_000, 10 * 60_000]) {
    assert.equal(f.isLate({ type: 'interaction', created_at: new Date(t + offset).toISOString() }), false, `offset ${offset}`);
  }
});

test('fresh slash, click and typed command run normally with the filter installed', async () => {
  const h = await createHarness({ apps: ['mod'] });
  h.fake.state.roles[S].find((r) => r.id === IDS.roles.mod).perms.ban_members = true;
  await h.message(`!ban <@${IDS.member}> spam`, { user: IDS.mod, lateBy: 5_000 });
  assert.equal(h.fake.state.bans[S].length, 1);
  assert.equal(h.engine.freshness.lateEvents, 0);
});

test('migrating twice and after a crash halfway never loses data', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'levels.json'), JSON.stringify({ s1: { xp: 1 }, S2: { xp: 2 }, con: { xp: 3 } }));
  fs.mkdirSync(path.join(dir, 'levels.migrating'));
  fs.writeFileSync(path.join(dir, 'levels.migrating', 's1.json'), '{"xp":');
  const a = createJsonStore({ dir, log: quiet() });
  assert.deepEqual(a.get('levels', 's1'), { xp: 1 });
  assert.deepEqual(a.get('levels', 'S2'), { xp: 2 });
  assert.deepEqual(a.get('levels', 'con'), { xp: 3 });
  assert.ok(!fs.existsSync(path.join(dir, 'levels.migrating')));
  assert.ok(fs.existsSync(path.join(dir, 'levels.json.migrated')));
  const b = createJsonStore({ dir, log: quiet() });
  assert.deepEqual(b.entries('levels').sort(), [['S2', { xp: 2 }], ['con', { xp: 3 }], ['s1', { xp: 1 }]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keys that differ only by case or look like Windows device names get their own files', () => {
  const keys = ['abc', 'Abc', 'ABC', 'con', 'CON', 'nul.x', 'a.b', '.hidden', 'end.', 'x y', '%41', '^a', 'ünï', '😀', 'k'.repeat(300)];
  const names = keys.map(keyToFileName);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, keys.length);
  for (const n of names) assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n), n);
  keys.slice(0, -1).forEach((k, i) => assert.equal(fileNameToKey(names[i]), k));
  const dir = tempDir();
  const s = createJsonStore({ dir, log: quiet() });
  keys.forEach((k, i) => s.set('t', k, i));
  s.delete('t', 'Abc');
  assert.equal(s.flushSync() > 0, true);
  const r = createJsonStore({ dir, log: quiet() });
  for (const [i, k] of keys.entries()) assert.equal(r.get('t', k), k === 'Abc' ? undefined : i, k);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a damaged file comes back from the backup end to end', async () => {
  const dir = tempDir();
  const s = createJsonStore({ dir, log: quiet() });
  s.set('mod', S, { cases: 4 });
  await s.flush();
  const b = createBackups({ dir, store: s, log: quiet() });
  const out = await b.backupNow();
  assert.equal(out.ok, true);
  fs.writeFileSync(path.join(dir, 'mod', keyToFileName(S)), '');
  const log = quiet();
  const r = createJsonStore({ dir, log });
  assert.deepEqual(r.get('mod', S), { cases: 4 });
  assert.ok(log.lines.some((l) => /restored data\/mod/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an Undo hint that would pass 100 bytes stays off the button', async () => {
  const h = await createHarness({ apps: [] });
  const hint = `/unlock #${'📢・'.repeat(14)}`;
  assert.ok(`yo:sys:undo:abcdef:abcde:${hint}`.length <= 100);
  const u = h.engine.router.addUndo({ serverId: S, actorId: IDS.mod, label: 'lock', manual: hint, run: async () => {} });
  assert.ok(Buffer.byteLength(u.button.custom_id, 'utf8') <= 100);
  assert.ok(!u.button.custom_id.includes('unlock'));
});

test('an Undo on a Components V2 message with extra flags is marked through the layout', async () => {
  const h = await createHarness({ apps: [] });
  const u = h.engine.router.addUndo({ serverId: S, actorId: IDS.mod, label: 'thing', run: async () => {} });
  const msg = await h.bot.send(G, 'x', { components: [row(button('Keep', customId('sys', 'keep'), 'primary'))] });
  const layout = [{ type: 17, components: [{ type: 1, components: [{ type: 2, style: 2, label: 'Undo', custom_id: u.button.custom_id }] }] }];
  h.bot.message = async () => ({ id: msg.id, flags: 32768 | 4096, components: layout });
  const out = await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
  assert.equal(out[0].type, 'update');
  assert.ok(JSON.stringify(out[0]).includes('Undone by'));
  assert.equal(out[0].flags, 32768);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createMemoryStore, createJsonStore, keyToFileName, fileNameToKey } from '../../engine/storage.js';
import { createBackups } from '../../engine/backup.js';

const SERVER_A = '5e000000-0000-4000-8000-0000000000aa';
const SERVER_B = '5e000000-0000-4000-8000-0000000000bb';
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `yapos-${tag}-`));
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), 'utf8'));
const tmpFiles = (folder) => fs.readdirSync(folder, { recursive: true }).filter((f) => String(f).endsWith('.tmp'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function recorder() {
  const lines = [];
  const add = (lvl) => (...a) => lines.push(`${lvl} ${a.join(' ')}`);
  return { lines, debug: add('debug'), info: add('info'), warn: add('warn'), error: add('error') };
}

function runChild(dir, body) {
  const storageUrl = pathToFileURL(path.resolve('engine/storage.js')).href;
  const script = [
    'const { createJsonStore, flushOnExit } = await import(' + JSON.stringify(storageUrl) + ');',
    'const store = createJsonStore({ dir: ' + JSON.stringify(dir) + ', delay: 60000 });',
    'flushOnExit(store, null);',
    ...body,
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
}

test('memory store returns copies', () => {
  const s = createMemoryStore();
  const v = s.set('x', 'a', { list: [1] });
  v.list.push(2);
  assert.deepEqual(s.get('x', 'a'), { list: [1] });
  s.update('x', 'a', (d) => { d.list.push(3); });
  assert.deepEqual(s.get('x', 'a').list, [1, 3]);
  assert.deepEqual(s.get('x', 'missing', { n: 0 }), { n: 0 });
  assert.throws(() => s.get('Bad NS!', 'a'));
  assert.throws(() => s.get('backups', 'a'), /kept for YapOS/);
});

test('each server gets its own file, written atomically, and reloads', async () => {
  const dir = tempDir('perkey');
  const a = createJsonStore({ dir, delay: 5 });
  a.set('mod', SERVER_A, { cases: [1, 2] });
  a.set('mod', SERVER_B, { cases: [3] });
  await a.flush();
  assert.deepEqual(readJson(dir, 'mod', `${SERVER_A}.json`), { cases: [1, 2] });
  assert.deepEqual(readJson(dir, 'mod', `${SERVER_B}.json`), { cases: [3] });
  assert.equal(fs.existsSync(path.join(dir, 'mod.json')), false);
  assert.deepEqual(tmpFiles(dir), []);
  a.delete('mod', SERVER_B);
  await a.flush();
  assert.equal(fs.existsSync(path.join(dir, 'mod', `${SERVER_B}.json`)), false, 'deleting a key removes its file');
  const b = createJsonStore({ dir });
  assert.deepEqual(b.get('mod', SERVER_A), { cases: [1, 2] });
  assert.equal(b.has('mod', SERVER_B), false);
});

test('keys and entries list everything on disk after a restart', async () => {
  const dir = tempDir('keys');
  const a = createJsonStore({ dir, delay: 5 });
  for (let i = 0; i < 12; i++) a.set('levels', `server-${i}`, { xp: i });
  await a.flush();
  const b = createJsonStore({ dir });
  assert.deepEqual(b.keys('levels').sort(), Array.from({ length: 12 }, (_, i) => `server-${i}`).sort());
  const entries = Object.fromEntries(b.entries('levels'));
  assert.equal(entries['server-7'].xp, 7);
  assert.deepEqual(b.keys('nothing-here'), []);
});

test('awkward keys round-trip to safe file names', async () => {
  const keys = ['', '.', '..', '.hidden', 'end.', 'a/b\\c', 'CON', 'con', 'nul.txt', 'com1', 'LPT9', 'Abc', 'abc', 'a:b*c?d"e<f>g|h', 'spaces here ', 'emoji 🎉', '__proto__', 'constructor', '100%', '^caret', '~tilde', 'x'.repeat(400), 'lone \uD800 half', 'tab\there'];
  const names = keys.map(keyToFileName);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, keys.length, 'no two keys share a file, even on a case-blind disk');
  for (const n of names) {
    assert.match(n, /\.json$/);
    assert.doesNotMatch(n, /[<>:"/\\|?*\x00-\x1f]/);
    assert.notEqual(n[0], '.');
    assert.ok(n.length <= 200);
    assert.doesNotMatch(n.split('.')[0], /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i);
  }
  for (const [i, k] of keys.entries()) {
    const back = fileNameToKey(names[i]);
    if (back !== null) assert.equal(back, k);
  }
  assert.equal(keyToFileName(SERVER_A), `${SERVER_A}.json`, 'server ids keep readable names');

  const dir = tempDir('unsafe');
  const a = createJsonStore({ dir, delay: 5 });
  keys.forEach((k, i) => a.set('notes', k, { i }));
  await a.flush();
  const b = createJsonStore({ dir });
  assert.deepEqual(b.keys('notes').sort(), [...keys].sort());
  keys.forEach((k, i) => assert.deepEqual(b.get('notes', k), { i }, `key ${JSON.stringify(k)}`));
});

test('an old single file is split per server and kept as .migrated', () => {
  const dir = tempDir('migrate');
  const old = { [SERVER_A]: { xp: 10 }, [SERVER_B]: { xp: 20 }, 'Weird/Key': { xp: 30 } };
  fs.writeFileSync(path.join(dir, 'levels.json'), JSON.stringify(old));
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ [SERVER_A]: { cases: 2 } }));
  const log = recorder();
  const store = createJsonStore({ dir, log });
  assert.equal(store.get('levels', SERVER_B).xp, 20);
  assert.deepEqual(store.keys('levels').sort(), Object.keys(old).sort());
  assert.ok(fs.existsSync(path.join(dir, 'levels.json.migrated')), 'the old file is kept');
  assert.equal(fs.existsSync(path.join(dir, 'levels.json')), false);
  assert.deepEqual(readJson(dir, 'levels', `${SERVER_A}.json`), { xp: 10 });
  assert.deepEqual(readJson(dir, 'levels.json.migrated'), old);
  assert.ok(fs.existsSync(path.join(dir, 'mod.json')), 'namespaces are only moved when first used');
  assert.ok(log.lines.some((l) => /one file per server/.test(l)));
  const again = createJsonStore({ dir });
  assert.equal(again.get('levels', 'Weird/Key').xp, 30);
});

test('an unfinished save from the old single-file layout is recovered and migrated', () => {
  const dir = tempDir('oldtmp');
  fs.writeFileSync(path.join(dir, 'roles.json.99999.tmp'), JSON.stringify({ srv: { menus: 3 } }));
  fs.writeFileSync(path.join(dir, 'roles.json.88888.tmp'), '{"srv": {"men');
  const store = createJsonStore({ dir });
  assert.equal(store.get('roles', 'srv').menus, 3);
  assert.ok(fs.existsSync(path.join(dir, 'roles', 'srv.json')));
  assert.deepEqual(tmpFiles(dir), []);
});

test('a save cut off halfway is recovered per server on the next start', () => {
  const dir = tempDir('tmp');
  fs.mkdirSync(path.join(dir, 'roles'));
  fs.writeFileSync(path.join(dir, 'roles', `${SERVER_A}.json.99999.tmp`), JSON.stringify({ menus: 3 }));
  fs.writeFileSync(path.join(dir, 'roles', `${SERVER_A}.json.88888.tmp`), '{"men');
  fs.writeFileSync(path.join(dir, 'roles', `${SERVER_B}.json`), JSON.stringify({ menus: 1 }));
  fs.writeFileSync(path.join(dir, 'roles', `${SERVER_B}.json.77777.final.tmp`), JSON.stringify({ menus: 99 }));
  const store = createJsonStore({ dir });
  assert.equal(store.get('roles', SERVER_A).menus, 3, 'a save from an earlier run is recovered');
  assert.equal(store.get('roles', SERVER_B).menus, 1, 'a finished file wins over a leftover');
  assert.ok(fs.existsSync(path.join(dir, 'roles', `${SERVER_A}.json`)));
  assert.deepEqual(tmpFiles(dir), [], 'leftovers are cleaned up');
});

test('an unreadable file with no backup is moved aside and starts fresh', () => {
  const dir = tempDir('broken');
  fs.mkdirSync(path.join(dir, 'broken'));
  fs.writeFileSync(path.join(dir, 'broken', 'k.json'), '{nope');
  fs.writeFileSync(path.join(dir, 'broken', 'fine.json'), '{"ok":true}');
  const c = createJsonStore({ dir });
  assert.deepEqual(c.get('broken', 'k', 'fresh'), 'fresh');
  assert.deepEqual(c.get('broken', 'fine'), { ok: true }, 'one damaged server never costs the others');
  assert.ok(fs.readdirSync(path.join(dir, 'broken')).some((f) => f.startsWith('k.json.broken-')));
});

test('an unreadable file is restored from the newest good backup', async () => {
  const dir = tempDir('restore');
  const first = createJsonStore({ dir, delay: 5 });
  first.set('levels', SERVER_A, { xp: 100 });
  first.set('levels', SERVER_B, { xp: 5 });
  await first.flush();
  let day = new Date(2026, 10, 2, 12);
  const backups = createBackups({ dir, store: first, now: () => day });
  assert.equal((await backups.backupNow()).ok, true);
  first.set('levels', SERVER_A, { xp: 250 });
  day = new Date(2026, 10, 3, 12);
  assert.equal((await backups.backupNow()).ok, true);
  fs.writeFileSync(path.join(dir, 'backups', 'daily', '2026-11-03', 'levels', `${SERVER_A}.json`), '{damaged');

  fs.writeFileSync(path.join(dir, 'levels', `${SERVER_A}.json`), '{"xp": 9');
  const log = recorder();
  const store = createJsonStore({ dir, log });
  assert.equal(store.get('levels', SERVER_A).xp, 100, 'skips a damaged backup and uses the next good one');
  assert.equal(store.get('levels', SERVER_B).xp, 5);
  assert.ok(log.lines.some((l) => l.includes(`restored data/levels/${SERVER_A}.json from the backup of 2026-11-02`)), log.lines.join('\n'));
  assert.deepEqual(readJson(dir, 'levels', `${SERVER_A}.json`), { xp: 100 }, 'the restored copy is written back');
  assert.ok(fs.readdirSync(path.join(dir, 'levels')).some((f) => f.startsWith(`${SERVER_A}.json.broken-`)), 'the damaged file is kept aside');
});

test('a change made right before the bot exits is still saved', () => {
  const dir = tempDir('exit');
  const run = runChild(dir, ["store.set('settings', 'srv', { welcome: 'saved before exit' });", 'process.exit(0);']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readJson(dir, 'settings', 'srv.json').welcome, 'saved before exit');
  assert.deepEqual(tmpFiles(dir), []);
});

test('a crash still saves what was changed', () => {
  const dir = tempDir('crash');
  const run = runChild(dir, ["store.set('levels', 'srv', { xp: 1234 });", "store.set('levels', 'other', { xp: 1 });", "setTimeout(() => { throw new Error('boom'); }, 5);"]);
  assert.notEqual(run.status, 0);
  assert.equal(readJson(dir, 'levels', 'srv.json').xp, 1234);
  assert.equal(readJson(dir, 'levels', 'other.json').xp, 1);
});

test('many quick changes are saved in order and the newest wins', async () => {
  const dir = tempDir('order');
  const store = createJsonStore({ dir, delay: 1 });
  for (let i = 1; i <= 200; i++) {
    store.set('levels', 'srv', { xp: i });
    if (i % 7 === 0) await wait(1);
  }
  await store.flush();
  assert.equal(readJson(dir, 'levels', 'srv.json').xp, 200);
  assert.equal(store.pending(), 0);
  const again = createJsonStore({ dir });
  assert.equal(again.get('levels', 'srv').xp, 200);
});

test('a final save on exit is not undone by a slower save still on its way', async () => {
  const dir = tempDir('race');
  const store = createJsonStore({ dir, delay: 1 });
  store.set('levels', 'srv', { xp: 1 });
  await wait(5);
  store.set('levels', 'srv', { xp: 2 });
  const slow = store.flush();
  store.set('levels', 'srv', { xp: 3 });
  store.flushSync();
  await slow;
  assert.equal(readJson(dir, 'levels', 'srv.json').xp, 3);
});

test('changes are grouped and reach the disk within a moment', async () => {
  const dir = tempDir('fast');
  const store = createJsonStore({ dir });
  store.set('mod', 'srv', { cases: 1 });
  store.set('mod', 'srv', { cases: 2 });
  store.set('mod', 'other', { cases: 5 });
  assert.equal(fs.existsSync(path.join(dir, 'mod', 'srv.json')), false, 'nothing is written straight away');
  await wait(700);
  assert.equal(readJson(dir, 'mod', 'srv.json').cases, 2);
  assert.equal(readJson(dir, 'mod', 'other.json').cases, 5);
  assert.equal(store.pending(), 0);
});

test('backups copy every app folder and write a manifest', async () => {
  const dir = tempDir('backup');
  const store = createJsonStore({ dir, delay: 60000 });
  store.set('levels', SERVER_A, { xp: 1 });
  store.set('levels', SERVER_B, { xp: 2 });
  store.set('mod', SERVER_A, { cases: 3 });
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs', 'yapos.log'), 'hello');
  fs.writeFileSync(path.join(dir, 'tickets.json'), JSON.stringify({ [SERVER_A]: { open: 1 } }));
  const log = recorder();
  const backups = createBackups({ dir, store, log, now: () => new Date(2026, 10, 11, 9) });
  const result = await backups.backupNow();
  assert.equal(result.ok, true);
  const day = path.join(dir, 'backups', 'daily', '2026-11-11');
  assert.deepEqual(readJson(day, 'levels', `${SERVER_B}.json`), { xp: 2 }, 'unsaved changes are saved first');
  assert.deepEqual(readJson(day, 'mod', `${SERVER_A}.json`), { cases: 3 });
  assert.ok(fs.existsSync(path.join(day, 'tickets.json')), 'apps still in the old layout are copied too');
  assert.equal(fs.existsSync(path.join(day, 'logs')), false);
  assert.equal(fs.existsSync(path.join(day, 'backups')), false);
  const manifest = readJson(day, 'manifest.json');
  assert.deepEqual(manifest.namespaces, { levels: 2, mod: 1 });
  assert.equal(manifest.files, 4);
  assert.ok(fs.existsSync(path.join(dir, 'backups', 'weekly', '2026-11-11')), 'the first backup also starts the weekly set');
  assert.ok(log.lines.some((l) => /backed up 4 files/.test(l)), log.lines.join('\n'));
});

test('backups keep the newest 7 daily and 4 weekly copies', async () => {
  const dir = tempDir('rotate');
  const store = createJsonStore({ dir, delay: 60000 });
  let day = new Date(2026, 9, 1, 12);
  const backups = createBackups({ dir, store, now: () => day });
  const weeklyMade = [];
  for (let i = 0; i < 40; i++) {
    store.set('levels', 'srv', { day: i });
    const r = await backups.backupNow();
    assert.equal(r.ok, true);
    if (r.weekly) weeklyMade.push(r.date);
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 12);
  }
  const { daily, weekly } = backups.list();
  assert.equal(daily.length, 7);
  assert.equal(daily[0], '2026-11-09');
  assert.equal(daily[6], '2026-11-03');
  assert.equal(weekly.length, 4);
  assert.ok(weekly.every((d) => new Date(`${d}T12:00:00`).getDay() === 0), `weekly copies are Sundays: ${weekly}`);
  assert.equal(weekly[0], '2026-11-08');
  assert.equal(weeklyMade[0], '2026-10-01', 'the very first backup starts the weekly set');
  assert.equal(readJson(dir, 'backups', 'daily', '2026-11-09', 'levels', 'srv.json').day, 39);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups', 'daily')).filter((f) => f.startsWith('.')), []);
});

test('a weekly copy is made when the newest one is over a week old, even midweek', async () => {
  const dir = tempDir('weekly');
  let day = new Date(2026, 10, 4, 12);
  const backups = createBackups({ dir, now: () => day });
  assert.equal((await backups.backupNow()).weekly, true);
  day = new Date(2026, 10, 5, 12);
  assert.equal((await backups.backupNow()).weekly, false);
  day = new Date(2026, 10, 11, 12);
  assert.equal((await backups.backupNow()).weekly, true);
});

test('start runs a backup only when today has none, and never throws', async () => {
  const dir = tempDir('start');
  let day = new Date(2026, 10, 11, 8);
  const backups = createBackups({ dir, now: () => day, checkEveryMs: 60_000 });
  backups.start();
  await backups.check();
  await wait(20);
  assert.deepEqual(backups.list().daily, ['2026-11-11']);
  const stamp = fs.statSync(path.join(dir, 'backups', 'daily', '2026-11-11', 'manifest.json')).mtimeMs;
  assert.equal(await backups.check(), null, 'no second backup on the same day');
  assert.equal(fs.statSync(path.join(dir, 'backups', 'daily', '2026-11-11', 'manifest.json')).mtimeMs, stamp);
  day = new Date(2026, 10, 12, 8);
  await backups.check();
  assert.deepEqual(backups.list().daily, ['2026-11-12', '2026-11-11']);
  backups.stop();
});

test('a backup that fails is logged and never crashes the bot', async () => {
  const dir = tempDir('fail');
  const log = recorder();
  const failingStore = { flush: async () => { throw new Error('disk is full'); } };
  const backups = createBackups({ dir, store: failingStore, log });
  const r = await backups.backupNow();
  assert.equal(r.ok, false);
  assert.ok(log.lines.some((l) => /backup didn't finish/.test(l)));

  const missing = path.join(dir, 'not-a-folder.txt');
  fs.writeFileSync(missing, 'just a file');
  const r2 = await createBackups({ dir: missing, log }).backupNow();
  assert.equal(r2.ok, false);

  const angryLog = { info: () => { throw new Error('log broke'); }, error: () => { throw new Error('log broke'); } };
  const r3 = await createBackups({ dir, log: angryLog }).backupNow();
  assert.equal(r3.ok, false);
  assert.doesNotThrow(() => createBackups({ dir: missing, log: angryLog }).start().stop());
});

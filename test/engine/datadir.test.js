import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickDataDir, probeStorage, describeProbe } from '../../engine/datadir.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yapos-datadir-'));

test('datadir: a data folder that cannot be written falls back to data next to the code', () => {
  const root = tmp();
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const out = pickDataDir({ dataPath: path.join(blocker, 'inside') }, root);
  assert.equal(out.fellBack, true);
  assert.equal(out.path, path.join(root, 'data'));
  assert.ok(out.error);
  fs.rmSync(root, { recursive: true, force: true });
});

test('datadir: a writable data folder is kept', () => {
  const root = tmp();
  const wanted = path.join(root, 'elsewhere');
  const out = pickDataDir({ dataPath: wanted }, root);
  assert.deepEqual(out, { path: wanted, fellBack: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('datadir: the storage check counts starts and shows which folders kept their marker', () => {
  const root = tmp();
  const a = path.join(root, 'a');
  fs.mkdirSync(a);
  const missing = path.join(root, 'nope');
  const first = probeStorage(root, { now: 1000, candidates: [a, missing] });
  assert.deepEqual(first.map((r) => r.state), ['writable', 'missing']);
  assert.equal(first[0].kept, false);
  const second = probeStorage(root, { now: 61_000 + 1000, candidates: [a, missing] });
  assert.equal(second[0].starts, 2);
  assert.equal(second[0].kept, true);
  const line = describeProbe(second, 61_000 + 1000);
  assert.match(line, /storage check: .*a \(writable, start 2, first seen 1 min ago\)/);
  assert.ok(!line.includes('nope'));
  fs.rmSync(root, { recursive: true, force: true });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

const REX = 'de7e0000-0000-4000-8000-000000000003';

test('the test call owner wrapper keeps temp ban end times', async () => {
  const { withDevPartyOwner, DEV_PARTY_OWNER } = await import('../dev.mjs');
  const url = new URL(`http://localhost/api/activity/admins?ids=${DEV_PARTY_OWNER},${REX}`);
  const res = new Response(JSON.stringify({ admins: [], owner: null, banned: [REX, DEV_PARTY_OWNER], until: { [REX]: 5000, [DEV_PARTY_OWNER]: 6000 }, now: 1000 }), { status: 200 });
  const body = await (await withDevPartyOwner(res, url)).json();
  assert.equal(body.owner, DEV_PARTY_OWNER);
  assert.deepEqual(body.banned, [REX]);
  assert.deepEqual(body.until, { [REX]: 5000 });
  assert.equal(body.now, 1000);
});

test('the test call owner wrapper leaves out until when nobody has a timed ban', async () => {
  const { withDevPartyOwner, DEV_PARTY_OWNER } = await import('../dev.mjs');
  const url = new URL(`http://localhost/api/activity/admins?ids=${DEV_PARTY_OWNER},${REX}`);
  const res = new Response(JSON.stringify({ admins: [], owner: null, banned: [REX] }), { status: 200 });
  const body = await (await withDevPartyOwner(res, url)).json();
  assert.deepEqual(body.banned, [REX]);
  assert.equal('until' in body, false);
  assert.equal('now' in body, false);
});

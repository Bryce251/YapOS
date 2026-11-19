import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';

const S = IDS.server;
const NEWS = IDS.channels.news;

test('a button on a private schedule list edits that same private reply in place', async () => {
  const h = await createHarness({ apps: ['tools'], fakeClock: true, features: { ephemeralButtons: true } });
  await h.slash('schedule', `<#${NEWS}> every monday 9:00 Meeting`, { user: IDS.admin });
  const list = await h.slash('schedule', 'list', { user: IDS.admin });
  const shown = list[list.length - 1];
  assert.equal(shown.type, 'ephemeral');
  assert.ok(shown.replyId, 'the list came back as a private reply with buttons');
  const before = h.sent(IDS.channels.general).length;
  const out = await h.clickButton('Pause', { user: IDS.admin, in: list });
  assert.equal(out[out.length - 1].type, 'update', 'the click edited the private reply');
  assert.equal(h.sent(IDS.channels.general).length, before, 'nothing new was posted');
  assert.equal(Object.values(h.engine.store.get('tools', S, {}).posts)[0].paused, true);
});

test('the automod panel on a private reply updates in place and stays panel based without ephemeral buttons', async () => {
  for (const on of [true, false]) {
    const h = await createHarness({ apps: ['automod'], features: { ephemeralButtons: on, selects: false } });
    const first = await h.slash('automod', '', { user: IDS.admin });
    const head = first[first.length - 1];
    assert.equal(head.type, on ? 'ephemeral' : 'reply');
    const btn = h.allButtons(first).find((b) => /:toggle:/.test(b.custom_id));
    assert.ok(btn, 'the panel has filter toggles');
    const out = await h.click(btn.custom_id, { user: IDS.admin, messageId: btn.replyId ? null : btn.messageId, replyId: btn.replyId ?? null });
    assert.equal(out[out.length - 1].type, 'update');
  }
});

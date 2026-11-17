import assert from 'node:assert/strict';
import { reasonOpen } from '../web/activity/js/ui/report.js';

const tick = () => new Promise((res) => setImmediate(res));

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    if (c.localName) out.push(c);
    walk(c, out);
  }
  return out;
}

export function reasonKey(key) {
  const layer = reasonOpen();
  return layer ? walk(layer).find((el) => el.dataset && el.dataset.key === key) || null : null;
}

export async function pickIn(reason, note = null) {
  await tick();
  assert.ok(reasonOpen(), 'the reason picker is open');
  reasonKey(`reason-${reason}`).click();
  if (reason === 'other') {
    if (note !== null) reasonKey('reason-note').value = note;
    reasonKey('reason-send').click();
  }
  await tick();
  await tick();
}

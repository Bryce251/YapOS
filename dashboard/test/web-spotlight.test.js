import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-shim.js';

installDom();
const { h } = await import('../web/js/dom.js');
const { spotlight, spotlitChain } = await import('../web/js/spotlight.js');

function move(target, extra = {}) {
  target.dispatchEvent({ type: 'pointermove', bubbles: true, clientX: 40, clientY: 25, pointerType: 'mouse', ...extra });
}

function page() {
  const label = h('span', { text: 'Mia' });
  const row = h('button', { class: 'member-row' }, label);
  const card = h('section', { class: 'card' }, row);
  const plain = h('p', { text: 'Hello' });
  const root = h('div', {}, card, plain);
  document.body.append(root);
  return { root, card, row, label, plain };
}

test('the spotlight follows the pointer on the hovered row and the card around it', () => {
  const { root, card, row, label } = page();
  const queue = [];
  spotlight(root, { schedule: (fn) => queue.push(fn) });
  assert.deepEqual(spotlitChain(label, root), [row, card]);
  move(label);
  move(label, { clientX: 60 });
  assert.equal(queue.length, 1);
  queue.shift()();
  assert.equal(row.style.props['--spotlight-x'], '60px');
  assert.equal(row.style.props['--spotlight-y'], '25px');
  assert.equal(card.style.props['--spotlight-x'], '60px');
});

test('touch and plain areas leave the spotlight alone, and a root is only wired once', () => {
  const { root, row, label, plain } = page();
  const queue = [];
  spotlight(root, { schedule: (fn) => queue.push(fn) });
  spotlight(root, { schedule: (fn) => queue.push(fn) });
  move(label, { pointerType: 'touch' });
  move(plain);
  assert.equal(queue.length, 0);
  move(label);
  assert.equal(queue.length, 1);
  queue.shift()();
  assert.equal(row.style.props['--spotlight-x'], '40px');
});

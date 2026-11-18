import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, type, fire } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/party/reports' });
document.documentElement = document.createElement('html');
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const blocked = await import('../web/js/pages/party-blocked.js');

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

const buttons = (root) => walk(root).filter((n) => n.localName === 'button');
const byLabel = (root, text) => buttons(root).find((b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text);
const SK = 'sk[i1]b+[i1]d[i1]';

function ctxOf(api) {
  const ctrl = new AbortController();
  return { api, signal: ctrl.signal, stop: () => ctrl.abort() };
}

function data(canEdit, patterns = [{ id: 'p1', pattern: SK, added_name: 'Jolli', created: Date.now() - 60000 }]) {
  return { words: [{ id: 'w1', word: 'banana', added_name: 'Alex', created: Date.now() }], count: 1, max: 500, chars: 40, patterns, pattern_max: 50, pattern_chars: 120, can_patterns: canEdit };
}

test('pattern helpers read odd data and preview what a pattern hides', () => {
  assert.deepEqual(blocked.readPatterns(null), { patterns: [], max: 50, chars: 120, canEdit: false });
  const v = blocked.readPatterns({ patterns: [null, { id: 1 }, { id: 'x', pattern: 'a+b' }], can_patterns: 'yes' });
  assert.equal(v.patterns.length, 1);
  assert.equal(v.patterns[0].by, 'Owner');
  assert.equal(v.canEdit, false);
  const p = blocked.patternPreview(SK, 'hey SKIBIDI and sk1bidi');
  assert.equal(p.problem, null);
  assert.deepEqual(p.spans.map((s) => s.text), ['SKIBIDI', 'sk1bidi']);
  assert.deepEqual(blocked.highlightParts('hey SKIBIDI.', blocked.patternPreview(SK, 'hey SKIBIDI.').spans), [{ text: 'hey ', hit: false }, { text: 'SKIBIDI', hit: true }, { text: '.', hit: false }]);
  assert.equal(blocked.patternPreview('(a+)+', 'aaaa').problem.code, 'nested');
  assert.deepEqual(blocked.patternPreview('(', 'aaaa').spans, []);
  assert.equal(blocked.patternPreview('hell', 'hello').problem.code, 'too_broad');
  assert.deepEqual(blocked.patternPreview('hell', 'hello').spans.map((s) => s.text), ['hell']);
  assert.equal(blocked.patternPreview('', 'x').ready, false);
});

test('party admins see patterns labelled read-only with no toggle or buttons', async () => {
  const ctx = ctxOf({ get: async () => data(false) });
  const card = blocked.blockedWordsCard(ctx);
  document.body.replaceChildren(card);
  await flush();
  assert.match(card.textContent, /Patterns \(1 of 50\)/);
  assert.match(card.textContent, /sk\[i1\]b\+\[i1\]d\[i1\]/);
  assert.match(card.textContent, /Owner only/);
  assert.match(card.textContent, /Only the owner of YapOS Party can change patterns/);
  assert.equal(byLabel(card, 'Pattern'), undefined);
  assert.equal(byLabel(card, 'Edit'), undefined);
  const bar = walk(card).find((n) => n.className && String(n.className).includes('blocked-mode'));
  assert.equal(bar.hidden, true);
  ctx.stop();
});

test('the owner switches to Pattern, tries text live, saves, edits and removes', async () => {
  const calls = [];
  let current = data(true, []);
  const ctx = ctxOf({
    get: async () => current,
    post: async (path, body) => {
      calls.push(['POST', path, body]);
      current = data(true, [{ id: 'p9', pattern: body.pattern, added_name: 'Jolli', created: Date.now() }]);
      return current;
    },
    patch: async (path, body) => {
      calls.push(['PATCH', path, body]);
      current = data(true, [{ id: 'p9', pattern: body.pattern, added_name: 'Jolli', created: Date.now() }]);
      return current;
    },
    request: async (method, path) => {
      calls.push([method, path]);
      current = data(true, []);
      return current;
    },
  });
  const card = blocked.blockedWordsCard(ctx);
  document.body.replaceChildren(card);
  await flush();
  assert.match(card.textContent, /No patterns yet/);
  byLabel(card, 'Pattern').click();
  const inputs = walk(card).filter((n) => n.localName === 'input' && n.type === 'text');
  const [, patternInput, tryInput] = inputs;
  const form = walk(card).find((n) => n.localName === 'form');
  type(patternInput, '\\w+');
  type(tryInput, 'hello skibidi');
  assert.match(card.textContent, /would also hide "hello"/);
  fire(form, 'submit');
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(card.textContent.split('would also hide "hello"').length, 2);
  type(patternInput, SK);
  const marks = walk(card).filter((n) => n.localName === 'mark');
  assert.deepEqual(marks.map((m) => m.textContent), ['skibidi']);
  assert.match(card.textContent, /Would hide “skibidi”/);
  fire(form, 'submit');
  await flush();
  assert.deepEqual(calls[0], ['POST', blocked.PATTERNS_PATH, { pattern: SK }]);
  assert.match(card.textContent, /Patterns \(1 of 50\)/);
  assert.equal(patternInput.value, '');
  byLabel(card, 'Edit').click();
  assert.equal(patternInput.value, SK);
  type(patternInput, 'zz[o0]+t');
  fire(form, 'submit');
  await flush();
  assert.deepEqual(calls[1], ['PATCH', `${blocked.PATTERNS_PATH}/p9`, { pattern: 'zz[o0]+t' }]);
  assert.match(card.textContent, /zz\[o0\]\+t/);
  ctx.stop();
});

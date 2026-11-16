import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, type, FakeEvent } from './dom-shim.js';

const { document, window } = installDom({ url: 'https://dash.example.test/link?code=k7qm2xpa' });
document.documentElement = document.createElement('html');
const { matchRoute } = await import('../web/js/router.js');
const { ApiError } = await import('../web/js/api.js');
const { renderLink, cleanCode, formatCode, APPROVE_API, PARTY_SIGNINS_API, partySigninsCard, signinsText } = await import('../web/js/pages/link.js');
const { state } = await import('../web/js/state.js');

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

function mount(api) {
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  const chrome = [];
  const ctx = { api, main, signal: ctrl.signal, params: {}, setChrome: (c) => chrome.push(c), setLeaveGuard: () => {}, abort: () => ctrl.abort() };
  renderLink(ctx);
  return { ctx, main, chrome };
}

function submit(main) {
  const form = main.querySelector('form');
  form.dispatchEvent(new FakeEvent('submit', { bubbles: true }));
}

test('/link is a private dashboard page', () => {
  const r = matchRoute('/link');
  assert.equal(r.name, 'link');
  assert.equal(r.private, true);
});

test('codes are cleaned and formatted like the Party shows them', () => {
  assert.equal(cleanCode(' k7qm-2xpa '), 'K7QM2XPA');
  assert.equal(cleanCode('ABCD-EFGO'), 'ABCDEFG0');
  assert.equal(formatCode('k7qm2xpa'), 'K7QM-2XPA');
  assert.equal(formatCode('k7q'), 'K7Q');
  assert.equal(formatCode('K7QM2XPAZZZZ'), 'K7QM-2XPA');
});

test('a signed-in user approves a code and sees a friendly done state', async () => {
  state.user = { id: 'u1', username: 'bea', display_name: 'Bea' };
  const posts = [];
  const { main, chrome } = mount({ post: async (path, body) => { posts.push([path, body]); return { ok: true, user: { id: 'u1', username: 'bea', display_name: 'Bea' } }; } });
  assert.equal(chrome[0].section, 'account');
  assert.match(main.textContent, /Sign in to YapOS Party as Bea\?/);
  assert.match(main.textContent, /@bea/);
  const input = main.querySelector('input');
  assert.equal(input.value, '', 'a code in the address is never filled in, so a sent link cannot sign someone in with one click');
  assert.match(main.textContent, /Never use a code someone sent you/);
  assert.equal(document.activeElement, input);
  assert.equal(main.querySelector('label').htmlFor, 'link-code');
  type(input, 'k7qm2xpa');
  submit(main);
  await flush();
  assert.deepEqual(posts, [[APPROVE_API, { code: 'K7QM-2XPA', confirm: false }]]);
  assert.match(main.textContent, /You're signed in, Bea!/);
  assert.match(main.textContent, /Head back to the call/);
});

test('typing formats the code, short codes are caught before sending and server errors are shown in plain words', async () => {
  state.user = { id: 'u1', username: 'bea', display_name: 'Bea' };
  window.location.search = '';
  let calls = 0;
  const { main } = mount({ post: async () => { calls += 1; throw new ApiError("That code didn't work. Check it and try again.", { status: 404, data: { error: 'bad_code', message: "That code didn't work. Check it and try again." } }); } });
  const input = main.querySelector('input');
  type(input, 'abcd');
  submit(main);
  await flush();
  assert.equal(calls, 0);
  assert.match(main.textContent, /Type all 8 letters and numbers/);
  const again = main.querySelector('input');
  assert.equal(again.getAttribute('aria-invalid'), 'true');
  type(again, 'zzzzzzzz');
  assert.equal(again.value, 'ZZZZ-ZZZZ');
  submit(main);
  await flush();
  assert.equal(calls, 1);
  assert.match(main.textContent, /That code didn't work/);
  const alert = walk(main).find((n) => n.getAttribute && n.getAttribute('role') === 'alert' && !n.hidden);
  assert.ok(alert);
});

test('a code from a different Yapin account asks before signing in anyway', async () => {
  state.user = { id: 'u1', username: 'bea', display_name: 'Bea' };
  const posts = [];
  const { main } = mount({
    post: async (path, body) => {
      posts.push(body);
      if (!body.confirm) throw new ApiError("This code came from a call where you're using a different Yapin' account.", { status: 409, data: { error: 'other_account' } });
      return { ok: true, user: state.user };
    },
  });
  const input = main.querySelector('input');
  type(input, 'K7QM2XPA');
  submit(main);
  await flush();
  assert.match(main.textContent, /Different Yapin' account/);
  const yes = main.querySelectorAll('button').find((b) => /Sign in anyway/.test(b.textContent));
  yes.click();
  await flush();
  assert.deepEqual(posts.map((p) => p.confirm), [false, true]);
  assert.match(main.textContent, /You're signed in/);
});

test('the account page card counts Party sign-ins and can end them all', async () => {
  const calls = [];
  const api = {
    get: async (path) => { calls.push(['GET', path]); return { count: 2 }; },
    request: async (method, path) => { calls.push([method, path]); return { ok: true, ended: 2 }; },
  };
  const ctrl = new AbortController();
  const el = partySigninsCard({ api, signal: ctrl.signal });
  document.body.replaceChildren(el);
  await flush();
  assert.match(el.textContent, /in 2 places/);
  const end = el.querySelectorAll('button').find((b) => /Sign out of YapOS Party everywhere/.test(b.textContent));
  assert.equal(end.hidden, false);
  end.click();
  await flush();
  assert.deepEqual(calls, [['GET', PARTY_SIGNINS_API], ['DELETE', PARTY_SIGNINS_API]]);
  assert.match(el.textContent, /not signed in to YapOS Party/);
  assert.equal(end.hidden, true);
  assert.match(signinsText(1), /in 1 place\./);
});

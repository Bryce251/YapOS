import { h, replace } from '../dom.js';
import { avatar, button, card, linkButton, pageHeader, setBusy, toast } from '../ui.js';
import { icon, logoMark } from '../icons.js';
import { ApiError } from '../api.js';
import { state } from '../state.js';

export const APPROVE_API = '/api/link/approve';
export const PARTY_SIGNINS_API = '/api/me/party-signins';
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function cleanCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  let out = '';
  for (const c of s) if (CODE_ALPHABET.includes(c)) out += c;
  return out.slice(0, 8);
}

export function formatCode(raw) {
  const s = cleanCode(raw);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export function renderLink(ctx) {
  const { api, main } = ctx;
  ctx.setChrome({ variant: 'plain', section: 'account', crumbs: [{ label: 'Servers', href: '/servers' }, { label: 'Link YapOS Party' }] });
  const user = state.user || {};
  const name = user.display_name || user.username || 'you';
  const body = h('div', { class: 'link-body' });

  main.replaceChildren(h('div', { class: 'page page-narrow link-page' },
    pageHeader({
      eyebrow: 'YapOS Party',
      title: 'Sign in to YapOS Party',
      description: 'Type the code that YapOS Party shows in your call. Your wins, Party XP and Shards then count for your account.',
    }),
    h('section', { class: 'card link-card' }, h('div', { class: 'card-body' }, body))));

  function hero() {
    return h('div', { class: 'link-hero', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'link-mark' }, logoMark({ size: 48, label: '' })),
      h('span', { class: 'link-join' }, icon('link', { size: 16 })),
      avatar({ name, url: user.avatar_url, id: user.id, size: 'lg' }));
  }

  function drawForm(initial = '', problem = null) {
    const input = h('input', {
      id: 'link-code',
      class: 'input link-code-input',
      type: 'text',
      value: formatCode(initial),
      placeholder: 'XXXX-XXXX',
      autocomplete: 'one-time-code',
      spellcheck: false,
      maxLength: 12,
      attrs: { autocapitalize: 'characters', 'aria-describedby': 'link-code-help link-code-error', 'aria-invalid': problem ? 'true' : null },
    });
    const error = h('p', { class: 'field-error link-error', id: 'link-code-error', attrs: { role: 'alert' }, text: problem || '' });
    error.hidden = !problem;
    const submit = button({ label: 'Sign in to YapOS Party', icon: 'check', variant: 'primary', type: 'submit', className: 'link-submit' });
    const form = h('form', { class: 'link-form', attrs: { novalidate: true } },
      h('label', { class: 'field-label link-label', htmlFor: 'link-code', text: 'Code from YapOS Party' }),
      input,
      error,
      h('p', { class: 'field-help', id: 'link-code-help', text: 'It has 8 letters and numbers. Only use a code that you see in your own call. Never use a code someone sent you.' }),
      h('div', { class: 'link-actions' }, submit, linkButton({ label: 'Cancel', href: '/servers', variant: 'ghost' })));

    input.addEventListener('input', () => {
      const next = formatCode(input.value);
      if (next !== input.value) input.value = next;
      if (!error.hidden) {
        error.hidden = true;
        input.removeAttribute('aria-invalid');
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      send(input.value, false, submit);
    });

    replace(body,
      hero(),
      h('h2', { class: 'link-title' }, h('span', { text: 'Sign in to YapOS Party as ' }), h('strong', { text: name }), h('span', { text: '?' })),
      h('p', { class: 'link-text', text: user.username ? `Games you play in the call will count for @${user.username}.` : 'Games you play in the call will count for your account.' }),
      form);
    input.focus();
  }

  function drawOther(code, message) {
    const yes = button({ label: 'Sign in anyway', variant: 'primary', className: 'link-submit' });
    yes.addEventListener('click', () => send(code, true, yes));
    replace(body,
      hero(),
      h('div', { class: 'notice link-notice', attrs: { role: 'alert' } },
        icon('alert', { size: 16 }),
        h('div', null,
          h('strong', { class: 'link-notice-title', text: 'Different Yapin\' account' }),
          h('p', { text: message }))),
      h('p', { class: 'link-text', text: `If someone else gave you this code, cancel. Otherwise you can still sign in as ${name}.` }),
      h('div', { class: 'link-actions' }, yes, button({ label: 'Cancel', variant: 'ghost', onClick: () => drawForm('') })));
    yes.focus();
  }

  function drawDone(signedAs) {
    const who = signedAs && (signedAs.display_name || signedAs.username) ? signedAs.display_name || signedAs.username : name;
    const title = h('h2', { class: 'link-title', attrs: { tabindex: '-1' } }, h('span', { text: "You're signed in, " }), h('strong', { text: who }), h('span', { text: '!' }));
    replace(body,
      h('div', { class: 'link-done' },
        h('span', { class: 'link-done-mark', attrs: { 'aria-hidden': 'true' } }, icon('check', { size: 28 })),
        title,
        h('p', { class: 'link-text', attrs: { role: 'status' }, text: 'Head back to the call. YapOS Party notices in a few seconds, then you can join games.' }),
        h('div', { class: 'link-actions link-actions-center' },
          button({ label: 'Link another code', variant: 'secondary', onClick: () => drawForm('') }),
          linkButton({ label: 'Back to the dashboard', href: '/servers', variant: 'ghost' }))));
    title.focus();
  }

  async function send(raw, confirm, btn) {
    const code = cleanCode(raw);
    if (code.length !== 8) {
      drawForm(raw, 'Type all 8 letters and numbers of the code, like K7QM-2XPA.');
      return;
    }
    setBusy(btn, true, 'Signing in…');
    try {
      const data = await api.post(APPROVE_API, { code: formatCode(code), confirm }, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      drawDone(data && data.user);
    } catch (err) {
      if (ctx.signal?.aborted) return;
      const kind = err instanceof ApiError && err.data && typeof err.data.error === 'string' ? err.data.error : '';
      const message = err instanceof ApiError ? err.message : 'That did not work. Try again.';
      if (kind === 'other_account') drawOther(code, message);
      else drawForm(code, message);
    }
  }

  drawForm('');
}

export function signinsText(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "You're not signed in to YapOS Party with a code anywhere.";
  return n === 1 ? "You're signed in to YapOS Party with a code in 1 place." : `You're signed in to YapOS Party with a code in ${n} places.`;
}

export function partySigninsCard(ctx) {
  const { api } = ctx;
  const line = h('p', { class: 'field-help party-signins-text', attrs: { 'aria-live': 'polite' }, text: 'Checking…' });
  const end = button({ label: 'Sign out of YapOS Party everywhere', icon: 'logout', variant: 'secondary', size: 'sm' });
  end.hidden = true;
  const actions = h('div', { class: 'link-actions party-signins-actions' }, end, linkButton({ label: 'Enter a code', href: '/link', icon: 'link', size: 'sm', variant: 'ghost' }));
  const show = (count) => {
    line.textContent = signinsText(count);
    end.hidden = !(Number(count) > 0);
  };
  end.addEventListener('click', async () => {
    setBusy(end, true, 'Signing out…');
    try {
      await api.request('DELETE', PARTY_SIGNINS_API, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      show(0);
      toast('Signed out of YapOS Party everywhere.');
    } catch (err) {
      if (ctx.signal?.aborted) return;
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't sign out" });
    }
    setBusy(end, false);
  });
  api.get(PARTY_SIGNINS_API, { signal: ctx.signal }).then((data) => {
    if (!ctx.signal?.aborted) show(data && data.count);
  }).catch(() => {
    if (!ctx.signal?.aborted) line.textContent = "Couldn't check your YapOS Party sign-ins right now.";
  });
  return card({ title: 'YapOS Party', icon: 'sparkles', className: 'party-signins' }, line, actions);
}

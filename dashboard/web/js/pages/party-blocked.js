import { h, replace, nextId } from '../dom.js';
import { button, card, confirmDialog, setBusy, toast, errorState } from '../ui.js';
import { ApiError } from '../api.js';
import { relativeTime } from '../format.js';

export const BLOCKED_PATH = '/api/party/blocked-words';
export const BLOCKED_NOTE = 'The built-in filter always applies too. Words here are added on top of it in guesses, chat and everything players type in YapOS Party, within a few minutes.';

const str = (v) => (typeof v === 'string' ? v : '');

export function readBlocked(data) {
  const d = data && typeof data === 'object' ? data : {};
  const words = (Array.isArray(d.words) ? d.words : [])
    .filter((w) => w && typeof w === 'object' && typeof w.id === 'string' && typeof w.word === 'string')
    .map((w) => ({ id: w.id, word: w.word, by: str(w.added_name) || 'Staff', created: Number(w.created) || 0 }));
  return { words, max: Number(d.max) || 500, chars: Number(d.chars) || 40 };
}

export function matchBlocked(words, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return words;
  return words.filter((w) => w.word.toLowerCase().includes(q));
}

export function blockedCountText(shown, total, max) {
  if (shown !== total) return `${shown} of ${total} shown`;
  return `${total} of ${max}`;
}

export function blockedWordsCard(ctx) {
  const { api } = ctx;
  let view = readBlocked(null);
  let query = '';
  const inputId = nextId('blocked-word');
  const errorId = nextId('blocked-error');
  const helpId = nextId('blocked-help');
  const input = h('input', { type: 'text', id: inputId, class: 'input', maxLength: 40, autocomplete: 'off', spellcheck: false, placeholder: 'A word or short phrase', attrs: { 'aria-describedby': `${helpId} ${errorId}` } });
  const errorEl = h('p', { class: 'field-error', id: errorId, attrs: { role: 'alert' } });
  const addBtn = button({ label: 'Block', icon: 'plus', variant: 'primary', type: 'submit' });
  const search = h('input', { type: 'search', class: 'input blocked-search', placeholder: 'Search blocked words', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': 'Search blocked words' } });
  const countEl = h('span', { class: 'party-count' });
  const listBody = h('div', { class: 'party-list-wrap' });
  const form = h('form', { class: 'party-add', attrs: { novalidate: true } },
    h('label', { class: 'field-label', htmlFor: inputId, text: 'Block a word or phrase' }),
    h('div', { class: 'inline-form' }, input, addBtn),
    h('p', { class: 'field-help', id: helpId, text: BLOCKED_NOTE }),
    errorEl);

  const setError = (text) => {
    errorEl.textContent = text || '';
    input.classList.toggle('is-invalid', Boolean(text));
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };
  input.addEventListener('input', () => setError(''));
  search.addEventListener('input', () => {
    query = search.value;
    draw();
  });

  function row(w) {
    return h('li', { class: 'party-row blocked-row', dataset: { id: w.id } },
      h('span', { class: 'party-row-main' },
        h('span', { class: 'party-row-title', text: w.word }),
        h('span', { class: 'party-row-sub', text: `Added by ${w.by}${w.created ? ` ${relativeTime(w.created)}` : ''}` })),
      h('span', { class: 'party-row-end' }, button({ label: 'Remove', icon: 'x', size: 'sm', ariaLabel: `Stop blocking ${w.word}`, onClick: (e) => remove(w, e.currentTarget) })));
  }

  function draw() {
    const shown = matchBlocked(view.words, query);
    countEl.textContent = blockedCountText(shown.length, view.words.length, view.max);
    addBtn.disabled = view.words.length >= view.max;
    if (!view.words.length) {
      replace(listBody, h('p', { class: 'party-empty muted', text: 'No extra blocked words yet. The built-in filter is still on.' }));
      return;
    }
    replace(listBody,
      search,
      shown.length ? h('ul', { class: 'party-list' }, ...shown.map(row)) : h('p', { class: 'party-empty muted', text: 'No blocked words match that search.' }));
  }

  function show(data) {
    view = readBlocked(data);
    draw();
  }

  async function remove(w, btn) {
    const ok = await confirmDialog({ title: `Stop blocking "${w.word}"?`, body: 'Players can use it again within a few minutes, unless the built-in filter blocks it.', confirmLabel: 'Remove' });
    if (!ok || ctx.signal?.aborted) return;
    if (btn?.isConnected) setBusy(btn, true, 'Removing');
    try {
      show(await api.request('DELETE', `${BLOCKED_PATH}/${encodeURIComponent(w.id)}`, { signal: ctx.signal }));
      toast(`"${w.word}" is no longer blocked.`);
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't remove it" });
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const word = input.value.trim();
    if (!word) return setError('Type a word or phrase first.');
    if (Array.from(word).length > view.chars) return setError(`Keep it under ${view.chars} characters.`);
    if (view.words.length >= view.max) return setError(`You can block up to ${view.max} words. Remove one first.`);
    setError('');
    setBusy(addBtn, true, 'Adding');
    try {
      const data = await api.post(BLOCKED_PATH, { word }, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      setBusy(addBtn, false);
      input.value = '';
      show(data);
      toast(`"${word}" is blocked in YapOS Party.`);
    } catch (err) {
      if (ctx.signal?.aborted) return;
      setBusy(addBtn, false);
      addBtn.disabled = view.words.length >= view.max;
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
    }
  });

  async function load() {
    replace(listBody, h('p', { class: 'muted', text: 'Loading blocked words…' }));
    try {
      show(await api.get(BLOCKED_PATH, { signal: ctx.signal }));
    } catch (err) {
      if (ctx.signal?.aborted) return;
      replace(listBody, errorState({ title: "Couldn't load blocked words", body: err instanceof ApiError ? err.message : '', onRetry: load, compact: true }));
    }
  }
  load();

  return card({ title: 'Blocked words', icon: 'ban', actions: countEl }, form, listBody);
}

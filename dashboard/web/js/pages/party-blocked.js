import { h, replace, nextId } from '../dom.js';
import { badge, button, card, confirmDialog, setBusy, toast, errorState } from '../ui.js';
import { ApiError } from '../api.js';
import { relativeTime } from '../format.js';
import { validatePattern, testPattern } from '../../activity/js/filter.js';

export const BLOCKED_PATH = '/api/party/blocked-words';
export const PATTERNS_PATH = '/api/party/blocked-patterns';
export const PATTERN_NOTE = 'Patterns are regular expressions, always case-insensitive. They run on what players type and on a cleaned-up copy (look-alike letters, 1337 speak, repeats and s p a c e d letters fixed), so keep them short and specific. Only the owner can change them.';
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

export function readPatterns(data) {
  const d = data && typeof data === 'object' ? data : {};
  const patterns = (Array.isArray(d.patterns) ? d.patterns : [])
    .filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.pattern === 'string')
    .map((p) => ({ id: p.id, pattern: p.pattern, by: str(p.added_name) || 'Owner', created: Number(p.created) || 0 }));
  return { patterns, max: Number(d.pattern_max) || 50, chars: Number(d.pattern_chars) || 120, canEdit: d.can_patterns === true };
}

export function patternPreview(src, sample) {
  const source = String(src || '').trim();
  const text = String(sample || '');
  if (!source) return { problem: null, spans: [], ready: false };
  const problem = validatePattern(source, { trial: false });
  const broken = problem && ['bad_pattern', 'too_long', 'backref', 'lookbehind', 'bad_group'].includes(problem.code);
  return { problem, spans: broken || !text ? [] : testPattern(source, text), ready: true };
}

export function highlightParts(text, spans) {
  const parts = [];
  let at = 0;
  for (const s of spans) {
    if (s.start > at) parts.push({ text: text.slice(at, s.start), hit: false });
    parts.push({ text: text.slice(s.start, s.end), hit: true });
    at = s.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
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
  let pview = readPatterns(null);
  let mode = 'word';
  let editing = null;
  const patternId = nextId('blocked-pattern');
  const tryId = nextId('blocked-try');
  const wordLabel = h('label', { class: 'field-label', htmlFor: inputId, text: 'Block a word or phrase' });
  const wordRow = h('div', { class: 'inline-form' }, input, addBtn);
  const wordHelp = h('p', { class: 'field-help', id: helpId, text: BLOCKED_NOTE });
  const patternInput = h('input', { type: 'text', id: patternId, class: 'input pattern-input', maxLength: 120, autocomplete: 'off', spellcheck: false, placeholder: 'Like sk[i1]b+[i1]d[i1]', attrs: { 'aria-describedby': `${patternId}-help ${errorId}` } });
  const patternBtn = button({ label: 'Block pattern', icon: 'plus', variant: 'primary', type: 'submit' });
  const cancelBtn = button({ label: 'Cancel', size: 'sm', onClick: () => stopEditing() });
  const tryInput = h('input', { type: 'text', id: tryId, class: 'input', maxLength: 300, autocomplete: 'off', spellcheck: false, placeholder: 'Type a message to test the pattern on' });
  const tryOut = h('p', { class: 'pattern-try-out', attrs: { 'aria-live': 'polite' } });
  const tryNote = h('p', { class: 'field-help pattern-try-note', attrs: { 'aria-live': 'polite' } });
  const patternLabel = h('label', { class: 'field-label', htmlFor: patternId, text: 'Block a pattern' });
  const patternBox = h('div', { class: 'pattern-box' },
    patternLabel,
    h('div', { class: 'inline-form' }, patternInput, patternBtn),
    h('p', { class: 'field-help', id: `${patternId}-help`, text: PATTERN_NOTE }),
    h('label', { class: 'field-label', htmlFor: tryId, text: 'Try some text' }),
    tryInput,
    tryOut,
    tryNote);
  patternBox.hidden = true;
  cancelBtn.hidden = true;
  const modeBar = h('div', { class: 'segmented blocked-mode', attrs: { role: 'group', 'aria-label': 'What to block' } });
  modeBar.hidden = true;
  const form = h('form', { class: 'party-add', attrs: { novalidate: true } },
    modeBar,
    wordLabel,
    wordRow,
    wordHelp,
    patternBox,
    errorEl,
    cancelBtn);
  const patternsBody = h('div', { class: 'party-list-wrap blocked-patterns' });

  const setError = (text) => {
    const field = mode === 'pattern' ? patternInput : input;
    errorEl.textContent = text || '';
    if (text && tryNote.textContent === text) tryNote.textContent = '';
    for (const el of [input, patternInput]) {
      const on = Boolean(text) && el === field;
      el.classList.toggle('is-invalid', on);
      if (on) el.setAttribute('aria-invalid', 'true');
      else el.removeAttribute('aria-invalid');
    }
  };
  input.addEventListener('input', () => setError(''));
  patternInput.addEventListener('input', () => {
    setError('');
    drawTry();
  });
  tryInput.addEventListener('input', () => drawTry());

  function drawTry() {
    const res = patternPreview(patternInput.value, tryInput.value);
    const text = tryInput.value;
    if (!text) replace(tryOut);
    else replace(tryOut, ...highlightParts(text, res.spans).map((p) => (p.hit ? h('mark', { class: 'pattern-hit', text: p.text }) : h('span', { text: p.text }))));
    if (!res.ready) tryNote.textContent = 'Type a pattern, then some text to see what it would hide.';
    else if (res.problem) tryNote.textContent = res.problem.message;
    else if (!text) tryNote.textContent = 'Looks good. Type some text to see what it would hide.';
    else if (res.spans.length) tryNote.textContent = `Would hide ${res.spans.map((s) => `“${s.text}”`).join(', ')}.`;
    else tryNote.textContent = 'Nothing in that text would be hidden.';
    tryNote.classList.toggle('is-bad', Boolean(res.problem));
  }

  function setMode(next) {
    mode = next;
    const words = mode === 'word';
    for (const el of [wordLabel, wordRow, wordHelp]) el.hidden = !words;
    patternBox.hidden = words;
    cancelBtn.hidden = words || !editing;
    setError('');
    drawMode();
    if (!words) drawTry();
  }

  function drawMode() {
    modeBar.hidden = !pview.canEdit;
    if (!pview.canEdit) {
      replace(modeBar);
      return;
    }
    replace(modeBar, ...[['word', 'Word'], ['pattern', 'Pattern']].map(([v, text]) => {
      const b = button({ label: text, size: 'sm', variant: mode === v ? 'segment-active' : 'segment', onClick: () => {
        if (mode !== v) setMode(v);
      } });
      b.setAttribute('aria-pressed', mode === v ? 'true' : 'false');
      return b;
    }));
  }

  function stopEditing() {
    editing = null;
    patternInput.value = '';
    patternLabel.textContent = 'Block a pattern';
    patternBtn.querySelector('.btn-label').textContent = 'Block pattern';
    setMode(pview.canEdit ? 'pattern' : 'word');
  }

  function startEditing(p) {
    editing = p;
    patternInput.value = p.pattern;
    patternLabel.textContent = 'Change this pattern';
    patternBtn.querySelector('.btn-label').textContent = 'Save pattern';
    setMode('pattern');
    patternInput.focus();
  }

  function patternRow(p) {
    const end = pview.canEdit
      ? h('span', { class: 'party-row-end' },
        button({ label: 'Edit', size: 'sm', ariaLabel: `Change the pattern ${p.pattern}`, onClick: () => startEditing(p) }),
        button({ label: 'Remove', icon: 'x', size: 'sm', ariaLabel: `Stop blocking the pattern ${p.pattern}`, onClick: (e) => removePattern(p, e.currentTarget) }))
      : h('span', { class: 'party-row-end' }, badge('Owner only'));
    return h('li', { class: 'party-row blocked-row', dataset: { id: p.id } },
      h('span', { class: 'party-row-main' },
        h('code', { class: 'party-row-title pattern-src', text: p.pattern }),
        h('span', { class: 'party-row-sub', text: `Pattern · added by ${p.by}${p.created ? ` ${relativeTime(p.created)}` : ''}` })),
      end);
  }

  function drawPatterns() {
    if (!pview.patterns.length && !pview.canEdit) {
      replace(patternsBody);
      return;
    }
    replace(patternsBody,
      h('h3', { class: 'blocked-sub', text: `Patterns (${pview.patterns.length} of ${pview.max})` }),
      pview.patterns.length
        ? h('ul', { class: 'party-list' }, ...pview.patterns.map(patternRow))
        : h('p', { class: 'party-empty muted', text: 'No patterns yet. Switch to Pattern above to add one.' }),
      pview.canEdit ? null : h('p', { class: 'field-help', text: 'Only the owner of YapOS Party can change patterns.' }));
  }

  async function removePattern(p, btn) {
    const ok = await confirmDialog({ title: 'Stop blocking this pattern?', body: `“${p.pattern}” stops hiding text within a few minutes. Words it caught may still be blocked by other rules.`, confirmLabel: 'Remove' });
    if (!ok || ctx.signal?.aborted) return;
    if (btn?.isConnected) setBusy(btn, true, 'Removing');
    try {
      show(await api.request('DELETE', `${PATTERNS_PATH}/${encodeURIComponent(p.id)}`, { signal: ctx.signal }));
      if (editing && editing.id === p.id) stopEditing();
      toast('That pattern is no longer blocked.');
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't remove it" });
    }
  }

  async function savePattern() {
    const pattern = patternInput.value.trim();
    if (!pattern) return setError('Type a pattern first.');
    if (!editing && pview.patterns.length >= pview.max) return setError(`You can have up to ${pview.max} patterns. Remove one first.`);
    const problem = validatePattern(pattern);
    if (problem) return setError(problem.message);
    setError('');
    setBusy(patternBtn, true, 'Saving');
    try {
      const data = editing
        ? await api.patch(`${PATTERNS_PATH}/${encodeURIComponent(editing.id)}`, { pattern }, { signal: ctx.signal })
        : await api.post(PATTERNS_PATH, { pattern }, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      setBusy(patternBtn, false);
      const was = editing;
      show(data);
      stopEditing();
      toast(was ? 'Pattern saved.' : 'Pattern blocked in YapOS Party.');
    } catch (err) {
      if (ctx.signal?.aborted) return;
      setBusy(patternBtn, false);
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
    }
  }
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
    pview = readPatterns(data);
    draw();
    if (!pview.canEdit && mode === 'pattern') setMode('word');
    else drawMode();
    drawPatterns();
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
    if (mode === 'pattern') return savePattern();
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

  return card({ title: 'Blocked words', icon: 'ban', actions: countEl }, form, listBody, patternsBody);
}

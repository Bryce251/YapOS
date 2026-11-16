import { h, nextId, replace } from '../dom.js';
import { button, card, confirmDialog, copyText, emptyState, loadingRegion, pageHeader, setBusy, skeleton, toast } from '../ui.js';
import { ApiError } from '../api.js';
import { mountAsync } from './common.js';

export const PACKS_PATH = '/api/packs';
export const DEFAULT_LIMITS = Object.freeze({ words: 500, trivia: 200, name: 40, packs: 10 });
const WRONG = 3;

export function parseWords(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[\n,]+/)) {
    const w = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!w || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function readSummary(p) {
  if (!p || typeof p !== 'object' || typeof p.code !== 'string') return null;
  return {
    code: p.code,
    name: typeof p.name === 'string' ? p.name : 'Word pack',
    wordCount: Number.isInteger(p.wordCount) ? p.wordCount : 0,
    triviaCount: Number.isInteger(p.triviaCount) ? p.triviaCount : 0,
  };
}

export function readPacks(data) {
  const limits = data?.limits || {};
  return {
    packs: Array.isArray(data?.packs) ? data.packs.map(readSummary).filter(Boolean) : [],
    max: Number.isInteger(data?.max) && data.max > 0 ? data.max : DEFAULT_LIMITS.packs,
    limits: {
      words: Number.isInteger(limits.words) ? limits.words : DEFAULT_LIMITS.words,
      trivia: Number.isInteger(limits.trivia) ? limits.trivia : DEFAULT_LIMITS.trivia,
      name: Number.isInteger(limits.name) ? limits.name : DEFAULT_LIMITS.name,
    },
  };
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function packSummary(p) {
  return `${plural(p.wordCount, 'word', 'words')} · ${plural(p.triviaCount, 'question', 'questions')}`;
}

function codeChip(code) {
  const btn = button({ label: 'Copy code', icon: 'copy', size: 'sm', ariaLabel: `Copy the code ${code}` });
  btn.addEventListener('click', async () => {
    const ok = await copyText(code);
    if (ok) toast(`Copied ${code}. Type it into the game settings in YapOS Party.`);
    else toast(`Couldn't copy automatically. The code is ${code}.`, { tone: 'danger' });
  });
  return h('span', { class: 'pack-code' }, h('code', { class: 'pack-code-text', text: code }), btn);
}

function listSkeleton() {
  return loadingRegion('Loading your word packs', h('ul', { class: 'pack-list' }, ...Array.from({ length: 2 }, () => h('li', { class: 'pack-row is-skeleton' },
    h('span', { class: 'pack-row-main' }, skeleton('skeleton-text skeleton-w-40'), skeleton('skeleton-text skeleton-w-60'))))));
}

function howTo() {
  return h('ol', { class: 'pack-steps' },
    h('li', { text: 'Make a pack with your own Draw & Guess words, trivia questions or both.' }),
    h('li', { text: 'Copy its code.' }),
    h('li', { text: 'In a YapOS Party call, the host opens the game settings and types the code in.' }));
}

export function renderPacks(ctx) {
  const { api, main } = ctx;
  ctx.setChrome({ variant: 'plain', section: 'packs', crumbs: [{ label: 'Servers', href: '/servers' }, { label: 'Word packs' }] });

  let current = readPacks(null);
  let editing = null;

  const countEl = h('span', { class: 'party-count' });
  const newBtn = button({ label: 'New pack', icon: 'plus', variant: 'primary', size: 'sm', onClick: () => openEditor(null) });
  const listBody = h('div', { class: 'pack-list-wrap' });
  const listView = h('div', { class: 'page page-narrow pack-page' },
    pageHeader({
      title: 'Word packs',
      description: 'Make your own words and trivia questions for YapOS Party. Every pack gets a short code that anyone can use in a call.',
      actions: newBtn,
    }),
    card({ title: 'How it works', icon: 'info' }, howTo()),
    card({ title: 'Your packs', icon: 'folder', actions: countEl }, listBody));

  function showList() {
    editing = null;
    ctx.setLeaveGuard?.(null);
    main.replaceChildren(listView);
  }

  async function remove(p, btn) {
    const ok = await confirmDialog({
      title: `Delete ${p.name}?`,
      body: `The code ${p.code} stops working right away. Games that already loaded it keep it until they end. This can't be undone.`,
      confirmLabel: 'Delete pack',
    });
    if (!ok || ctx.signal?.aborted) return;
    if (btn?.isConnected) setBusy(btn, true, 'Deleting');
    try {
      const data = await api.request('DELETE', `${PACKS_PATH}/${encodeURIComponent(p.code)}`, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      showPacks(data);
      toast(`${p.name} is deleted.`);
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't delete the pack" });
    }
  }

  async function edit(p, btn) {
    if (btn?.isConnected) setBusy(btn, true, 'Opening');
    try {
      const data = await api.get(`${PACKS_PATH}/${encodeURIComponent(p.code)}`, { signal: ctx.signal });
      if (ctx.signal?.aborted) return;
      openEditor(data?.pack || null);
    } catch (err) {
      if (ctx.signal?.aborted) return;
      if (btn?.isConnected) setBusy(btn, false);
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't open the pack" });
    }
  }

  function packRow(p) {
    return h('li', { class: 'pack-row', dataset: { code: p.code } },
      h('span', { class: 'pack-row-main' },
        h('span', { class: 'pack-row-title', text: p.name }),
        h('span', { class: 'pack-row-sub', text: packSummary(p) })),
      codeChip(p.code),
      h('span', { class: 'pack-row-actions' },
        button({ label: 'Edit', icon: 'sliders', size: 'sm', ariaLabel: `Edit ${p.name}`, onClick: (e) => edit(p, e.currentTarget) }),
        button({ label: 'Delete', icon: 'trash', size: 'sm', ariaLabel: `Delete ${p.name}`, onClick: (e) => remove(p, e.currentTarget) })));
  }

  function showPacks(data) {
    current = readPacks(data);
    countEl.textContent = `${current.packs.length} of ${current.max}`;
    newBtn.disabled = current.packs.length >= current.max;
    newBtn.title = newBtn.disabled ? `You can keep up to ${current.max} packs. Delete one to make another.` : '';
    replace(listBody, current.packs.length
      ? h('ul', { class: 'pack-list' }, ...current.packs.map(packRow))
      : emptyState({ icon: 'folder', title: 'No packs yet', body: 'Make one to play Draw & Guess and Trivia with your own words and questions.', action: button({ label: 'Make a pack', icon: 'plus', variant: 'primary', onClick: () => openEditor(null) }), compact: true }));
  }

  function openEditor(pack) {
    editing = pack;
    const limits = current.limits;
    const nameId = nextId('pack-name');
    const wordsId = nextId('pack-words');
    const wordsHelpId = nextId('pack-words-help');
    const errorId = nextId('pack-error');
    const startName = pack?.name || '';
    const startWords = Array.isArray(pack?.words) ? pack.words.join('\n') : '';
    const startTrivia = JSON.stringify(Array.isArray(pack?.trivia) ? pack.trivia : []);

    const nameInput = h('input', { type: 'text', id: nameId, class: 'input', maxLength: limits.name, placeholder: 'Movie night', autocomplete: 'off', value: startName });
    const wordsInput = h('textarea', { id: wordsId, class: 'input textarea pack-words', rows: 10, spellcheck: true, placeholder: 'popcorn\nred carpet\nmovie ticket', value: startWords, attrs: { 'aria-describedby': wordsHelpId } });
    const wordCount = h('span', { class: 'pack-counter', attrs: { 'aria-live': 'polite' } });
    const questionCount = h('span', { class: 'pack-counter' });
    const rowsEl = h('ol', { class: 'trivia-rows' });
    const refs = new WeakMap();
    const errorEl = h('p', { class: 'field-error pack-error', id: errorId, attrs: { role: 'alert' } });
    const saveBtn = button({ label: pack ? 'Save changes' : 'Create pack', icon: 'check', variant: 'primary', type: 'submit' });
    const cancelBtn = button({ label: 'Cancel', onClick: () => leave() });
    const addBtn = button({ label: 'Add question', icon: 'plus', size: 'sm', onClick: () => {
      addRow();
      rowsEl.lastElementChild?.querySelector('input')?.focus();
    } });

    function updateCounts() {
      const n = parseWords(wordsInput.value).length;
      wordCount.textContent = `${n} of ${limits.words}`;
      wordCount.classList.toggle('is-over', n > limits.words);
      const q = rowsEl.children.length;
      questionCount.textContent = `${q} of ${limits.trivia}`;
      addBtn.disabled = q >= limits.trivia;
      Array.from(rowsEl.children).forEach((row, i) => {
        const num = row.querySelector('.trivia-num');
        if (num) num.textContent = `Question ${i + 1}`;
      });
    }

    function field(label, input) {
      return h('label', { class: 'trivia-field' }, h('span', { class: 'field-label', text: label }), input);
    }

    function addRow(item = null) {
      const q = h('input', { type: 'text', class: 'input', maxLength: 200, placeholder: 'Which planet is known as the red planet?', value: item?.q || '' });
      const a = h('input', { type: 'text', class: 'input', maxLength: 80, placeholder: 'Mars', value: item?.a || '' });
      const wrong = Array.from({ length: WRONG }, (_, i) => h('input', { type: 'text', class: 'input', maxLength: 80, placeholder: ['Venus', 'Jupiter', 'Saturn'][i], value: item?.w?.[i] || '' }));
      const row = h('li', { class: 'trivia-row' },
        h('div', { class: 'trivia-head' },
          h('span', { class: 'trivia-num' }),
          button({ label: 'Remove', icon: 'x', size: 'sm', ariaLabel: 'Remove this question', onClick: () => {
            row.remove();
            updateCounts();
          } })),
        field('Question', q),
        h('div', { class: 'trivia-answers' },
          field('Right answer', a),
          ...wrong.map((w, i) => field(`Wrong answer ${i + 1}`, w))));
      refs.set(row, { q, a, wrong });
      rowsEl.append(row);
      updateCounts();
    }

    function readTrivia() {
      return Array.from(rowsEl.children).map((row) => refs.get(row)).filter(Boolean).map((r) => ({
        q: r.q.value.trim(),
        a: r.a.value.trim(),
        w: r.wrong.map((el) => el.value.trim()),
      })).filter((t) => t.q || t.a || t.w.some(Boolean));
    }

    function snapshot() {
      return JSON.stringify([nameInput.value.trim(), parseWords(wordsInput.value), readTrivia()]);
    }
    const start = JSON.stringify([startName.trim(), parseWords(startWords), JSON.parse(startTrivia)]);
    const isDirty = () => snapshot() !== start;
    ctx.setLeaveGuard?.({ isDirty });

    async function leave() {
      if (isDirty()) {
        const ok = await confirmDialog({ title: 'Discard your changes?', body: "You changed this pack but didn't save it.", confirmLabel: 'Discard changes' });
        if (!ok) return;
      }
      showList();
    }

    const setError = (text) => {
      errorEl.textContent = text || '';
    };

    for (const item of Array.isArray(pack?.trivia) ? pack.trivia : []) addRow(item);
    wordsInput.addEventListener('input', () => {
      setError('');
      updateCounts();
    });
    nameInput.addEventListener('input', () => setError(''));

    const form = h('form', { class: 'pack-form', attrs: { novalidate: true, 'aria-describedby': errorId } },
      card({ title: 'Name', icon: 'tag' },
        h('label', { class: 'field-label', htmlFor: nameId, text: 'Pack name' }),
        nameInput,
        pack ? h('div', { class: 'pack-code-row' }, h('span', { class: 'muted', text: 'Code' }), codeChip(pack.code)) : h('p', { class: 'field-help', text: 'You get a code to share once you create the pack.' })),
      card({ title: 'Draw & Guess words', icon: 'palette', actions: wordCount },
        h('label', { class: 'sr-only', htmlFor: wordsId, text: 'Draw & Guess words' }),
        wordsInput,
        h('p', { class: 'field-help', id: wordsHelpId, text: 'One word or short phrase per line (commas work too), 2 to 30 characters each. Repeats are skipped.' })),
      card({ title: 'Trivia questions', icon: 'sparkles', actions: questionCount },
        rowsEl,
        h('div', { class: 'trivia-add' }, addBtn, h('span', { class: 'field-help', text: 'Each question needs one right answer and three wrong ones. Players see them shuffled.' }))),
      errorEl,
      h('div', { class: 'pack-actions' }, cancelBtn, saveBtn));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      const words = parseWords(wordsInput.value);
      const trivia = readTrivia();
      if (!name) {
        setError('Give your pack a name.');
        nameInput.focus();
        return;
      }
      if (!words.length && !trivia.length) return setError('Add at least one word or one question.');
      if (words.length > limits.words) return setError(`A pack can have at most ${limits.words} words. You have ${words.length}.`);
      const broken = trivia.findIndex((t) => !t.q || !t.a || t.w.length !== WRONG || t.w.some((x) => !x));
      if (broken >= 0) return setError(`Question ${broken + 1} needs a question, a right answer and three wrong answers.`);
      setError('');
      setBusy(saveBtn, true, 'Saving');
      try {
        const body = { name, words, trivia };
        const data = editing
          ? await api.request('PUT', `${PACKS_PATH}/${encodeURIComponent(editing.code)}`, { body, signal: ctx.signal })
          : await api.post(PACKS_PATH, body, { signal: ctx.signal });
        if (ctx.signal?.aborted) return;
        const saved = data?.pack;
        const list = await api.get(PACKS_PATH, { signal: ctx.signal });
        if (ctx.signal?.aborted) return;
        showPacks(list);
        showList();
        toast(saved?.code ? `${saved.name} is saved. Its code is ${saved.code}.` : 'Saved.', { title: editing ? 'Pack updated' : 'Pack created', timeout: 6000 });
      } catch (err) {
        if (ctx.signal?.aborted) return;
        setBusy(saveBtn, false);
        setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
      }
    });

    updateCounts();
    main.replaceChildren(h('div', { class: 'page page-narrow pack-page' },
      pageHeader({
        title: pack ? `Edit ${pack.name}` : 'New word pack',
        description: 'Words go into Draw & Guess. Questions go into Trivia. Anything that breaks the YapOS Party word filter is refused when you save.',
        actions: button({ label: 'Back to packs', icon: 'chevron-left', size: 'sm', onClick: () => leave() }),
      }),
      form));
    nameInput.focus();
  }

  main.replaceChildren(listView);
  mountAsync(listBody, {
    signal: ctx.signal,
    skeleton: listSkeleton,
    load: ({ signal }) => api.get(PACKS_PATH, { signal }),
    render: (data) => showPacks(data),
  });
}

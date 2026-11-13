import { h, nextId, replace } from './dom.js';
import { icon } from './icons.js';
import { picker } from './picker.js';
import { switchControl } from './ui.js';
import { durationPicker } from './kit.js';
import { MAX_LEVEL, STEP_ACTIONS, cloneEdit, mapItems, splitEmoji } from './forms.js';

const TIMEOUT_PRESETS = [
  { value: '10m', label: '10 min' },
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '1w', label: '1 week' },
];

const SAMPLE = { user: '@Alex', username: 'Alex', mention: '@Alex', level: '5', count: '128', count_ord: '128th', member_count: '128', channel: '#general' };

export function placeholdersIn(help) {
  const out = [];
  for (const m of String(help || '').matchAll(/\{([a-z_]+)\}/gi)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function fillPlaceholders(text, { serverName = '' } = {}) {
  const values = { ...SAMPLE, server: serverName || 'Your server' };
  return String(text || '').replace(/\{([a-z_]+)\}/gi, (all, k) => (Object.prototype.hasOwnProperty.call(values, k.toLowerCase()) ? values[k.toLowerCase()] : all));
}

function richLine(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p) => (/^\*\*[^*]+\*\*$/.test(p) ? h('strong', { text: p.slice(2, -2) }) : document.createTextNode(p)));
}

export function messagePreview({ serverName = '' } = {}) {
  const body = h('div', { class: 'msg-preview-body' });
  const el = h('div', { class: 'msg-preview', attrs: { 'aria-live': 'polite' } },
    h('div', { class: 'msg-preview-head' },
      h('span', { class: 'msg-preview-avatar', text: 'Y', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'msg-preview-name', text: 'YapOS' }),
      h('span', { class: 'msg-preview-tag', text: 'BOT' }),
      h('span', { class: 'msg-preview-label', text: 'Preview' })),
    body);
  return {
    el,
    update(text) {
      const filled = fillPlaceholders(text, { serverName });
      if (!filled.trim()) {
        replace(body, h('span', { class: 'msg-preview-empty', text: 'Nothing to show yet. Type a message above.' }));
        return;
      }
      replace(body, ...filled.split('\n').map((line) => h('p', { class: 'msg-preview-line' }, ...richLine(line))));
    },
  };
}

export function placeholderChips(names, onPick) {
  if (!names.length) return null;
  return h('div', { class: 'ph-chips', attrs: { role: 'group', 'aria-label': 'Insert a placeholder' } },
    h('span', { class: 'ph-chips-label', text: 'Insert:' }),
    ...names.map((n) => {
      const b = h('button', { type: 'button', class: 'ph-chip', text: `{${n}}`, attrs: { title: `Insert {${n}}` } });
      b.addEventListener('click', () => onPick(`{${n}}`));
      return b;
    }));
}

export function optionCards({ options, value, onChange, labelId }) {
  let current = value;
  const group = h('div', { class: ['option-cards', `option-cards-${Math.min(options.length, 4)}`], attrs: { role: 'radiogroup', 'aria-labelledby': labelId || null } });
  const cards = options.map((o) => {
    const { emoji, name } = splitEmoji(o.label);
    const b = h('button', { type: 'button', class: 'option-card', dataset: { value: String(o.value) }, attrs: { role: 'radio' } },
      emoji ? h('span', { class: 'option-card-emoji', text: emoji, attrs: { 'aria-hidden': 'true' } }) : null,
      h('span', { class: 'option-card-name', text: name }),
      h('span', { class: 'option-card-check', attrs: { 'aria-hidden': 'true' } }, icon('check', { size: 12 })));
    b.addEventListener('click', () => {
      current = String(o.value);
      paint();
      onChange(current);
    });
    b.addEventListener('keydown', (e) => {
      const i = cards.indexOf(b);
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = cards[(i + step + cards.length) % cards.length];
      next.focus();
      next.click();
    });
    return b;
  });
  function paint() {
    const any = cards.some((c) => c.dataset.value === current);
    cards.forEach((c, i) => {
      const on = c.dataset.value === current;
      c.classList.toggle('is-active', on);
      c.setAttribute('aria-checked', on ? 'true' : 'false');
      c.tabIndex = on || (!any && i === 0) ? 0 : -1;
    });
  }
  group.append(...cards);
  paint();
  return {
    el: group,
    setValue(v) {
      current = v;
      paint();
    },
    setInvalid(v) {
      group.classList.toggle('is-invalid', Boolean(v));
    },
  };
}

function decimals(step) {
  const s = String(step ?? 1);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

export function numberSlider({ field, value, onChange, ids }) {
  const step = field.step ?? 1;
  const useSlider = field.min !== null && field.max !== null && (field.max - field.min) / step <= 2000;
  const input = h('input', {
    id: ids.input,
    type: 'number',
    class: 'input input-number stepper-input',
    value,
    inputMode: step < 1 ? 'decimal' : 'numeric',
    attrs: { 'aria-describedby': ids.describedBy, min: field.min ?? null, max: field.max ?? null, step: field.step ?? 'any' },
  });
  const range = useSlider ? h('input', { type: 'range', class: 'range', min: field.min, max: field.max, step, value: value === '' ? field.min : value, attrs: { 'aria-label': `${field.label} slider`, tabindex: '-1' } }) : null;
  const minus = h('button', { type: 'button', class: 'stepper-btn', attrs: { 'aria-label': `Lower ${field.label}` } }, h('span', { text: '−', attrs: { 'aria-hidden': 'true' } }));
  const plus = h('button', { type: 'button', class: 'stepper-btn', attrs: { 'aria-label': `Raise ${field.label}` } }, icon('plus', { size: 14 }));
  function paintRange() {
    if (!range) return;
    const n = Number(input.value);
    const v = input.value === '' || !Number.isFinite(n) ? field.min : Math.min(field.max, Math.max(field.min, n));
    range.value = String(v);
    const pct = field.max === field.min ? 0 : ((v - field.min) / (field.max - field.min)) * 100;
    range.style.setProperty('--fill', `${pct}%`);
  }
  function bump(dir) {
    const n = Number(input.value);
    const base = input.value === '' || !Number.isFinite(n) ? (field.min ?? 0) : n;
    let next = Number((base + dir * step).toFixed(decimals(step)));
    if (field.min !== null) next = Math.max(field.min, next);
    if (field.max !== null) next = Math.min(field.max, next);
    input.value = String(next);
    paintRange();
    onChange(input.value);
  }
  minus.addEventListener('click', () => bump(-1));
  plus.addEventListener('click', () => bump(1));
  input.addEventListener('input', () => {
    paintRange();
    onChange(input.value);
  });
  range?.addEventListener('input', () => {
    input.value = range.value;
    paintRange();
    onChange(input.value);
  });
  paintRange();
  const stepper = h('div', { class: 'stepper' }, minus, input, plus);
  const limits = field.min !== null && field.max !== null
    ? h('div', { class: 'range-limits', attrs: { 'aria-hidden': 'true' } }, h('span', { text: String(field.min) }), h('span', { text: String(field.max) }))
    : null;
  return {
    el: h('div', { class: ['number-control', range ? 'has-range' : ''] }, stepper, range ? h('div', { class: 'range-wrap' }, range, limits) : null),
    setValue(v) {
      input.value = v;
      paintRange();
    },
    setInvalid(v) {
      input.classList.toggle('is-invalid', Boolean(v));
      if (v) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    },
  };
}

export function toggleGrid({ field, value, onChange, labelId }) {
  let state = { ...value };
  const tiles = [];
  const grid = h('div', { class: 'toggle-grid', attrs: { role: 'group', 'aria-labelledby': labelId || null } });
  for (const it of mapItems(field, value)) {
    const stateEl = h('span', { class: 'toggle-state' });
    const sw = switchControl({
      checked: state[it.id] === true,
      label: it.name,
      onChange: (v) => {
        state = { ...state, [it.id]: v };
        paint();
        onChange({ ...state });
      },
    });
    const tile = h('div', { class: 'toggle-tile', dataset: { key: it.id } },
      h('span', { class: 'toggle-emoji', text: it.emoji || '•', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-name', text: it.name }), stateEl),
      sw.el);
    tile.addEventListener('click', (e) => {
      if (!sw.el.contains(e.target)) sw.el.click();
    });
    tiles.push({ id: it.id, tile, sw, stateEl });
    grid.append(tile);
  }
  function paint() {
    for (const t of tiles) {
      const on = state[t.id] === true;
      t.sw.set(on);
      t.tile.classList.toggle('is-on', on);
      t.stateEl.textContent = on ? 'On' : 'Off';
    }
  }
  paint();
  return {
    el: grid,
    setValue(v) {
      state = { ...v };
      paint();
    },
    setInvalid() {},
  };
}

export function choiceRows({ field, value, onChange, labelId }) {
  let state = { ...value };
  const rows = [];
  const wrap = h('div', { class: 'map-rows', attrs: { role: 'group', 'aria-labelledby': labelId || null } });
  for (const it of mapItems(field, value)) {
    const nameId = nextId('mr');
    const chips = field.options.map((o) => {
      const { emoji, name } = splitEmoji(o.label);
      const b = h('button', { type: 'button', class: 'choice-chip', dataset: { value: String(o.value) }, attrs: { 'aria-pressed': 'false' } },
        emoji ? h('span', { class: 'choice-chip-emoji', text: emoji, attrs: { 'aria-hidden': 'true' } }) : null,
        h('span', { text: name }));
      b.addEventListener('click', () => {
        state = { ...state, [it.id]: String(o.value) };
        paint();
        onChange({ ...state });
      });
      return b;
    });
    rows.push({ id: it.id, chips });
    wrap.append(h('div', { class: 'map-row' },
      h('div', { class: 'map-row-name', id: nameId }, h('span', { class: 'map-row-emoji', text: it.emoji || '•', attrs: { 'aria-hidden': 'true' } }), h('span', { text: it.name })),
      h('div', { class: 'choice-chips', attrs: { role: 'group', 'aria-labelledby': nameId } }, ...chips)));
  }
  function paint() {
    for (const r of rows) {
      for (const c of r.chips) {
        const on = c.dataset.value === state[r.id];
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
  }
  paint();
  return {
    el: wrap,
    setValue(v) {
      state = { ...v };
      paint();
    },
    setInvalid() {},
  };
}

export function pickerRows({ field, value, onChange, labelId, items, kindLabel }) {
  let state = cloneEdit(value);
  const pickers = new Map();
  const wrap = h('div', { class: 'map-rows', attrs: { role: 'group', 'aria-labelledby': labelId || null } });
  const list = mapItems(field, value);
  if (!list.length) {
    wrap.append(h('p', { class: 'map-empty', text: 'Nothing to set up here yet.' }));
  }
  for (const it of list) {
    const nameId = nextId('mr');
    const p = picker({
      items,
      value: state[it.id] || [],
      multi: true,
      kindLabel,
      labelId: nameId,
      onChange: (v) => {
        state = { ...state, [it.id]: v.slice() };
        onChange(cloneEdit(state));
      },
    });
    pickers.set(it.id, p);
    wrap.append(h('div', { class: 'map-row map-row-picker' },
      h('div', { class: 'map-row-name', id: nameId }, h('span', { class: 'map-row-emoji', text: it.emoji || '•', attrs: { 'aria-hidden': 'true' } }), h('span', { text: it.name })),
      h('div', { class: 'map-row-control' }, p.el)));
  }
  return {
    el: wrap,
    setValue(v) {
      state = cloneEdit(v);
      for (const [id, p] of pickers) p.setValue(state[id] || []);
    },
    setInvalid() {},
  };
}

function removeButton(label, onClick) {
  const b = h('button', { type: 'button', class: 'row-remove', attrs: { 'aria-label': label, title: label } }, icon('x', { size: 14 }));
  b.addEventListener('click', onClick);
  return b;
}

function smallNumber({ value, label, min, max, onInput }) {
  const input = h('input', { type: 'number', class: 'input input-number row-number', value, min, max, step: 1, inputMode: 'numeric', attrs: { 'aria-label': label } });
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

export function rewardsEditor({ field, value, onChange, roleItems }) {
  let rows = cloneEdit(value);
  const limit = field.max ?? 20;
  const list = h('ol', { class: 'ladder' });
  const addBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm add-row' }, icon('plus', { size: 14 }), h('span', { class: 'btn-label', text: 'Add a reward' }));
  const count = h('span', { class: 'add-row-count' });
  function emit() {
    onChange(cloneEdit(rows));
  }
  function draw(focusLast = false) {
    if (!rows.length) {
      replace(list, h('li', { class: 'ladder-empty' }, h('span', { class: 'ladder-empty-icon', text: '🏆', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'No role rewards yet. Add one to give a role when someone reaches a level.' })));
    } else {
      replace(list, ...rows.map((r, i) => {
        const lvl = smallNumber({ value: r.level, label: `Level for reward ${i + 1}`, min: 1, max: MAX_LEVEL, onInput: (v) => { rows[i] = { ...rows[i], level: v }; emit(); } });
        const p = picker({ items: roleItems, value: r.role, kindLabel: 'role', placeholder: 'Choose a role', allowNone: false, onChange: (v) => { rows[i] = { ...rows[i], role: v || '' }; emit(); } });
        p.el.querySelector('.picker-trigger')?.setAttribute('aria-label', `Role for reward ${i + 1}`);
        return h('li', { class: 'ladder-row' },
          h('span', { class: 'ladder-dot', attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'ladder-text', text: 'Reach level' }),
          lvl,
          h('span', { class: 'ladder-arrow', attrs: { 'aria-hidden': 'true' } }, icon('arrow-right', { size: 14 })),
          h('span', { class: 'ladder-text', text: 'get' }),
          h('div', { class: 'ladder-picker' }, p.el),
          removeButton(`Remove reward ${i + 1}`, () => { rows = rows.filter((_, j) => j !== i); emit(); draw(); addBtn.focus(); }));
      }));
    }
    addBtn.disabled = rows.length >= limit;
    count.textContent = `${rows.length}/${limit}`;
    if (focusLast) list.querySelector('.ladder-row:last-child .row-number')?.focus();
  }
  addBtn.addEventListener('click', () => {
    const top = rows.reduce((m, r) => Math.max(m, Number(r.level) || 0), 0);
    rows = [...rows, { level: String(Math.min(MAX_LEVEL, top ? top + 5 : 5)), role: '' }];
    emit();
    draw(true);
  });
  draw();
  return {
    el: h('div', { class: 'row-editor' }, list, h('div', { class: 'add-row-bar' }, addBtn, count)),
    setValue(v) {
      rows = cloneEdit(v);
      draw();
    },
    setInvalid(v) {
      list.classList.toggle('is-invalid', Boolean(v));
    },
  };
}

export function stepsEditor({ value, onChange }) {
  let rows = cloneEdit(value);
  const list = h('ol', { class: 'ladder ladder-steps' });
  const addBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm add-row' }, icon('plus', { size: 14 }), h('span', { class: 'btn-label', text: 'Add a step' }));
  const summary = h('p', { class: 'ladder-summary' });
  function emit() {
    paintSummary();
    onChange(cloneEdit(rows));
  }
  function paintSummary() {
    const sorted = rows.filter((r) => /^\d+$/.test(String(r.at).trim())).slice().sort((a, b) => Number(a.at) - Number(b.at));
    if (!sorted.length) {
      summary.textContent = 'Warnings never lead to anything automatic.';
      return;
    }
    summary.textContent = sorted.map((r) => {
      const a = STEP_ACTIONS.find((x) => x.value === r.action);
      const what = r.action === 'timeout' ? `${r.duration || '?'} timeout` : (a ? a.label.toLowerCase() : r.action);
      return `${r.at} warning${Number(r.at) === 1 ? '' : 's'} → ${what}`;
    }).join('  ·  ');
  }
  function draw(focusLast = false) {
    if (!rows.length) {
      replace(list, h('li', { class: 'ladder-empty' }, h('span', { class: 'ladder-empty-icon', text: '⚖️', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'No automatic steps. Add one to time out, kick or ban people who keep getting warned.' })));
    } else {
      replace(list, ...rows.map((r, i) => {
        const at = smallNumber({ value: r.at, label: `Warnings for step ${i + 1}`, min: 1, max: 100, onInput: (v) => { rows[i] = { ...rows[i], at: v }; emit(); } });
        const dur = durationPicker({ presets: TIMEOUT_PRESETS, value: r.duration || '1h', label: `Timeout length for step ${i + 1}`, onChange: (v) => { rows[i] = { ...rows[i], duration: v }; emit(); } });
        const durWrap = h('div', { class: 'ladder-duration', hidden: r.action !== 'timeout' }, dur.el);
        const chips = STEP_ACTIONS.map((a) => {
          const b = h('button', { type: 'button', class: ['choice-chip', `tone-${a.value}`], dataset: { value: a.value }, attrs: { 'aria-pressed': r.action === a.value ? 'true' : 'false' } },
            h('span', { class: 'choice-chip-emoji', text: a.emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { text: a.label }));
          b.classList.toggle('is-active', r.action === a.value);
          b.addEventListener('click', () => {
            rows[i] = { ...rows[i], action: a.value, duration: a.value === 'timeout' ? (rows[i].duration || '1h') : '' };
            for (const c of chips) {
              const on = c.dataset.value === a.value;
              c.classList.toggle('is-active', on);
              c.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
            durWrap.hidden = a.value !== 'timeout';
            if (a.value === 'timeout') dur.set(rows[i].duration);
            emit();
          });
          return b;
        });
        return h('li', { class: 'ladder-row ladder-step' },
          h('span', { class: 'ladder-dot', attrs: { 'aria-hidden': 'true' } }),
          h('div', { class: 'ladder-step-main' },
            h('div', { class: 'ladder-step-top' },
              h('span', { class: 'ladder-text', text: 'At' }),
              at,
              h('span', { class: 'ladder-text', text: 'warnings' }),
              h('span', { class: 'ladder-arrow', attrs: { 'aria-hidden': 'true' } }, icon('arrow-right', { size: 14 })),
              h('div', { class: 'choice-chips', attrs: { role: 'group', 'aria-label': `What happens at step ${i + 1}` } }, ...chips)),
            durWrap),
          removeButton(`Remove step ${i + 1}`, () => { rows = rows.filter((_, j) => j !== i); emit(); draw(); addBtn.focus(); }));
      }));
    }
    addBtn.disabled = rows.length >= 20;
    if (focusLast) list.querySelector('.ladder-row:last-child .row-number')?.focus();
  }
  addBtn.addEventListener('click', () => {
    const top = rows.reduce((m, r) => Math.max(m, Number(r.at) || 0), 0);
    rows = [...rows, { at: String(Math.min(100, top ? top + 2 : 3)), action: top ? 'kick' : 'timeout', duration: top ? '' : '1h' }];
    emit();
    draw(true);
  });
  draw();
  paintSummary();
  return {
    el: h('div', { class: 'row-editor' }, summary, list, h('div', { class: 'add-row-bar' }, addBtn)),
    setValue(v) {
      rows = cloneEdit(v);
      draw();
      paintSummary();
    },
    setInvalid(v) {
      list.classList.toggle('is-invalid', Boolean(v));
    },
  };
}

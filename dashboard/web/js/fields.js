import { h, nextId, replace } from './dom.js';
import { icon } from './icons.js';
import { picker } from './picker.js';
import { switchControl } from './ui.js';
import { addWord, channelMatches, describeReadOnly, wordLimit } from './forms.js';
import { toHexColor } from './format.js';
import { choiceRows, messagePreview, numberSlider, optionCards, pickerRows, placeholderChips, placeholdersIn, rewardsEditor, stepsEditor, toggleGrid } from './settings-editors.js';

const ROLE_REASON = "YapOS can't give this role. Move YapOS's role above it in your server settings.";

export function channelItems(lookups, fieldType) {
  const list = Array.isArray(lookups?.channels) ? lookups.channels : [];
  const categories = new Map(list.filter((c) => c && c.id && String(c.kind ?? '').toLowerCase() === 'category').map((c) => [String(c.id), String(c.name ?? '')]));
  const items = list
    .filter((c) => c && c.id && channelMatches(fieldType === 'channels' ? 'channel' : fieldType, c))
    .map((c) => {
      const kind = String(c.kind ?? 'text').toLowerCase();
      const iconName = kind === 'category' ? 'folder' : (kind.includes('voice') || kind === 'stage') ? 'volume' : 'hash';
      const cat = c.category === null || c.category === undefined ? '' : String(c.category);
      const group = categories.get(cat) ?? (cat && !/^[0-9a-f-]{16,}$/i.test(cat) ? cat : '');
      return { id: String(c.id), label: String(c.name ?? c.id), icon: iconName, group };
    });
  const order = [];
  const byGroup = new Map();
  for (const item of items) {
    if (!byGroup.has(item.group)) {
      byGroup.set(item.group, []);
      order.push(item.group);
    }
    byGroup.get(item.group).push(item);
  }
  order.sort((a, b) => (a === '' ? -1 : b === '' ? 1 : 0));
  return order.flatMap((g) => byGroup.get(g));
}

export function roleItems(lookups) {
  const list = Array.isArray(lookups?.roles) ? lookups.roles : [];
  return list
    .filter((r) => r && r.id)
    .slice()
    .sort((a, b) => (Number(b.position) || 0) - (Number(a.position) || 0))
    .map((r) => ({
      id: String(r.id),
      label: String(r.name ?? r.id),
      color: toHexColor(r.color) && toHexColor(r.color) !== '#000000' ? toHexColor(r.color) : 'var(--text-3)',
      disabled: r.manageable === false,
      reason: r.manageable === false ? ROLE_REASON : '',
    }));
}

function counter(maxLength) {
  return maxLength ? h('span', { class: 'field-counter', attrs: { 'aria-hidden': 'true' } }) : null;
}

function updateCounter(el, value, maxLength) {
  if (!el) return;
  const len = Array.from(value || '').length;
  el.textContent = `${len}/${maxLength}`;
  el.classList.toggle('is-over', len > maxLength);
}

function tagInput({ value, onChange, inputId, labelId, describedBy, limit = null, placeholder = 'Type a word and press Enter' }) {
  let words = Array.isArray(value) ? value.slice() : [];
  const list = h('ul', { class: 'chip-list', attrs: { 'aria-label': 'Words' } });
  const input = h('input', { type: 'text', id: inputId, class: 'tag-input-field', placeholder, autocomplete: 'off', spellcheck: false, attrs: { 'aria-describedby': describedBy || null, 'aria-labelledby': labelId || null } });
  const count = limit ? h('span', { class: 'field-counter tag-counter', attrs: { 'aria-hidden': 'true' } }) : null;
  const wrap = h('div', { class: 'tag-input' }, list, input, count);
  function render() {
    if (count) {
      count.textContent = `${words.length}/${limit}`;
      count.classList.toggle('is-over', words.length > limit);
    }
    replace(list, ...words.map((w, i) => {
      const rm = h('button', { type: 'button', class: 'chip-remove', attrs: { 'aria-label': `Remove ${w}` } }, icon('x', { size: 12 }));
      rm.addEventListener('click', () => {
        words = words.filter((_, j) => j !== i);
        render();
        onChange(words.slice());
        input.focus();
      });
      return h('li', { class: 'chip' }, h('span', { class: 'chip-text', text: w }), rm);
    }));
    list.hidden = words.length === 0;
  }
  function commit() {
    if (!input.value.trim()) return false;
    const next = addWord(words, input.value);
    input.value = '';
    if (next.length !== words.length) {
      words = next;
      render();
      onChange(words.slice());
    }
    return true;
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      if (commit() || e.key === 'Enter') e.preventDefault();
    } else if (e.key === 'Backspace' && !input.value && words.length) {
      words = words.slice(0, -1);
      render();
      onChange(words.slice());
    }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (/[,\n]/.test(text)) {
      e.preventDefault();
      input.value = text;
      commit();
    }
  });
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) input.focus();
  });
  render();
  return {
    el: wrap,
    setValue(v) {
      words = Array.isArray(v) ? v.slice() : [];
      render();
    },
    setInvalid(v) {
      wrap.classList.toggle('is-invalid', Boolean(v));
    },
  };
}

function textControl(field, value, onChange, ids, context = {}) {
  const isArea = field.type === 'text';
  const names = field.type === 'string' || isArea ? placeholdersIn(field.help) : [];
  const preview = names.length ? messagePreview(context) : null;
  const maxLength = field.maxLength || null;
  const count = (field.type === 'string' || isArea) && maxLength ? counter(maxLength) : null;
  const attrs = { 'aria-describedby': ids.describedBy };
  let input;
  if (isArea) input = h('textarea', { id: ids.input, class: 'input textarea', rows: 4, value, attrs });
  else {
    input = h('input', {
      id: ids.input,
      type: 'text',
      class: 'input',
      value,
      autocomplete: 'off',
      spellcheck: field.type === 'string',
      placeholder: field.type === 'duration' ? 'e.g. 10m, 2h, 1d 12h' : field.type === 'emoji' ? 'e.g. ⭐ or :name:' : '',
      attrs,
    });
  }
  const lead = field.type === 'duration' ? icon('clock', { size: 14, className: 'input-lead' }) : field.type === 'emoji' ? icon('smile', { size: 14, className: 'input-lead' }) : null;
  const shell = h('div', { class: ['input-shell', lead ? 'has-lead' : '', isArea ? 'is-area' : '', field.type === 'emoji' ? 'input-narrow' : ''] }, lead, input, count);
  input.addEventListener('input', () => {
    updateCounter(count, input.value, maxLength);
    preview?.update(input.value);
    onChange(input.value);
  });
  updateCounter(count, value, maxLength);
  preview?.update(value);
  const chips = placeholderChips(names, (token) => {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.setRangeText(token, start, end, 'end');
    input.focus();
    input.dispatchEvent(new Event('input'));
  });
  return {
    el: preview ? h('div', { class: 'text-with-preview' }, shell, chips, preview.el) : shell,
    setValue(v) {
      input.value = v;
      updateCounter(count, v, maxLength);
      preview?.update(v);
    },
    setInvalid(v) {
      input.classList.toggle('is-invalid', Boolean(v));
      if (v) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    },
  };
}

function selectControl(field, value, onChange, ids) {
  const select = h('select', { id: ids.input, class: 'input select', attrs: { 'aria-describedby': ids.describedBy } });
  const values = field.options.map((o) => String(o.value));
  if (!values.includes(value)) select.appendChild(h('option', { value, text: value === '' ? 'Not set' : value }));
  for (const o of field.options) select.appendChild(h('option', { value: String(o.value), text: o.label }));
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return {
    el: h('div', { class: 'select-shell' }, select, icon('chevron-down', { size: 14, className: 'select-caret' })),
    setValue(v) {
      select.value = v;
    },
    setInvalid(v) {
      select.classList.toggle('is-invalid', Boolean(v));
    },
  };
}

function colorControl(field, value, onChange, ids) {
  const swatch = h('input', { type: 'color', class: 'color-swatch', value: value || '#f2613f', attrs: { 'aria-label': `${field.label} color picker` } });
  const text = h('input', { id: ids.input, type: 'text', class: 'input input-mono', value, placeholder: '#f2613f', maxLength: 7, autocomplete: 'off', spellcheck: false, attrs: { 'aria-describedby': ids.describedBy } });
  swatch.addEventListener('input', () => {
    text.value = swatch.value.toLowerCase();
    onChange(text.value);
  });
  text.addEventListener('input', () => {
    const v = text.value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(v)) swatch.value = v;
    onChange(v);
  });
  return {
    el: h('div', { class: 'color-field' }, swatch, h('div', { class: 'input-shell input-narrow' }, text)),
    setValue(v) {
      text.value = v;
      if (v) swatch.value = v;
    },
    setInvalid(v) {
      text.classList.toggle('is-invalid', Boolean(v));
    },
  };
}

function readOnlyControl(field, rawValue, lookups) {
  return {
    el: h('div', { class: 'readonly-field' },
      icon('lock', { size: 14 }),
      h('div', { class: 'readonly-text' },
        h('span', { class: 'readonly-value', text: describeReadOnly(field, rawValue, lookups) }),
        h('span', { class: 'readonly-note', text: field.note || 'This setting is managed with a command in your server.' }))),
    setValue() {},
    setInvalid() {},
  };
}

const CARD_SELECT_MAX = 4;

function cardSelect(field) {
  return field.options.length >= 2 && field.options.length <= CARD_SELECT_MAX && field.options.every((o) => String(o.label).length <= 28);
}

export function fieldRow(field, { edit, rawValue, lookups, onChange, context = {} }) {
  const ids = { input: nextId('f'), label: nextId('l'), help: nextId('h'), error: nextId('e') };
  ids.describedBy = [field.help ? ids.help : '', ids.error].filter(Boolean).join(' ');
  const errorEl = h('p', { class: 'field-error', id: ids.error, attrs: { 'aria-live': 'polite' } });
  const spanLabel = field.multi || field.editor || ['channel', 'voice_channel', 'category', 'role', 'boolean'].includes(field.type) || (field.type === 'select' && cardSelect(field));
  const labelEl = spanLabel || field.readOnly
    ? h('span', { class: 'field-label', id: ids.label, text: field.label })
    : h('label', { class: 'field-label', id: ids.label, htmlFor: ids.input, text: field.label });
  const helpEl = field.help ? h('p', { class: 'field-help', id: ids.help, text: field.help }) : null;
  let control;

  if (field.readOnly) control = readOnlyControl(field, rawValue, lookups);
  else if (field.editor) {
    const common = { field, value: edit, onChange, labelId: ids.label };
    if (field.editor === 'toggles') control = toggleGrid(common);
    else if (field.editor === 'choices') control = choiceRows(common);
    else if (field.editor === 'channelMap') control = pickerRows({ ...common, items: channelItems(lookups, 'channel'), kindLabel: 'channel' });
    else if (field.editor === 'roleMap') control = pickerRows({ ...common, items: roleItems(lookups), kindLabel: 'role' });
    else if (field.editor === 'rewards') control = rewardsEditor({ ...common, roleItems: roleItems(lookups) });
    else control = stepsEditor(common);
  } else {
    switch (field.type) {
      case 'boolean': {
        const sw = switchControl({ checked: edit === true, onChange: (v) => onChange(v) });
        sw.el.setAttribute('aria-labelledby', ids.label);
        if (field.help) sw.el.setAttribute('aria-describedby', ids.help);
        control = { el: sw.el, setValue: (v) => sw.set(v === true), setInvalid() {} };
        break;
      }
      case 'number':
        control = numberSlider({ field, value: edit, onChange, ids });
        break;
      case 'select':
        control = cardSelect(field) ? optionCards({ options: field.options, value: edit, onChange, labelId: ids.label }) : selectControl(field, edit, onChange, ids);
        break;
      case 'color':
        control = colorControl(field, edit, onChange, ids);
        break;
      case 'words':
        control = tagInput({ value: edit, onChange, inputId: ids.input, labelId: ids.label, describedBy: ids.describedBy, limit: wordLimit(field) });
        break;
      case 'channel':
      case 'voice_channel':
      case 'category':
      case 'channels': {
        const kindLabel = field.type === 'voice_channel' ? 'voice channel' : field.type === 'category' ? 'category' : 'channel';
        control = picker({ items: channelItems(lookups, field.type), value: edit, multi: field.multi, onChange, labelId: ids.label, describedBy: ids.describedBy, kindLabel, placeholder: `Choose a ${kindLabel}` });
        break;
      }
      case 'role':
      case 'roles':
        control = picker({ items: roleItems(lookups), value: edit, multi: field.multi, onChange, labelId: ids.label, describedBy: ids.describedBy, kindLabel: 'role', placeholder: 'Choose a role' });
        break;
      default:
        control = textControl(field, edit, onChange, ids, context);
    }
  }

  const head = h('div', { class: 'field-head' }, labelEl, field.readOnly ? h('span', { class: 'field-tag', text: 'Read-only' }) : null);
  let el;
  if (field.type === 'boolean' && !field.readOnly) {
    el = h('div', { class: 'field field-tile', dataset: { key: field.key } },
      h('div', { class: 'field-tile-top' }, h('span', { class: 'field-tile-icon', attrs: { 'aria-hidden': 'true' } }, icon('power', { size: 16 })), control.el),
      h('div', { class: 'field-text' }, head, helpEl, errorEl));
    el.addEventListener('click', (e) => {
      if (!control.el.contains(e.target) && !e.target.closest('a, button, input')) control.el.click();
    });
  } else if (field.editor || (field.type === 'text' && !field.readOnly)) {
    el = h('div', { class: 'field field-wide', dataset: { key: field.key } }, h('div', { class: 'field-text' }, head, helpEl), h('div', { class: 'field-control' }, control.el, errorEl));
  } else {
    el = h('div', { class: 'field', dataset: { key: field.key } }, h('div', { class: 'field-text' }, head, helpEl), h('div', { class: 'field-control' }, control.el, errorEl));
  }

  return {
    el,
    key: field.key,
    setValue: (v) => control.setValue(v),
    setError(msg) {
      errorEl.textContent = msg || '';
      el.classList.toggle('has-error', Boolean(msg));
      control.setInvalid?.(Boolean(msg));
    },
    setDirty(v) {
      el.classList.toggle('is-dirty', Boolean(v));
    },
    focus() {
      const target = el.querySelector('input:not([type=color]), textarea, select, button');
      target?.focus();
    },
  };
}

import { h, nextId, replace } from './dom.js';
import { icon } from './icons.js';

function matches(item, q) {
  if (!q) return true;
  const hay = `${item.label} ${item.group || ''} ${item.id}`.toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

function itemVisual(item, compact = false) {
  const lead = item.color
    ? h('span', { class: 'role-dot', style: { '--role-color': item.color } })
    : (item.icon ? icon(item.icon, { size: 14, className: 'picker-item-icon' }) : null);
  return h('span', { class: ['picker-item-main', compact ? 'is-compact' : ''] }, lead, h('span', { class: 'picker-item-label', text: item.label }));
}

export function picker({ items = [], value, multi = false, placeholder = 'Select…', onChange, labelId = '', describedBy = '', noneLabel = 'None', allowNone = true, kindLabel = 'item', disabled = false, invalid = false } = {}) {
  const listId = nextId('lb');
  const triggerId = nextId('pt');
  const byId = new Map(items.map((i) => [i.id, i]));
  let selected = multi ? (Array.isArray(value) ? value.slice() : []) : (value || '');
  let open = false;
  let active = -1;
  let visible = [];

  const wrap = h('div', { class: ['picker', multi ? 'picker-multi' : 'picker-single'] });
  const trigger = h('button', {
    type: 'button',
    class: ['picker-trigger', invalid ? 'is-invalid' : ''],
    id: triggerId,
    disabled,
    attrs: { 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-labelledby': labelId ? `${labelId} ${triggerId}` : null, 'aria-describedby': describedBy || null },
  });
  const chips = multi ? h('ul', { class: 'chip-list', attrs: { 'aria-label': `Selected ${kindLabel}s` } }) : null;
  const search = h('input', {
    type: 'text',
    class: 'picker-search',
    placeholder: `Search ${kindLabel}s`,
    autocomplete: 'off',
    spellcheck: false,
    attrs: { role: 'combobox', 'aria-controls': listId, 'aria-expanded': 'true', 'aria-autocomplete': 'list', 'aria-label': `Search ${kindLabel}s` },
  });
  const list = h('ul', { class: 'picker-list', id: listId, attrs: { role: 'listbox', 'aria-multiselectable': multi ? 'true' : null, 'aria-labelledby': labelId || null } });
  const pop = h('div', { class: 'picker-pop', hidden: true },
    h('div', { class: 'picker-search-wrap' }, icon('search', { size: 14 }), search),
    list);

  function isSelected(id) {
    return multi ? selected.includes(id) : selected === id;
  }

  function renderTrigger() {
    if (multi) {
      replace(trigger, icon('plus', { size: 14 }), h('span', { text: `Add ${kindLabel}` }));
      replace(chips, ...selected.map((id) => {
        const item = byId.get(id) || { id, label: `Unknown ${kindLabel}`, missing: true };
        const remove = h('button', { type: 'button', class: 'chip-remove', attrs: { 'aria-label': `Remove ${item.label}` }, disabled }, icon('x', { size: 12 }));
        remove.addEventListener('click', () => {
          selected = selected.filter((s) => s !== id);
          renderTrigger();
          onChange?.(selected.slice());
          trigger.focus();
        });
        return h('li', { class: ['chip', item.missing ? 'chip-missing' : ''] }, itemVisual(item, true), remove);
      }));
      chips.hidden = selected.length === 0;
      return;
    }
    const item = selected ? (byId.get(selected) || { id: selected, label: `Unknown ${kindLabel}`, missing: true }) : null;
    replace(trigger,
      item ? itemVisual(item) : h('span', { class: 'picker-placeholder', text: placeholder }),
      icon('chevrons-up-down', { size: 14, className: 'picker-caret' }));
  }

  function optionId(i) {
    return `${listId}-o${i}`;
  }

  function renderList() {
    const q = search.value.trim().toLowerCase();
    visible = [];
    if (!multi && allowNone && !q) visible.push({ id: '', label: noneLabel, none: true });
    for (const item of items) if (matches(item, q)) visible.push(item);
    const nodes = [];
    let lastGroup = null;
    visible.forEach((item, i) => {
      if (item.group && item.group !== lastGroup && !q) {
        nodes.push(h('li', { class: 'picker-group', attrs: { role: 'presentation' }, text: item.group }));
      }
      lastGroup = item.group || lastGroup;
      const sel = item.none ? selected === '' : isSelected(item.id);
      const li = h('li', {
        id: optionId(i),
        class: ['picker-option', item.disabled ? 'is-disabled' : '', i === active ? 'is-active' : '', item.none ? 'is-none' : ''],
        attrs: { role: 'option', 'aria-selected': sel ? 'true' : 'false', 'aria-disabled': item.disabled ? 'true' : null },
      },
      h('span', { class: 'picker-check' }, sel ? icon('check', { size: 14 }) : null),
      h('span', { class: 'picker-option-text' },
        item.none ? h('span', { class: 'picker-item-label picker-none', text: item.label }) : itemVisual(item),
        item.disabled && item.reason ? h('span', { class: 'picker-reason', text: item.reason }) : null));
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => choose(i));
      li.addEventListener('mousemove', () => {
        if (active !== i && !item.disabled) setActive(i, false);
      });
      nodes.push(li);
    });
    if (!visible.length) nodes.push(h('li', { class: 'picker-empty', attrs: { role: 'presentation' }, text: q ? `No ${kindLabel}s match “${search.value.trim()}”` : `No ${kindLabel}s available` }));
    replace(list, ...nodes);
    if (active >= 0 && active < visible.length) search.setAttribute('aria-activedescendant', optionId(active));
    else search.removeAttribute('aria-activedescendant');
  }

  function setActive(i, scroll = true) {
    active = i;
    for (const li of list.querySelectorAll('.picker-option')) li.classList.toggle('is-active', li.id === optionId(i));
    if (i >= 0) {
      search.setAttribute('aria-activedescendant', optionId(i));
      const el = list.querySelector(`#${CSS.escape(optionId(i))}`);
      if (el && scroll) el.scrollIntoView({ block: 'nearest' });
    } else search.removeAttribute('aria-activedescendant');
  }

  function move(delta) {
    if (!visible.length) return;
    let i = active;
    for (let n = 0; n < visible.length; n++) {
      i = (i + delta + visible.length) % visible.length;
      if (!visible[i].disabled) {
        setActive(i);
        return;
      }
    }
  }

  function choose(i) {
    const item = visible[i];
    if (!item || item.disabled) return;
    if (multi) {
      selected = isSelected(item.id) ? selected.filter((s) => s !== item.id) : selected.concat(item.id);
      active = i;
      renderTrigger();
      renderList();
      onChange?.(selected.slice());
      search.focus();
      return;
    }
    selected = item.none ? '' : item.id;
    renderTrigger();
    close(true);
    onChange?.(selected);
  }

  function onDocDown(e) {
    if (!wrap.contains(e.target)) close(false);
  }

  function openPop() {
    if (open || disabled) return;
    open = true;
    pop.hidden = false;
    wrap.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    search.value = '';
    active = -1;
    renderList();
    const current = visible.findIndex((v) => (v.none ? selected === '' : !multi && v.id === selected));
    if (current >= 0) setActive(current);
    else move(1);
    search.focus();
    document.addEventListener('mousedown', onDocDown, true);
  }

  function close(focusTrigger) {
    if (!open) return;
    open = false;
    pop.hidden = true;
    wrap.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDocDown, true);
    if (focusTrigger) trigger.focus();
  }

  trigger.addEventListener('click', () => (open ? close(true) : openPop()));
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openPop();
    }
  });
  search.addEventListener('input', () => {
    active = -1;
    renderList();
    move(1);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      active = -1;
      move(1);
    } else if (e.key === 'End') {
      e.preventDefault();
      active = 0;
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) choose(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  });

  if (multi) wrap.append(chips, h('div', { class: 'picker-anchor' }, trigger, pop));
  else wrap.append(h('div', { class: 'picker-anchor' }, trigger, pop));
  renderTrigger();

  return {
    el: wrap,
    focus: () => trigger.focus(),
    setValue(v) {
      selected = multi ? (Array.isArray(v) ? v.slice() : []) : (v || '');
      renderTrigger();
      if (open) renderList();
    },
    setInvalid(v) {
      trigger.classList.toggle('is-invalid', Boolean(v));
      if (v) trigger.setAttribute('aria-invalid', 'true');
      else trigger.removeAttribute('aria-invalid');
    },
  };
}

const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'type', 'name', 'id', 'placeholder', 'href', 'target', 'rel', 'tabIndex', 'htmlFor', 'readOnly', 'min', 'max', 'step', 'maxLength', 'autocomplete', 'spellcheck', 'hidden', 'src', 'alt', 'width', 'height', 'loading', 'decoding', 'title', 'inputMode', 'rows']);

export function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
  return parent;
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  return append(el, children);
}

export function applyProps(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'attrs') {
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined || v === null || v === false) continue;
        el.setAttribute(k, v === true ? '' : String(v));
      }
    } else if (key === 'on') {
      for (const [ev, fn] of Object.entries(value)) if (fn) el.addEventListener(ev, fn);
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) if (v !== undefined && v !== null) el.dataset[k] = String(v);
    } else if (key === 'style') {
      for (const [k, v] of Object.entries(value)) if (v !== undefined && v !== null) el.style.setProperty(k, String(v));
    } else if (PROP_KEYS.has(key)) el[key] = value;
    else el.setAttribute(key, String(value));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

let uid = 0;
export function nextId(prefix = 'y') {
  uid += 1;
  return `${prefix}-${uid}`;
}

export function focusFirst(container) {
  const el = container.querySelector('[autofocus], input:not([disabled]), button:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
  if (el) el.focus();
  return el;
}

export function focusable(container) {
  return Array.from(container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.hidden && el.offsetParent !== null);
}

export function trapFocus(container, event) {
  if (event.key !== 'Tab') return;
  const items = focusable(container);
  if (!items.length) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

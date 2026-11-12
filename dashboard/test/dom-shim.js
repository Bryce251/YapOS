export class FakeEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = Boolean(opts.bubbles);
    this.key = opts.key;
    this.button = 0;
    this.defaultPrevented = false;
    this.stopped = false;
    this.target = null;
    this.currentTarget = null;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.stopped = true;
  }
}

class FakeNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof FakeElement);
  }

  get isConnected() {
    let n = this;
    while (n) {
      if (n === globalThis.document) return true;
      n = n.parentNode;
    }
    return false;
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
    return node;
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(n) : n);
  }

  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...nodes);
  }

  contains(node) {
    let n = node;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    const text = String(value ?? '');
    if (text) this.appendChild(new FakeText(text));
  }

  addEventListener(type, fn) {
    if (!fn) return;
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    let n = this;
    while (n) {
      event.currentTarget = n;
      for (const fn of [...(n.listeners.get(event.type) || [])]) fn.call(n, event);
      if (!event.bubbles || event.stopped) break;
      n = n.parentNode;
    }
    return !event.defaultPrevented;
  }
}

class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.data = String(text);
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value ?? '');
  }
}

function makeClassList(el) {
  const read = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  const write = (list) => el.setAttribute('class', list.join(' '));
  return {
    add: (...names) => write([...new Set([...read(), ...names])]),
    remove: (...names) => write(read().filter((c) => !names.includes(c))),
    contains: (name) => read().includes(name),
    toggle(name, force) {
      const on = force === undefined ? !read().includes(name) : Boolean(force);
      if (on) this.add(name);
      else this.remove(name);
      return on;
    },
  };
}

function matchesCompound(el, compound) {
  const clean = compound.replace(/:not\([^)]*\)/g, '').replace(/::?[a-z-]+(\([^)]*\))?/g, '');
  const re = /([#.]?[A-Za-z0-9_-]+)|\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g;
  let m;
  let any = false;
  while ((m = re.exec(clean))) {
    any = true;
    if (m[1]) {
      const part = m[1];
      if (part.startsWith('#')) {
        if (el.id !== part.slice(1)) return false;
      } else if (part.startsWith('.')) {
        if (!el.classList.contains(part.slice(1))) return false;
      } else if (el.localName !== part.toLowerCase()) return false;
    } else {
      const name = m[2].trim();
      const attr = el.getAttribute(name);
      const prop = name in el ? el[name] : undefined;
      const value = attr !== null ? attr : prop === undefined || prop === null || prop === false ? null : String(prop);
      if (value === null) return false;
      if (m[3] !== undefined && value !== m[3]) return false;
    }
  }
  return any;
}

function matches(el, selector) {
  return selector.split(',').some((s) => {
    const parts = s.trim().match(/(?:\[[^\]]*\]|[^\s[])+/g) || [''];
    return matchesCompound(el, parts[parts.length - 1]);
  });
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } };
    this.classList = makeClassList(this);
    this.hidden = false;
    this.disabled = false;
    if (['input', 'textarea', 'select'].includes(this.localName)) this.value = '';
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  focus() {
    globalThis.document.activeElement = this;
  }

  blur() {
    if (globalThis.document.activeElement === this) globalThis.document.activeElement = globalThis.document.body;
  }

  click() {
    this.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  }

  setSelectionRange() {}

  scrollIntoView() {}

  get offsetParent() {
    return this.parentNode;
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (!(c instanceof FakeElement)) continue;
        if (matches(c, selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let n = this;
    while (n instanceof FakeElement) {
      if (matches(n, selector)) return n;
      n = n.parentNode;
    }
    return null;
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super('#document');
    this.body = new FakeElement('body');
    this.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tag) {
    return new FakeElement(tag);
  }

  createElementNS(ns, tag) {
    return new FakeElement(tag);
  }

  createTextNode(text) {
    return new FakeText(text);
  }

  execCommand() {
    return false;
  }
}

export function installDom({ url = 'https://dash.example.test/' } = {}) {
  const document = new FakeDocument();
  const location = new URL(url);
  const win = {
    location,
    history: {
      state: null,
      replaceState(state, title, next) {
        this.state = state;
        const u = new URL(next, location.origin);
        location.pathname = u.pathname;
        location.search = u.search;
      },
      pushState(state, title, next) {
        this.replaceState(state, title, next);
      },
    },
    isSecureContext: true,
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Node', { value: FakeNode, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: null }, configurable: true, writable: true });
  return { document, window: win };
}

export function type(input, text) {
  input.value = text;
  input.dispatchEvent(new FakeEvent('input', { bubbles: true }));
}

export function fire(el, name) {
  el.dispatchEvent(new FakeEvent(name, { bubbles: true }));
}

export async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

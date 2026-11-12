import { caseTypeLabel, toMillis } from './format.js';

function person(p) {
  if (p && typeof p === 'object') return { id: String(p.id ?? ''), name: String(p.name ?? p.username ?? p.id ?? 'Unknown') };
  if (typeof p === 'string' && p) return { id: p, name: p };
  return { id: '', name: 'Unknown' };
}

export function normalizeCase(c) {
  const raw = c && typeof c === 'object' ? c : {};
  const type = String(raw.type ?? 'note').toLowerCase();
  const user = person(raw.user);
  const mod = person(raw.mod);
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  const at = toMillis(raw.at);
  const n = Number.isFinite(Number(raw.n)) ? Number(raw.n) : 0;
  return {
    n,
    type,
    typeLabel: caseTypeLabel(type),
    user,
    mod,
    reason,
    at,
    duration: raw.duration ?? null,
    active: raw.active === true ? true : raw.active === false ? false : null,
    search: [`#${n}`, String(n), type, caseTypeLabel(type), user.name, user.id, mod.name, mod.id, reason].join('\n').toLowerCase(),
  };
}

export function normalizeCases(list) {
  return Array.isArray(list) ? list.map(normalizeCase) : [];
}

export function caseTypes(list) {
  const map = new Map();
  for (const c of list) if (!map.has(c.type)) map.set(c.type, c.typeLabel);
  return Array.from(map, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

export function filterCases(list, { q = '', type = '', status = '' } = {}) {
  const terms = String(q).toLowerCase().trim().split(/\s+/).filter(Boolean);
  return list.filter((c) => {
    if (type && c.type !== type) return false;
    if (status === 'active' && c.active !== true) return false;
    if (status === 'ended' && c.active === true) return false;
    for (const t of terms) {
      if (/^#\d+$/.test(t)) {
        if (`#${c.n}` !== t) return false;
      } else if (!c.search.includes(t)) return false;
    }
    return true;
  });
}

const SORTERS = {
  n: (a, b) => a.n - b.n,
  at: (a, b) => (a.at ?? 0) - (b.at ?? 0) || a.n - b.n,
  type: (a, b) => a.typeLabel.localeCompare(b.typeLabel) || b.n - a.n,
  user: (a, b) => a.user.name.localeCompare(b.user.name, undefined, { sensitivity: 'base' }) || b.n - a.n,
  mod: (a, b) => a.mod.name.localeCompare(b.mod.name, undefined, { sensitivity: 'base' }) || b.n - a.n,
};

export function sortCases(list, { key = 'n', dir = 'desc' } = {}) {
  const cmp = SORTERS[key] || SORTERS.n;
  const out = list.slice().sort(cmp);
  if (dir === 'desc') out.reverse();
  return out;
}

export function readCasesPage(data) {
  if (Array.isArray(data)) return { cases: data, more: false };
  const d = data && typeof data === 'object' ? data : {};
  const cases = Array.isArray(d.cases) ? d.cases : Array.isArray(d.items) ? d.items : [];
  const page = Number(d.page);
  const pages = Number(d.pages ?? d.totalPages);
  let more = d.more === true || d.hasMore === true || (d.next !== undefined && d.next !== null && d.next !== false);
  const knownPages = Number.isFinite(page) && Number.isFinite(pages);
  if (!more && knownPages) more = page < pages;
  if (!more && !knownPages && Number.isFinite(Number(d.total)) && cases.length) {
    const size = Number(d.pageSize ?? d.limit ?? cases.length);
    if (Number.isFinite(page) && size > 0) more = page * size < Number(d.total);
  }
  return { cases, more, total: Number.isFinite(Number(d.total)) ? Number(d.total) : null };
}

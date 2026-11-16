import { censor } from './filter.js';

const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;
const MENTION = /<[@#][!&]?[\w-]+>|@(?:everyone|here)\b/gi;

function tidy(raw) {
  return String(raw ?? '')
    .replace(CONTROL, '')
    .replace(LINK, '🔗')
    .replace(MENTION, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('').trim() : text;
}

export function cleanText(raw, max = 80) {
  return clip(tidy(raw), max);
}

export function cleanShared(raw, max = 80) {
  return censor(clip(censor(tidy(raw)).text, max)).text;
}

export function hidesWords(raw) {
  return censor(tidy(raw)).changed;
}

export function plainKey(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function editDistance(a, b, cap = 3) {
  const s = String(a);
  const t = String(b);
  if (Math.abs(s.length - t.length) > cap) return cap + 1;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = [i];
    let best = cur[0];
    for (let j = 1; j <= t.length; j += 1) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[t.length];
}

export function closeEnough(guess, answers, { slack } = {}) {
  const g = plainKey(guess);
  if (!g) return false;
  for (const a of [].concat(answers || [])) {
    const k = plainKey(a);
    if (!k) continue;
    if (g === k) return true;
    const allow = slack ?? (k.length >= 12 ? 2 : k.length >= 6 ? 1 : 0);
    if (allow && editDistance(g, k, allow) <= allow) return true;
  }
  return false;
}

export const PATTERN_MAX = 50;
export const PATTERN_CHARS = 120;
export const PATTERN_FLAGS = 'iu';
export const PATTERN_REPEAT_MAX = 50;
export const PATTERN_TEXT_MAX = 2000;
export const PATTERN_WINDOW = 256;
export const PATTERN_OVERLAP = 64;
export const PATTERN_TRIAL_MS = 150;

const LOOSE_REPEAT = 10;
const LOOSE_MAX = 8;
const SMALL_CLASS = 8;

function problem(code, message) {
  return { code, message };
}

function readCount(src, i) {
  const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
  return { min, max, len: m[0].length };
}

const ALL = { all: true };

export function foldChar(ch) {
  return String(ch).toLowerCase().toUpperCase().toLowerCase();
}

function single(ch) {
  return { all: false, chars: new Set([foldChar(ch)]) };
}

function overlaps(a, b) {
  if (a.all || b.all) return true;
  for (const c of a.chars) if (b.chars.has(c)) return true;
  return false;
}

function readClass(src, i) {
  let j = i + 1;
  const negated = src[j] === '^';
  if (negated) j += 1;
  const chars = new Set();
  let broad = negated;
  while (j < src.length && src[j] !== ']') {
    const c = src[j];
    if (c === '\\') {
      const e = src[j + 1] || '';
      if (/[a-z0-9]/i.test(e)) broad = true;
      else chars.add(e);
      if (e === 'p' || e === 'P' || (e === 'u' && src[j + 2] === '{')) {
        const close = src.indexOf('}', j);
        j = close < 0 ? src.length : close + 1;
      } else if (e === 'u') j += 6;
      else if (e === 'x') j += 4;
      else if (e === 'c') j += 3;
      else j += 2;
      continue;
    }
    if (c === '-' && chars.size > 0 && src[j + 1] !== ']') broad = true;
    const ch = Array.from(src.slice(j, j + 2))[0];
    chars.add(foldChar(ch));
    j += ch.length;
  }
  if (chars.size > SMALL_CLASS) broad = true;
  return { end: j + 1, set: broad ? ALL : { all: false, chars } };
}

export function shapeProblem(src) {
  const stack = [{ quant: false, alt: false, look: false, run: [] }];
  const count = { loose: 0, broad: 0 };
  let pending = null;
  let err = null;

  const finalize = (atom, q) => {
    const frame = stack[stack.length - 1];
    if (q) {
      if (q.min > PATTERN_REPEAT_MAX || (q.max !== Infinity && q.max > PATTERN_REPEAT_MAX)) return problem('big_repeat', `Counted repeats can go up to {${PATTERN_REPEAT_MAX}}. Use + for "one or more" instead.`);
      if (atom.group && q.max > 1) {
        if (atom.group.quant) return problem('nested', 'A repeated group can\'t have repeats inside it, like (a+)+. That can freeze the filter. Repeat the letters inside instead.');
        if (atom.group.alt) return problem('alt_repeat', 'A repeated group can\'t have | choices inside it, like (a|b)+. Use a set like [ab]+ instead.');
      }
      frame.quant = true;
      if (q.max > LOOSE_REPEAT) {
        count.loose += 1;
        if (atom.set.all) count.broad += 1;
        if (count.broad > 1) return problem('broad_repeat', 'Only one wide repeat like .* , \\w+ or [a-z]+ is allowed in a pattern.');
        if (count.loose > LOOSE_MAX) return problem('many_repeats', `Use at most ${LOOSE_MAX} open-ended repeats like + or * in one pattern.`);
      }
    }
    const repeated = (q && q.max > 1) || Boolean(atom.group && atom.group.quant);
    if (repeated) {
      if (frame.run.some((s) => overlaps(s, atom.set))) return problem('overlap', 'Two repeats that can match the same letters sit next to each other, like a+a+ or \\w+.*. That can freeze the filter. Merge them into one.');
      if (q && q.min > 0 && !frame.run.some((s) => overlaps(s, atom.set))) frame.run = [];
      frame.run.push(atom.set);
    } else if (!q || q.min > 0) {
      if (!frame.run.some((s) => overlaps(s, atom.set))) frame.run = [];
    }
    return null;
  };
  const flush = () => {
    if (pending) err = finalize(pending, null);
    pending = null;
    return err;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const e = src[i + 1];
      if (e >= '1' && e <= '9') return problem('backref', 'Back-references like \\1 are not allowed. Write the letters out instead.');
      if (e === 'k' && src[i + 2] === '<') return problem('backref', 'Named back-references like \\k<name> are not allowed.');
      if (flush()) return err;
      if (e === 'b' || e === 'B') {
        i += 2;
        continue;
      }
      if (e === 'p' || e === 'P' || (e === 'u' && src[i + 2] === '{')) {
        const close = src.indexOf('}', i);
        pending = { set: ALL, group: null };
        i = close < 0 ? src.length : close + 1;
        continue;
      }
      pending = { set: /[a-z0-9]/i.test(e) ? ALL : single(e), group: null };
      i += e === 'u' ? 6 : e === 'x' ? 4 : e === 'c' ? 3 : 2;
      continue;
    }
    if (c === '[') {
      if (flush()) return err;
      const cls = readClass(src, i);
      pending = { set: cls.set, group: null };
      i = cls.end;
      continue;
    }
    if (c === '(') {
      if (src.startsWith('(?<=', i) || src.startsWith('(?<!', i)) return problem('lookbehind', 'Look-behinds like (?<=...) are not allowed.');
      if (flush()) return err;
      let skip = 1;
      let look = false;
      if (src.startsWith('(?:', i)) skip = 3;
      else if (src.startsWith('(?=', i) || src.startsWith('(?!', i)) {
        skip = 3;
        look = true;
      } else if (src.startsWith('(?<', i)) {
        const close = src.indexOf('>', i);
        skip = close < 0 ? src.length - i : close - i + 1;
      } else if (src[i + 1] === '?') return problem('bad_group', 'That kind of group is not supported. Use (...) or (?:...).');
      stack.push({ quant: false, alt: false, look, run: [] });
      i += skip;
      continue;
    }
    if (c === ')') {
      if (flush()) return err;
      if (stack.length < 2) return problem('bad_pattern', 'That pattern has a ) without a matching (.');
      const done = stack.pop();
      if (done.quant) stack[stack.length - 1].quant = true;
      pending = done.look ? null : { set: ALL, group: done };
      i += 1;
      continue;
    }
    if (c === '|') {
      if (flush()) return err;
      const top = stack[stack.length - 1];
      top.alt = true;
      top.run = [];
      i += 1;
      continue;
    }
    if (c === '^' || c === '$') {
      if (flush()) return err;
      i += 1;
      continue;
    }
    let q = null;
    if (c === '*') q = { min: 0, max: Infinity, len: 1 };
    else if (c === '+') q = { min: 1, max: Infinity, len: 1 };
    else if (c === '?') q = { min: 0, max: 1, len: 1 };
    else if (c === '{') q = readCount(src, i);
    if (q) {
      if (!pending) return problem('bad_pattern', 'A repeat like *, + or {2} needs something in front of it.');
      const bad = finalize(pending, q);
      if (bad) return bad;
      pending = null;
      i += q.len;
      if (src[i] === '?') i += 1;
      continue;
    }
    if (flush()) return err;
    const ch = Array.from(src.slice(i, i + 2))[0];
    pending = { set: c === '.' ? ALL : single(ch), group: null };
    i += ch.length;
  }
  if (flush()) return err;
  if (stack.length > 1) return problem('bad_pattern', 'That pattern has a ( without a matching ).');
  return null;
}

export function compilePattern(src) {
  try {
    return new RegExp(src, `g${PATTERN_FLAGS}`);
  } catch {
    return null;
  }
}

function zeroWidth(src) {
  const re = compilePattern(src);
  if (!re) return false;
  const text = 'Hello world, the quick brown fox jumps over a lazy dog. 1234567890 ';
  let m = re.exec(text);
  while (m) {
    if (!m[0].length) return true;
    re.lastIndex = m.index + m[0].length;
    m = re.exec(text);
  }
  return false;
}

export function patternProblem(src) {
  if (typeof src !== 'string' || !src.trim()) return problem('bad_pattern', 'Type a pattern first.');
  if (Array.from(src).length > PATTERN_CHARS) return problem('too_long', `Keep patterns under ${PATTERN_CHARS} characters.`);
  let re;
  try {
    re = new RegExp(src, PATTERN_FLAGS);
  } catch (err) {
    const why = String((err && err.message) || '').replace(/^Invalid regular expression: \/.*\/[a-z]*: /, '').slice(0, 80);
    return problem('bad_pattern', `That isn't a valid pattern${why ? ` (${why})` : ''}.`);
  }
  const shape = shapeProblem(src);
  if (shape) return shape;
  if (re.test('') || zeroWidth(src)) return problem('matches_empty', 'That pattern matches empty text, so it would hide everything. Make it need at least one letter.');
  return null;
}

export function windowSpans(re, text, push) {
  const s = String(text ?? '').slice(0, PATTERN_TEXT_MAX);
  const step = PATTERN_WINDOW - PATTERN_OVERLAP;
  const half = PATTERN_OVERLAP / 2;
  for (let from = 0; from < s.length; from += step) {
    const part = s.slice(from, from + PATTERN_WINDOW);
    const last = from + PATTERN_WINDOW >= s.length;
    const hi = last ? part.length : PATTERN_WINDOW - half;
    re.lastIndex = from ? half : 0;
    let m = re.exec(part);
    while (m && m.index < hi) {
      if (m[0].length) push(from + m.index, from + m.index + m[0].length);
      re.lastIndex = m.index + Math.max(1, m[0].length);
      m = re.exec(part);
    }
    if (last) break;
  }
}

export function trialTexts(src) {
  const letters = [...new Set(String(src).toLowerCase().replace(/\\[a-z]/g, '').replace(/[^a-z0-9]/g, ''))].slice(0, 6);
  const seeds = ['a', '1', ' ', 'x', '.', 'é', ...letters];
  const out = [];
  for (const ch of seeds) {
    out.push(`${ch.repeat(PATTERN_TEXT_MAX - 1)}!`);
    out.push(`${`${ch} `.repeat(PATTERN_TEXT_MAX / 2 - 1)}!`);
  }
  if (letters.length > 1) out.push(`${letters.join('').repeat(Math.ceil(PATTERN_TEXT_MAX / letters.length)).slice(0, PATTERN_TEXT_MAX - 1)}!`);
  out.push('ab1 '.repeat(PATTERN_TEXT_MAX / 4));
  return out;
}

export function trialRun(re, src, now = () => Date.now(), budget = PATTERN_TRIAL_MS) {
  const start = now();
  for (const text of trialTexts(src)) {
    windowSpans(re, text, () => {});
    if (now() - start > budget) return false;
  }
  return now() - start <= budget;
}

const SHIFT = 7;
const STEP = 3;
const MAX_SPAN = 16;
const MAX_JOIN = 64;
const MARK = '■';

export const HIDDEN_NOTE = 'Some words were hidden.';
export const BLOCKED_NOTE = 'That word isn’t allowed here.';

const WORDS = [
  'ust(?:i|t|wr|ce|is|oym|xr|dxb|gg|mmq|vl|brf)?', 'ustweasu?', 'qstquknu?', 'jybdl?', 'kkea(?:r|ed|kja)', 'wspatjhps(?:g|tsj)',
  'zrrrhkmu?', 'zrvjlghpx?', 'jrvdd(?:o|x|kja)?', 'nybal?', 'gscfxnggfld?', 'qkci?', 'jrvdti(?:z|g)s', 'zzvsl?', 'dogrtyju?',
  'iondxnr?', 'wkxyl?', 'yktxxwcu?', 'ayjueddcia?', 'rsxul?', 'fsqi?', 'oorrl?', 'yoqidemu?', 'pxwkgo?', 'zahqpo?', 'dyci?',
  'kkt(?:e|ho|ngx)', 'dyti?', 'nyybbsnix?', 'nicel?', 'wsxuro?', 'wyyqvgr?', 'oyaa(?:r|ax|kja|pmj)', 'iybdzo?', 'mkt(?:i|zu|nv|tbd)?',
  'kixul?', 'abndg(?:u|hg|nmd)', 'abbego?', 'zrrcthdu?', 'wybvmaqu?', 'ikgjrxnax?', 'ikgjri(?:z|g)s', 'yogqkz(?:r|gi|w|zg)?', 'aketl?',
  'zznp(?:xo|df|nvr|m)?', 'tyawhhnkia?', 'rif', 'oyyeakzz', 'usorto?',
];

const PHRASES = [
  'wyesainppmjg?', 'qeaweaawsv(?:j|wvm)', 'tybdvnhepmeg?', 'zvndmaxgx?', 'jrvdzygqso', 'jkzuefnepmjg?', 'meqwxlzepmcg?',
  '(?:zsrw|lahi|eqpu)yyfl', 'oovbaesnjz', 'osgbxn(?:vcx|qd)fzaet', 'osgbxnckivzhyckgzxxzv', 'drvjxlnyjz', 'drvjxlqkimhcifawljn',
  '(?:nkf|abh|dzymcazhxth|rhzrz|cyok)(?:hvy)?(?:ey)?(?:pgg)?(?:omhg|bchev|mjkh|xvet|jhqtemo|anfkvg|ecdghxb|yjkggnw|hbnrl|wrkfvd|avrfcdtb|ubedeseudf|jkwmu|yzlbecbs|tanqgk|cmnszokkthr|ymqesj|werlycupfn|eztzsri|kaewlmpg)',
  'konjapn(?:cqt)?(?:evv)?(?:dbwv|qrwtk|byzw|mkti|ywfitbd|pcuzkv|trsvwmq|nyzvvcl|wqcga|lgzuks|pkgursiq|jqtsthtjsu|yzlbj|noaqtrqh|ipcfvz|rbchodzziwg|nbfthy|ltganrjeuc|toiohgx|zptlabev)',
  '(?:arr)?xhhnefcdh(?:eyseu|jrpcl|ygervd)uqildp(?:jl)?', '(?:arr)?xhhnefcdh(?:zm|tav)(?:g)?(?:uut|zjyy|qfdu|vtgd)', '(?:zsk|w)feknnwykrmkthtxgvz',
  '(?:rsy|xtjf|pjkv|ieuiiyk|nzs)(?:qjss|yy|ib|ohq)(?:rgqn|dscpbs|vrnr)', 'kbvddxkgfks', 'zvvj(?:rktt|zz)hfzmqs?',
];

const STEMS = ['ustw', 'usdg', 'mktw', 'mkdg', 'wrnwz'];

const ALLOW = ['zxvwz', 'ustwea', 'ustweemi', 'ustweu', 'ustwtnc', 'ustwnj', 'yoayz', 'kyjdeefi', 'mktwxz', 'mktwbjf', 'mktwhphpl'];

const EXACT = ['mktem', 'mktemo', 'mktemp'];

const NEXT = ['jrvddo?(?:hp|tn)', 'oyaa(?:r|ax|kja|pmj)nlnny?'];

const SAFE = new Set(['woops', 'jaap', 'pollack', 'pollacks', 'darkle', 'darkles', 'darkled', ...EXACT.map((x) => decodeTerm(x))]);

const TAILS = /^(?:a|ah|as|az|uh|er|ers|ot|ots|it|its|et|ets|y|s|z)$/;

const NUMBERS = /(?<![0-9])14[/\\|]?88(?![0-9])/g;

const ZERO = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/;
const SPACE = /\s/;
const COMBINING = /\p{M}/u;
const QUOTES = new Set(["'", '’', '‘', 'ʼ', '`', '´', '-', '‐', '‑']);

const LEET = {
  0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g',
  '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't', '€': 'e', '¡': 'i',
};

const LOOKS = {
  а: 'a', в: 'b', е: 'e', ё: 'e', і: 'i', ї: 'i', к: 'k', м: 'm', н: 'h', о: 'o', п: 'n', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  ш: 'w', ѕ: 's', ј: 'j', ԁ: 'd', ӏ: 'l', ɡ: 'g', α: 'a', β: 'b', γ: 'y', δ: 'd', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o',
  ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w', ς: 's', ı: 'i', ł: 'l', ø: 'o', đ: 'd', ħ: 'h', ŋ: 'n', ß: 'ss', æ: 'ae', œ: 'oe', þ: 'p',
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ʀ: 'r',
  ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
};

function rotate(text, dir) {
  let i = 0;
  return String(text ?? '').replace(/[a-z]/g, (c) => {
    const n = (c.charCodeAt(0) - 97 + dir * (SHIFT + STEP * i)) % 26;
    i += 1;
    return String.fromCharCode(97 + ((n + 26) % 26));
  });
}

export function encodeTerm(text) {
  return rotate(text, 1);
}

export function decodeTerm(text) {
  return rotate(text, -1);
}

function compile(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c >= 'a' && c <= 'z') {
      let j = i;
      while (src[j] === c) j += 1;
      const k = j - i;
      const cls = c === 'i' || c === 'l' ? '[il]' : c;
      let atom = k > 1 ? `${cls}{${k},}` : `${cls}+`;
      if (src[j] === '?' || src[j] === '*') atom = `(?:${atom})`;
      out += atom;
      i = j;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function anchored(list) {
  return new RegExp(`^(?:${list.map((x) => compile(decodeTerm(x))).join('|')})$`);
}

const WORD_RE = anchored(WORDS);
const PHRASE_RE = anchored(PHRASES);
const STEM_RE = new RegExp(STEMS.map((x) => compile(decodeTerm(x))).join('|'), 'g');
const ALLOW_RES = ALLOW.map((x) => new RegExp(compile(decodeTerm(x)), 'g'));
const NEXT_RE = anchored(NEXT);
const LEAD_RE = new RegExp(`^(?:${STEMS.map((x) => compile(decodeTerm(x))).join('|')})`);

function covered(s, a, b) {
  for (const re of ALLOW_RES) {
    re.lastIndex = 0;
    let m = re.exec(s);
    while (m) {
      if (m.index <= a && m.index + m[0].length >= b) return true;
      re.lastIndex = m.index + 1;
      m = re.exec(s);
    }
  }
  return false;
}

function stemHit(s, lo = s.length, hi = 0) {
  STEM_RE.lastIndex = 0;
  let m = STEM_RE.exec(s);
  while (m) {
    const end = m.index + m[0].length;
    if (m.index < lo && end > hi && !covered(s, m.index, end)) return true;
    STEM_RE.lastIndex = m.index + 1;
    m = STEM_RE.exec(s);
  }
  return false;
}

function split(joined, tail) {
  const m = LEAD_RE.exec(joined);
  if (!m || !/^[a-z]+$/.test(joined) || covered(joined, 0, m[0].length)) return false;
  return m[0].length > tail || (m[0].length === tail && TAILS.test(joined.slice(tail)));
}

function mapChar(ch) {
  if (ZERO.test(ch)) return { kind: 'skip', out: '' };
  if (SPACE.test(ch)) return { kind: 'space', out: '' };
  if (COMBINING.test(ch)) return { kind: 'skip', out: '' };
  if (QUOTES.has(ch)) return { kind: 'join', out: '' };
  const lower = ch.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEET, lower)) return { kind: 'leet', out: LEET[lower] };
  const base = lower.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  let out = '';
  for (const c of base) {
    if (c >= 'a' && c <= 'z') out += c;
    else if (Object.prototype.hasOwnProperty.call(LOOKS, c)) out += LOOKS[c];
    else if (Object.prototype.hasOwnProperty.call(LEET, c)) out += LEET[c];
  }
  if (out) return { kind: 'letter', out };
  return { kind: 'other', out: '' };
}

function chars(text) {
  const out = [];
  let at = 0;
  for (const ch of text) {
    out.push({ ch, s: at, e: at + ch.length, m: mapChar(ch) });
    at += ch.length;
  }
  return out;
}

function tokenize(list, splitOther, keepLeet) {
  const tokens = [];
  let cur = null;
  const close = () => {
    if (cur && cur.text) tokens.push(cur);
    cur = null;
  };
  for (const c of list) {
    const k = c.m.kind;
    if (k === 'skip' || k === 'join') continue;
    if (k === 'space' || (k === 'other' && splitOther)) {
      close();
      continue;
    }
    if (k === 'other') continue;
    if (k === 'leet' && !keepLeet) continue;
    if (!cur) cur = { text: '', start: c.s, end: c.e };
    cur.text += c.m.out;
    cur.end = c.e;
  }
  close();
  return tokens;
}

function scan(tokens, hits) {
  const n = tokens.length;
  for (let i = 0; i < n; i += 1) {
    let joined = '';
    let head = 0;
    let short = true;
    let single = false;
    for (let j = i; j < n && j - i < MAX_SPAN; j += 1) {
      const t = tokens[j].text;
      const tail = joined.length;
      joined += t;
      if (j === i) head = t.length;
      if (joined.length > MAX_JOIN) break;
      if (t.length > 2) short = false;
      if (t.length === 1) single = true;
      const count = j - i + 1;
      const tight = count === 1 || (short && (count >= 3 || single));
      if (PHRASE_RE.test(joined)) {
        hits.push([tokens[i].start, tokens[j].end]);
      } else if (count === 1 && j + 1 < n && NEXT_RE.test(joined + tokens[j + 1].text)) {
        continue;
      } else if (count > 1 && count <= 3 && split(joined, tail)) {
        hits.push([tokens[i].start, tokens[j].end]);
      } else if (tight && !SAFE.has(joined) && (WORD_RE.test(joined) || stemHit(joined, head, count === 1 ? 0 : tail))) {
        let k = j;
        if (count > 1) while (k + 1 < n && tokens[k + 1].text.length === 1) k += 1;
        hits.push([tokens[i].start, tokens[k].end]);
      }
    }
  }
}

function overlaps(list, a, b) {
  return list.some(([x, y]) => a < y && x < b);
}

function merge(ranges) {
  const sorted = ranges.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function extend(text, end) {
  let at = end;
  while (at < text.length) {
    const cp = text.codePointAt(at);
    const ch = String.fromCodePoint(cp);
    if (!COMBINING.test(ch) && !ZERO.test(ch)) break;
    at += ch.length;
  }
  return at;
}

export function normalizeForFilter(raw) {
  const list = chars(String(raw ?? ''));
  let text = '';
  for (const c of list) {
    const k = c.m.kind;
    if (k === 'skip' || k === 'join') continue;
    if (k === 'letter' || k === 'leet') text += c.m.out;
    else text += ' ';
  }
  text = text.replace(/([a-z])\1+/g, '$1').replace(/\s+/g, ' ').trim();
  return { text, compact: text.replace(/[^a-z]/g, '') };
}

export function findBlocked(raw) {
  const text = String(raw ?? '');
  if (!text) return [];
  const list = chars(text);
  const fine = [];
  scan(tokenize(list, true, true), fine);
  scan(tokenize(list, true, false), fine);
  const loose = [];
  scan(tokenize(list, false, true), loose);
  scan(tokenize(list, false, false), loose);
  const hits = fine.concat(loose.filter(([a, b]) => !overlaps(fine, a, b)));
  NUMBERS.lastIndex = 0;
  let m = NUMBERS.exec(text);
  while (m) {
    hits.push([m.index, m.index + m[0].length]);
    m = NUMBERS.exec(text);
  }
  return merge(hits.map(([a, b]) => [a, extend(text, b)])).map(([start, end]) => ({ start, end, text: text.slice(start, end) }));
}

export function isBlockedWord(word) {
  const w = String(word ?? '').trim().toLowerCase();
  if (!w) return false;
  if (SAFE.has(w)) return false;
  if (/^[a-z]+$/.test(w)) return WORD_RE.test(w) || PHRASE_RE.test(w) || stemHit(w);
  return findBlocked(w).length > 0;
}

export function censor(raw) {
  const text = String(raw ?? '');
  const spans = findBlocked(text);
  if (!spans.length) return { text, changed: false };
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + MARK.repeat(Array.from(s.text).length);
    at = s.end;
  }
  return { text: out + text.slice(at), changed: true };
}

import { PATTERN_MAX, PATTERN_CHARS, compilePattern, patternProblem, windowSpans, trialRun } from './patterns.js';

export { PATTERN_MAX, PATTERN_CHARS };

const SHIFT = 7;
const STEP = 3;
const MAX_SPAN = 16;
const MAX_JOIN = 64;
const MARK = '■';

export const HIDDEN_NOTE = 'Some words were hidden.';
export const BLOCKED_NOTE = 'That word isn’t allowed here.';

const WORDS = [
  'ust(?:i|t|wr|ce|is|oym|xr|dxb|gg|mmq|vl|brf)?', 'ustweasu?', 'qstquknu?', 'jybdl?', 'kkea(?:r|ax|kj|qpg|vsp)', 'wspatjhps(?:g|tsj)',
  'zrrrhkmu?', 'zrvjlghpx?', 'jrvdd(?:o|x|kja|tsi|cbsw)?', 'nybal?', 'gscfxnggfld?', 'qkci?', 'jrvdti(?:z|g)s', 'zzvsl?', 'dogrtyju?',
  'iondxnr?', 'wkxyl?', 'yktxxwcu?', 'ayjueddcia?', 'rsxul?', 'fsqi?', 'oorrl?', 'yoqidemu?', 'pxwkgo?', 'zahqpo?', 'dyci?',
  'kkt(?:e|ho|ngx)', 'dyti?', 'nyybbsnix?', 'nicel?', 'wsxuro?', 'wyyqvgr?', 'oyaa(?:r|ax|kj|qpg|vsp)', 'iybdzo?',
  'mkt(?:i|zu|nv|tbd|wk|cqs|hz|nfh)?', 'kixul?', 'abndg(?:u|hg|nmd)', 'abbego?', 'zrrcthdu?', 'wybvmaqu?', 'ikgjrxnax?', 'ikgjri(?:z|g)s',
  'yogqkz(?:r|gi|w|zg)?', 'aketl?', 'zznp(?:xo|df|nvr|m)?', 'tyawhhnkia?', 'rif', 'oyyeakzz', 'usorto?', 'rksvbnr?', 'rksyko?', 'jksvkar?',
  'jybbbar?', 'dstwxnr?', 'nsapho?', 'iyukggr?', 'akvwl?', 'wybvmwgu?', 'wspstjhpx?', 'jrvdxar?', 'zzvwl?',
  'ykcu', 'ykcul', 'ykcuw', 'ykcygc', 'ykcylp', 'ykcylpr', 'tyyulp', 'tyyulpr',
  'tyyulpdf', 'tyyulpdt', 'tyyulpdtx', 'tyyulphpl', 'woqe', 'woqel', 'woqeidhnj', 'woqeidhnja',
  'woqeidhnni', 'wkrth', 'wkrtho', 'wkrthlgkqm', 'wkrthlgkqmd', 'drbhx', 'drbhxo', 'zvhj',
  'zvhjl', 'zvhjmu', 'zundd', 'zunddo', 'zunddu',
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

const NEXT = [
  'jrvddo?(?:hp|tn)', 'oyaa(?:r|ax|kj|qpg|vsp)trtte?', 'zzvsd?o?zpi',
];

const GAME = [
  'kspa(?:l|ddci|ppoum|tag|cjph|xvaf|mzr)?', 'jypa(?:l|ddci|ppoum|pufqnd|hmxifvz|chsdemi)?', 'asg(?:i|mu|skja|ewv)?', 'iybr(?:l|ed|kja)?',
  'wefi(?:r|edu)', 'jez(?:i|femi|rmo|gyiq|skuce|hdpr|tpbdf)?', 'oyed(?:r|edt|nmdh|zhbsv|ouk)',
  'zok(?:o|baq|kjae|wcs|fnhyb|f|ik|oce|xpxt|ul|ac|kso)?', 'hxnb(?:eu)?', 'hxhi(?:xo)?', 'hbfu(?:l|z|gqqm|sccyp)?',
  'isgsa(?:ar|a|nmc|wvmq|iqm|np|xfzqt)?', 'ietwxn(?:r|gi|qyu|p)?', 'ykc(?:u|xo|df|nvr|wjn|fswy|nk)', 'iyauko?', 'zundd(?:o|x)?', 'arbjl?',
  'vbt(?:o|bar|kfaewt)', 'zozug', 'zzrhfo?', 'zmeemqlu?', 'zmeemw', 'aofjbykgx?', 'jvvj(?:l|kqkx|wcwjyp|ougu)?', 'ceylt(?:o|d)?',
  'noaymwk(?:u|ni)?', 'wrnbe(?:qr|k|zapg|zw)', 'lbbjby(?:z|cq|iwzp|cpm|lyve)?', 'jyathir?', 'csnwkw', 'tsyvl?', 'ooajte', 'zwrwfw', 'xeruyo?',
  'moysa(?:ar|gi|qyu)?', 'zmubhjfu?', 'wopaxnr?', 'jybsa(?:ed|kja|j)?', 'wybdmwmi', 'korfmdqqfb', 'jbrqflhgx?', 'jepal?', 'aeetl?', 'zrnj',
  'q(?:oea|tyj)qknd?', 'ykhdvd(?:x|kjz|tsjn|flb|owqhk)?', 'iyetxhkqx?', 'ibbjaaku?', 'woeytjzn', 'iybwxnlcs', 'zxbw(?:l|cdf|lqyu)?',
  'uoth(?:h|kdu|ta|pgj|ypshy)', 'uotuk', 'teyqmpn(?:u|ja)?', 'zkzrho?', 'zrrug(?:u|hg|nmd)', 'iypxxo?', 'hlbi?', 'seohto?', 'zznimebu?',
  'rbnkmo?', 'uizfakr?',
  'hcf(?:ul|dzv|mieg|ncme|zoyqh)?', '(?:qkpa|wqld|xulfk|vxd|nolw|uso|jbvk)kfi(?:xo)?', 'ikfjtncu?', 'jbnf(?:iu|okjz|awvmq|phj|yucy|kcs|tlbf)?',
  'kkzd(?:l|es)?', 'kkzcbp', 'nyqtti(?:m|pjl|xwk)?', 'ayfixnr?', 'ioybxjcu?', 'tsawxo?', 'mkad(?:r|edu)', 'rxbraazfx?', 'ayqwxnr?', 'oybaxnr?',
  'wbbimeswy(?:m|pg|vx|fnj|oxz|xgiq)', 'wszf(?:l|ac|kso)?', 'ueq(?:u|xo|hvd|qdh|zmqs|lyv)', 'lbrsmenpx?', 'rsaa(?:r|edt|nmdh)',
  'mogyld(?:du|nax|wjgp|ivz|reik)?', 'iyattcd', 'areuxonoja?', 'myeuihza', 'weo(?:ul|eb|kx)', 'iegj(?:akkg|mwwsj|jiuj|vugvk)',
  'zwhj(?:l|px|vnmc|hzypt)?', 'sojt(?:eu|mgxa|pf|vmq)?', 'uyba(?:ba|x)', 'zrnw(?:l|cdf|lqyu|xyo|ghxb)?', 'zzhdd', 'qs(?:fc|si|rutu)', 'zzyehcd',
  'zdeqikmu?', 'skoy(?:t|ql)', 'tesvweugwa?', 'yszcbjf', 'msfjbjf', 'infc', 'okebhpr?', 'oefi(?:r|edu)', 'zvnfiaqu?', 'abbbekou?', 'zdekfldvx?',
  'mvbes(?:u|hg|nmd)', 'jepahhc(?:u|jl|tbx|lv)?', 'wk?rtho?', 'uscfear?', 'aofj(?:xo|hu)', 'zokfhpr?', 'hxvbbjfwx', 'oiz(?:yx|edu)',
  'som(?:pba|ykja|ko|qyo|br|hxe)', 'sofrho?', 'oyzel?', 'skqoukxu?', 'jrvdded',
];

const GAME_STEMS = [
  'mepa', 'zrvj', 'jeaj', 'agnj', 'dkaa', 'qsmp', 'ksyth', 'wyed', 'woayl', 'cktygw', 'tkfjnnacy', 'ltnsnhzv', 'ivbmcka', 'okatcka', 'yszzhx',
  'jypalqbm', 'drbhx', 'zvhj', 'iyybhyj', 'vbtqli', 'woqeidhn', 'wkrthlgkq', 'iofjbwkky', 'uophhlgkq', 'pxpulp', 'tyyulp', 'jeadbhhplcd',
  'moybtp', 'zyqef', 'hcfxhhd', 'wsfi', 'iexatgd', 'nkawuwmi', 'uizfaklcs',
];

const GAME_ALLOW = [
  'bcuym', 'vcuym', 'nkfxbp', 'uofxbp', 'lsfxbp', 'ycuym', 'tsfxbp', 'hcuym', 'yofxbpg', 'wofxbp', 'zrvjmwg', 'zrvjmel', 'agnjvd', 'agnjxn',
  'agnjmh', 'agnjmaq', 'zgndd', 'agndd', 'dkaatl', 'dkaaxh', 'dkaaea', 'dkaaee', 'dkaaeu', 'zzvil', 'uscylo', 'akcylo', 'wsfihz', 'wsfitooj',
  'wvnsnjs', 'woaylpn', 'woaylqk', 'wyedxor', 'hqnfhnm', 'lzbhges', 'pxiqzemc', 'lfnwbjz', 'cktygws', 'cktygwmv', 'moybtpz', 'pcbthi',
  'wcbthi', 'zvhjvd', 'zvhjaaq', 'vfrhlhtv', 'skcylo', 'zmhdmd',
];

const SAFE = new Set(['woops', 'woop', 'rapped', 'rapping', 'rapper', 'rappers', 'rappe', 'rappes', 'rappee', 'rappees', 'rappist', 'moiest', 'jaap', 'jaaps','pollack', 'pollacks', 'darkle', 'darkles', 'darkled', 'dike', 'dikes', 'diked', 'diking', ...EXACT.map((x) => decodeTerm(x))]);

const TIGHT = new Set(['rif']);

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

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

function loose(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c >= 'a' && c <= 'z') {
      let j = i;
      while (src[j] === c) j += 1;
      const k = j - i;
      let atom = VOWELS.has(c) ? `${c}{${k}}` : `${c}+`;
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

function fold(s) {
  return s.replace(/ph/g, 'ff').replace(/q/g, 'k').replace(/c(?![eiy])/g, 'k').replace(/y+/g, 'i').replace(/([aeiou])\1{2,}/g, '$1').replace(/(?<=[a-z]{3})z$/, 's');
}

function anchored(list) {
  return new RegExp(`^(?:${list.map((x) => compile(decodeTerm(x))).join('|')})$`);
}

const WORD_RE = anchored(WORDS);
const PHRASE_RE = anchored(PHRASES);
const VARIANT_RE = new RegExp(`^(?:${WORDS.filter((x) => !TIGHT.has(x)).map((x) => loose(fold(decodeTerm(x)))).join('|')})$`);
const STEM_RE = new RegExp(STEMS.map((x) => compile(decodeTerm(x))).join('|'), 'g');
const ALLOW_RES = ALLOW.map((x) => new RegExp(compile(decodeTerm(x)), 'g'));
const NEXT_RE = anchored(NEXT);
const LEAD_RE = new RegExp(`^(?:${STEMS.map((x) => compile(decodeTerm(x))).join('|')})`);
const FOLD_STEM_RE = new RegExp(STEMS.map(decodeTerm).filter((x) => !x.includes('q')).map((x) => compile(fold(x))).join('|'), 'g');
const FOLD_ALLOW_RES = ALLOW.map((x) => new RegExp(compile(fold(decodeTerm(x))), 'g'));
const GAME_RE = new RegExp(`^(?:${GAME.map(decodeTerm).join('|')})$`);
const GAME_STEM_RE = new RegExp(GAME_STEMS.map(decodeTerm).join('|'), 'g');
const GAME_ALLOW_RES = GAME_ALLOW.map((x) => new RegExp(decodeTerm(x), 'g'));

function variant(s) {
  const f = fold(s);
  return VARIANT_RE.test(f) || (f !== s && stemHit(f, f.length, 0, FOLD_STEM_RE, FOLD_ALLOW_RES));
}

function covered(s, a, b, allow = ALLOW_RES) {
  for (const re of allow) {
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

function stemHit(s, lo = s.length, hi = 0, re = STEM_RE, allow = ALLOW_RES) {
  re.lastIndex = 0;
  let m = re.exec(s);
  while (m) {
    const end = m.index + m[0].length;
    if (m.index < lo && end > hi && !covered(s, m.index, end, allow)) return true;
    re.lastIndex = m.index + 1;
    m = re.exec(s);
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
      } else if (tight && !SAFE.has(joined) && (WORD_RE.test(joined) || variant(joined) || stemHit(joined, head, count === 1 ? 0 : tail))) {
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
  if (customCompact.size) {
    const memo = new Map();
    for (const [split, leet] of [[true, true], [true, false], [false, true], [false, false]]) scanCustom(tokenize(list, split, leet), hits, memo);
  }
  if (customPatterns.length) patternSpans(list, text, customPatterns, hits);
  NUMBERS.lastIndex = 0;
  let m = NUMBERS.exec(text);
  while (m) {
    hits.push([m.index, m.index + m[0].length]);
    m = NUMBERS.exec(text);
  }
  return merge(hits.map(([a, b]) => [a, extend(text, b)])).map(([start, end]) => ({ start, end, text: text.slice(start, end) }));
}

function gameHit(word) {
  const w = /^[a-z]+$/.test(word) ? word : normalizeForFilter(word).compact;
  if (!w) return false;
  return GAME_RE.test(w) || stemHit(w, w.length, 0, GAME_STEM_RE, GAME_ALLOW_RES);
}

export function isBlockedWord(word, { strict = false } = {}) {
  const w = String(word ?? '').trim().toLowerCase();
  if (!w) return false;
  if (strict && gameHit(w)) return true;
  if (customCompact.size && hasCustom(w)) return true;
  if (customPatterns.length && patternSpans(chars(w), w).length) return true;
  if (SAFE.has(w)) return false;
  if (/^[a-z]+$/.test(w)) return WORD_RE.test(w) || PHRASE_RE.test(w) || variant(w) || stemHit(w);
  return findBlocked(w).length > 0;
}

export function isBlockedGameWord(word) {
  return isBlockedWord(word, { strict: true });
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

export const CUSTOM_MAX = 500;
export const CUSTOM_CHARS = 40;
export const CUSTOM_INSIDE = 6;

let customSpaced = new Set();
let customCompact = new Set();
let customInside = new Map();
let customLongest = 0;
let customWords = 1;

function squeeze(s) {
  return s.replace(/([a-z])\1+/g, '$1');
}

export function customKey(raw) {
  const text = String(raw ?? '').trim();
  if (!text || Array.from(text).length > CUSTOM_CHARS) return '';
  return normalizeForFilter(text.replace(/^[\s.,!?;:'"()[\]{}]+|[\s.,!?;:'"()[\]{}]+$/g, '')).text;
}

export function setCustomTerms(list, { encoded = true } = {}) {
  const spaced = new Set();
  const compact = new Set();
  for (const raw of Array.isArray(list) ? list.slice(0, CUSTOM_MAX) : []) {
    if (typeof raw !== 'string') continue;
    const key = customKey(encoded ? decodeTerm(raw) : raw);
    const flat = key.replace(/ /g, '');
    if (flat.length < 2) continue;
    spaced.add(key);
    compact.add(squeeze(flat));
  }
  customSpaced = spaced;
  customCompact = compact;
  customInside = new Map();
  for (const x of compact) {
    if (x.length < CUSTOM_INSIDE) continue;
    const head = x.slice(0, 3);
    if (!customInside.has(head)) customInside.set(head, []);
    customInside.get(head).push(x);
  }
  customLongest = Math.max(0, ...[...compact].map((x) => x.length));
  customWords = Math.max(1, ...[...spaced].map((x) => x.split(' ').length));
  return compact.size;
}

export function customTermCount() {
  return customCompact.size;
}

function customMatch(flat) {
  if (customCompact.has(flat)) return true;
  if (flat.length > 3 && flat.endsWith('s') && (customCompact.has(flat.slice(0, -1)) || (flat.endsWith('es') && customCompact.has(flat.slice(0, -2))))) return true;
  if (flat.length < CUSTOM_INSIDE || !customInside.size) return false;
  for (let k = 0; k + CUSTOM_INSIDE <= flat.length; k += 1) {
    const list = customInside.get(flat.slice(k, k + 3));
    if (list && list.some((x) => flat.startsWith(x, k))) return true;
  }
  return false;
}

function scanCustom(tokens, hits, memo = new Map()) {
  const n = tokens.length;
  for (let i = 0; i < n; i += 1) {
    const words = [];
    let short = true;
    for (let j = i; j < n && j - i < MAX_SPAN; j += 1) {
      const t = squeeze(tokens[j].text);
      words.push(t);
      if (t.length > 2) short = false;
      const flat = squeeze(words.join(''));
      if (flat.length > customLongest + 2 && words.length > customWords) break;
      const tight = words.length === 1 || short;
      let found = customSpaced.has(words.join(' '));
      if (!found && tight) {
        if (!memo.has(flat)) memo.set(flat, customMatch(flat));
        found = memo.get(flat);
      }
      if (found) {
        hits.push([tokens[i].start, tokens[j].end]);
        break;
      }
    }
  }
}

function hasCustom(word) {
  const list = chars(word);
  const hits = [];
  const memo = new Map();
  for (const [split, leet] of [[true, true], [true, false], [false, true], [false, false]]) scanCustom(tokenize(list, split, leet), hits, memo);
  return hits.length > 0;
}

export const PATTERN_SLOW_MS = 40;
export const PATTERN_STRIKES = 3;
export const PATTERN_SAMPLES = Object.freeze([
  'hello', 'hi there', 'hey everyone', 'good game', 'gg', 'nice drawing', 'well played', 'thank you', 'thanks so much', 'lol', 'haha', 'wow',
  'ok', 'yes', 'no', 'what is this', 'my turn', 'your turn', 'great job everyone', 'i think it is a cat', 'is it a dog or a bird',
  'the quick brown fox jumps over the lazy dog', 'see you later', 'can you help me', 'round 2', '10 points', 'how are you', 'that was fun',
  'one more game', 'play again', 'nice one', 'good luck have fun', 'pizza and pasta', 'my favourite colour is blue', 'i love this song',
  'café olé', 'gracias amigo 😀', 'привет всем', 'γεια σου', 'こんにちは', '谢谢', 'مرحبا', 'नमस्ते', '👍 ❤️ 🎉',
]);

let customPatterns = [];

const clock = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

function normalMap(list) {
  let text = '';
  const s = [];
  const e = [];
  let gap = true;
  for (const c of list) {
    const k = c.m.kind;
    if (k === 'skip' || k === 'join') continue;
    if (k === 'letter' || k === 'leet') {
      for (const ch of c.m.out) {
        if (text && text[text.length - 1] === ch) {
          e[e.length - 1] = c.e;
          continue;
        }
        text += ch;
        s.push(c.s);
        e.push(c.e);
      }
      gap = false;
    } else if (!gap) {
      text += ' ';
      s.push(c.s);
      e.push(c.e);
      gap = true;
    }
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    s.pop();
    e.pop();
  }
  return { text, s, e };
}

function joinSingles(norm) {
  const { text } = norm;
  let out = '';
  const s = [];
  const e = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === ' ' && (i === 1 || text[i - 2] === ' ') && (i + 2 >= text.length || text[i + 2] === ' ')) continue;
    if (out && out[out.length - 1] === ch && ch !== ' ') {
      e[e.length - 1] = norm.e[i];
      continue;
    }
    out += ch;
    s.push(norm.s[i]);
    e.push(norm.e[i]);
  }
  return { text: out, s, e };
}

function patternSpans(list, text, res = customPatterns, out = []) {
  let norm = null;
  for (const p of res) {
    if (p.strikes >= PATTERN_STRIKES) continue;
    const start = clock();
    try {
      windowSpans(p.re, text, (a, b) => out.push([a, b]));
      if (!norm) {
        const base = normalMap(list);
        const joined = joinSingles(base);
        norm = [base, joined].filter((n, i) => n.text && n.text !== text && (i === 0 || n.text !== base.text));
      }
      for (const n of norm) windowSpans(p.re, n.text, (a, b) => out.push([n.s[a], n.e[b - 1]]));
    } catch {
      p.strikes = PATTERN_STRIKES;
    }
    if (clock() - start > PATTERN_SLOW_MS) p.strikes = (p.strikes || 0) + 1;
  }
  return out;
}

export function setCustomPatterns(list, { encoded = true } = {}) {
  const next = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list.slice(0, PATTERN_MAX) : []) {
    if (typeof raw !== 'string') continue;
    const src = encoded ? decodeTerm(raw) : raw;
    if (seen.has(src) || patternProblem(src)) continue;
    const re = compilePattern(src);
    if (!re) continue;
    seen.add(src);
    next.push({ src, re, strikes: 0 });
  }
  customPatterns = next;
  return next.length;
}

export function customPatternCount() {
  return customPatterns.length;
}

export function testPattern(src, text) {
  const re = typeof src === 'string' ? compilePattern(src) : null;
  const raw = String(text ?? '');
  if (!re || !raw) return [];
  const hits = patternSpans(chars(raw), raw, [{ re, strikes: 0 }]);
  return merge(hits.map(([a, b]) => [a, extend(raw, b)])).map(([start, end]) => ({ start, end, text: raw.slice(start, end) }));
}

export function validatePattern(value, { now, budget, trial = true } = {}) {
  const src = typeof value === 'string' ? value.trim() : value;
  const shape = patternProblem(src);
  if (shape) return shape;
  for (const sample of PATTERN_SAMPLES) {
    if (testPattern(src, sample).length) return { code: 'too_broad', message: `That pattern would also hide "${sample}", which is harmless. Make it more specific.` };
  }
  if (trial && !trialRun(compilePattern(src), src, now, budget)) return { code: 'too_slow', message: 'That pattern is too slow on long messages. Make it simpler.' };
  return null;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..', 'web');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(web);
const jsFiles = files.filter((f) => f.endsWith('.js'));
const rel = (f) => path.relative(web, f).split(path.sep).join('/');

const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof']);

export function findJsComments(src) {
  const found = [];
  const stack = [];
  let i = 0;
  let last = '';
  let lastWord = '';
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === 'tpl') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        i += 1;
        last = 'x';
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        stack.push('expr');
        i += 2;
        last = '{';
        continue;
      }
      i += 1;
      continue;
    }
    if (c === '}' && top === 'expr') {
      stack.pop();
      i += 1;
      continue;
    }
    if (c === '{' && top === 'expr') {
      stack.push('brace');
      i += 1;
      last = '{';
      continue;
    }
    if (c === '}' && top === 'brace') {
      stack.pop();
      i += 1;
      last = '}';
      continue;
    }
    if (c === '`') {
      stack.push('tpl');
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      last = 'x';
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      found.push(src.slice(i, src.indexOf('\n', i) === -1 ? n : src.indexOf('\n', i)));
      i = src.indexOf('\n', i) === -1 ? n : src.indexOf('\n', i);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      found.push(src.slice(i, i + 20));
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '/' && (last === '' || REGEX_BEFORE.has(last) || REGEX_WORDS.has(lastWord))) {
      i += 1;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') {
          i += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') break;
        i += 1;
      }
      i += 1;
      while (i < n && /[a-z]/i.test(src[i])) i += 1;
      last = 'x';
      lastWord = '';
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z_$0-9]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z_$0-9]/.test(src[j])) j += 1;
      lastWord = src.slice(i, j);
      last = REGEX_WORDS.has(lastWord) ? '(' : 'x';
      i = j;
      continue;
    }
    last = c === ')' || c === ']' ? 'x' : c;
    lastWord = '';
    i += 1;
  }
  return found;
}

test('the comment scanner itself works', () => {
  assert.deepEqual(findJsComments('const a = `x ${b ? `y` : "//"}` + "/*";'), []);
  assert.deepEqual(findJsComments('const r = /\\/\\//g;'), []);
  assert.equal(findJsComments('a(); // note').length, 1);
  assert.equal(findJsComments('a(); /* note */').length, 1);
  assert.equal(findJsComments('const u = "http://x"; const t = `${a}`; x = 1 // c').length, 1);
});

test('no comments in any website file', () => {
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (f.endsWith('.js')) assert.deepEqual(findJsComments(src), [], rel(f));
    if (f.endsWith('.css')) assert.equal(src.includes('/*'), false, rel(f));
    if (f.endsWith('.html') || f.endsWith('.svg')) assert.equal(src.includes('<!--'), false, rel(f));
  }
});

test('no unsafe DOM or eval', () => {
  for (const f of jsFiles) {
    const src = readFileSync(f, 'utf8');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', "setAttribute('style'", 'setAttribute("style"']) {
      assert.equal(src.includes(bad), false, `${rel(f)} uses ${bad}`);
    }
  }
});

test('index.html works under the strict CSP', () => {
  const html = readFileSync(path.join(web, 'index.html'), 'utf8');
  assert.equal(/style\s*=/.test(html), false);
  assert.equal(/<style/i.test(html), false);
  assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
  assert.ok(scripts.length >= 2);
  for (const s of scripts) {
    assert.match(s, /src="\/js\/[a-z-]+\.js"/);
    assert.equal(s.replace(/<script[^>]*>/, '').replace('</script>', '').trim(), '');
  }
  assert.equal(/https?:\/\//.test(html), false);
});

const ACTIVITY_PARENT_ORIGINS = ['https://www.yapper.website', 'https://yapper.website', 'https://yapin.gg', 'https://www.yapin.gg'];

const BINARY = /\.(png|jpe?g|webp|ico|mp3|woff2)$/i;

test('no external resources and no forbidden wording', () => {
  for (const f of files) {
    if (BINARY.test(f)) continue;
    const src = readFileSync(f, 'utf8');
    const urls = rel(f) === '_headers' ? [] : src.match(/https?:\/\/[^\s'"`)]+/g) || [];
    for (const u of urls) {
      const bridgeOrigin = rel(f) === 'activity/js/bridge.js' && ACTIVITY_PARENT_ORIGINS.includes(u);
      assert.ok(bridgeOrigin || u.startsWith('http://www.w3.org/2000/svg') || (rel(f) === 'js/links.js' && u.startsWith('https://www.yapin.gg/bot/')), `${rel(f)} references ${u}`);
    }
    assert.equal(/url\(/.test(src) && f.endsWith('.css'), false, `${rel(f)} loads a url()`);
    if (rel(f) === 'activity/data/words.txt') continue;
    assert.equal(/\b(claude|anthropic)\b/i.test(src), false, rel(f));
    assert.equal(/\bAI\b/.test(src), false, rel(f));
    assert.equal(/\bgenerated\b/i.test(src), false, rel(f));
  }
});

test('every website module loads and its imports resolve', async () => {
  for (const f of jsFiles) {
    const name = rel(f);
    if (name === 'js/main.js' || name === 'js/theme-init.js') continue;
    await import(pathToFileURL(f).href);
  }
  const main = readFileSync(path.join(web, 'js', 'main.js'), 'utf8');
  const re = /import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g;
  let m;
  let count = 0;
  while ((m = re.exec(main))) {
    const mod = await import(pathToFileURL(path.join(web, 'js', m[2])).href);
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      assert.ok(name in mod, `main.js imports missing ${name} from ${m[2]}`);
      count += 1;
    }
  }
  assert.ok(count > 10);
});

test('static files get the same security headers as the Worker', async () => {
  const { CSP, ACTIVITY_CSP, PERMISSIONS_POLICY } = await import(pathToFileURL(path.join(here, '..', 'worker', 'security.js')).href);
  const text = readFileSync(path.join(web, '_headers'), 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  assert.equal(lines[0], '/*');
  const blockAt = (start) => {
    const end = lines.findIndex((l, i) => i > start && !/^\s/.test(l));
    return lines.slice(start + 1, end < 0 ? undefined : end);
  };
  const toMap = (block) => new Map(block.filter((l) => !l.trim().startsWith('!')).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
  }));
  const rootBlock = blockAt(0);
  assert.equal(rootBlock.some((l) => l.trim().startsWith('!')), false);
  const headers = toMap(rootBlock);
  for (const p of ['/activity', '/activity/*']) {
    const at = lines.indexOf(p);
    assert.ok(at > 0, `_headers has a ${p} block`);
    const block = blockAt(at);
    assert.ok(block.some((l) => l.trim() === '! X-Frame-Options'), p);
    assert.ok(block.some((l) => l.trim() === '! Content-Security-Policy'), p);
    assert.equal(toMap(block).get('content-security-policy'), ACTIVITY_CSP, p);
  }
  assert.equal(headers.get('content-security-policy'), CSP);
  assert.equal(headers.get('permissions-policy'), PERMISSIONS_POLICY);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('referrer-policy'), 'same-origin');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(text.includes('#'), false);
});

test('the logo and favicon are local pngs', () => {
  const png = readFileSync(path.join(web, 'logo.png'));
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  const html = readFileSync(path.join(web, 'index.html'), 'utf8');
  assert.ok(html.includes('rel="icon" href="/favicon.png"'));
  assert.equal(readFileSync(path.join(web, 'favicon.png')).subarray(1, 4).toString('latin1'), 'PNG');
});

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('an off switch track has at least 3:1 contrast against cards in both themes', () => {
  const css = readFileSync(path.join(web, 'css', 'app.css'), 'utf8');
  assert.match(css, /\.switch \{[^}]*background: var\(--switch-off\)/);
  const blocks = [...css.matchAll(/--surface: (#[0-9a-f]{6});[\s\S]*?--switch-off: (#[0-9a-f]{6});/g)];
  assert.ok(blocks.length >= 3, 'light, dark and forced-dark themes all set --switch-off');
  for (const [, surface, off] of blocks) assert.ok(contrast(surface, off) >= 3, `${off} on ${surface}`);
});

test('the add bot link points at the YapOS invite page', async () => {
  const { ADD_BOT_URL, BOT_ID } = await import('../web/js/links.js');
  assert.match(BOT_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(ADD_BOT_URL, `https://www.yapin.gg/bot/${BOT_ID}`);
});

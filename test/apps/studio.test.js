import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHarness, IDS, uuid } from '../harness.js';
import { customId } from '../../engine/router.js';
import {
  wrapText, cleanCaption, fontSizeFor, minFontSizeFor, measureText, fontMetrics, filterPath, buildArgs, sniffImage, imageSize,
  extensionOf, attachmentUrl, isAllowedUrl, outputSize, parseDm, drawable, findFont, findFfmpeg, sweepStale, FONT_CANDIDATES, PASSES,
} from '../../apps/studio.js';

const S = IDS.server;
const G = IDS.channels.general;
const START = Date.parse('2026-11-07T12:00:00Z');
const MB = 1024 * 1024;

const dmOf = (user) => `d${user.slice(1)}`;
const pic = (over = {}) => ({ path: 'abc/pic.png', name: 'pic.png', size: 1234, width: 800, height: 600, ...over });

function png(width, height) {
  const b = Buffer.alloc(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gifHead(width, height, total = 16) {
  const b = Buffer.alloc(total);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function exifSegment(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

function jpegHead(width, height, orientation = null) {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...(orientation ? [exifSegment(orientation)] : []), sof]);
}

function gifFrames(buf) {
  let i = 13;
  if (buf[10] & 0x80) i += 3 * (1 << ((buf[10] & 7) + 1));
  let frames = 0;
  const skipBlocks = () => { while (buf[i]) i += buf[i] + 1; i++; };
  while (i < buf.length) {
    const kind = buf[i++];
    if (kind === 0x21) { i++; skipBlocks(); continue; }
    if (kind !== 0x2c) break;
    frames++;
    const flags = buf[i + 8];
    i += 9;
    if (flags & 0x80) i += 3 * (1 << ((flags & 7) + 1));
    i++;
    skipBlocks();
  }
  return frames;
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

async function make(opts = {}) {
  const h = await createHarness({ apps: ['studio'], ...opts });
  const svc = h.engine.service('studio');
  const state = { urls: [], jobs: [], body: png(800, 600), headers: {}, out: gifHead(480, 400), fail: null, gate: null, respond: null };
  svc.setFetch(async (url, init) => {
    state.urls.push(url);
    state.init = init;
    if (state.respond) return state.respond(url);
    return new Response(state.body, { status: 200, headers: state.headers });
  });
  svc.setRenderer(async (job) => {
    state.jobs.push(job);
    if (state.gate) await state.gate;
    if (state.fail) throw state.fail;
    await fsp.writeFile(job.output, typeof state.out === 'function' ? state.out(job) : state.out);
  });
  const done = async () => { await svc.idle(); await h.settle(); };
  const dm = async (text, o = {}) => { await h.dm(text, o); await done(); };
  const say = async (text, o = {}) => { const m = await h.message(text, o); await done(); return m; };
  const filesIn = (cid) => h.sent(cid).filter((m) => m.files?.length);
  const lastText = (cid) => h.textOf(h.lastSent(cid));
  return { h, svc, state, done, dm, say, filesIn, lastText };
}

test('studio registers two commands, yap words and its service', async () => {
  const { h, svc } = await make();
  for (const name of ['caption', 'gif']) {
    const c = h.bot.commands.get(name);
    assert.ok(c, `/${name} exists`);
    assert.ok(c.description.length > 10 && c.description.length <= 100);
  }
  const app = h.engine.apps.get('studio');
  assert.equal(app.meta.name, 'Studio');
  assert.equal(app.meta.icon, '🎬');
  assert.equal(app.meta.category, 'Fun');
  assert.equal(app.meta.defaultEnabled, true);
  assert.ok(app.meta.description.length <= 60);
  for (const w of ['caption', 'gif', 'meme', 'studio']) assert.equal(h.engine.yap.find(w)?.app, 'studio');
  for (const fn of ['setFetch', 'setRenderer', 'wrapText', 'buildArgs', 'stats']) assert.equal(typeof svc[fn], 'function');
  const stats = svc.stats();
  assert.equal(stats.running, 0);
  assert.equal(stats.waiting, 0);
});

test('cleanCaption strips control characters and caps the length', () => {
  assert.deepEqual(cleanCaption('  hello\tthere\u0000\u0007  \r\n\r\n  second   line \u200b'), { text: 'hello there\nsecond line', trimmed: false });
  const long = cleanCaption('x'.repeat(400));
  assert.equal(long.trimmed, true);
  assert.equal([...long.text].length, 300);
  assert.ok(long.text.endsWith('…'));
  assert.deepEqual(cleanCaption(null), { text: '', trimmed: false });
});

test('wrapText fits lines to the width, shrinks, then cuts with an ellipsis', () => {
  const measure = (s, size) => [...s].length * size * 0.5;
  const opts = { width: 480, measure };
  const avail = 480 - 2 * Math.round(480 * 0.04);
  const short = wrapText('hello world', opts);
  assert.deepEqual(short.lines, ['hello world']);
  assert.equal(short.fontSize, fontSizeFor(480));
  assert.equal(short.truncated, false);

  const medium = wrapText('when the code works first try and you have no idea why it works', opts);
  assert.ok(medium.lines.length > 1 && medium.lines.length <= 6);
  assert.equal(medium.fontSize, fontSizeFor(480));
  for (const l of medium.lines) assert.ok(measure(l, medium.fontSize) <= avail, l);
  assert.equal(medium.lines.join(' '), 'when the code works first try and you have no idea why it works');
  assert.ok(medium.barHeight > short.barHeight);
  assert.equal(medium.barHeight % 2, 0);
  assert.equal(medium.baselines.length, medium.lines.length);
  assert.ok(medium.baselines.every((b, i) => i === 0 || b - medium.baselines[i - 1] === medium.lineHeight));
  assert.ok(medium.baselines[medium.baselines.length - 1] < medium.barHeight);

  const longer = wrapText('word '.repeat(45), opts);
  assert.ok(longer.fontSize < fontSizeFor(480), 'font shrinks when 6 lines are not enough');
  assert.ok(longer.lines.length <= 6);
  assert.equal(longer.truncated, false);

  const huge = wrapText('lorem ipsum dolor '.repeat(16), opts);
  assert.equal(huge.lines.length, 6);
  assert.equal(huge.fontSize, minFontSizeFor(480));
  assert.equal(huge.truncated, true);
  assert.ok(huge.lines[5].endsWith('…'));
  for (const l of huge.lines) assert.ok(measure(l, huge.fontSize) <= avail, l);

  const broken = wrapText('a'.repeat(120), opts);
  assert.ok(broken.lines.length > 1);
  for (const l of broken.lines) assert.ok(measure(l, broken.fontSize) <= avail);
  assert.equal(broken.lines.join(''), 'a'.repeat(120));

  assert.deepEqual(wrapText('top line\nbottom line', opts).lines, ['top line', 'bottom line']);
  assert.ok(wrapText('narrow picture caption here', { width: 240, measure }).fontSize < short.fontSize);
});

test('font size scales with the picture width', () => {
  assert.equal(fontSizeFor(480), 46);
  assert.equal(fontSizeFor(240), 23);
  assert.equal(fontSizeFor(40), 12);
  assert.equal(fontSizeFor(4000), 64);
  assert.ok(minFontSizeFor(480) < fontSizeFor(480));
  assert.ok(measureText('MMMM', 40, null) > measureText('iiii', 40, null));
  assert.equal(measureText('abc', 40, null) * 2, measureText('abc', 80, null));
  assert.equal(fontMetrics(path.join(os.tmpdir(), 'no-such-font.ttf')), null);
});

test('real font metrics are read when the font exists', { skip: !findFont() && 'no caption font on this machine' }, () => {
  const font = findFont();
  const m = fontMetrics(font);
  assert.ok(m, 'metrics parsed');
  assert.ok(m.widths.get(65) > 0.2 && m.widths.get(65) < 1.2);
  assert.ok(m.widths.get(105) < m.widths.get(87));
  assert.ok(measureText('Hello there', 40, font) > 60);
});

test('findFont prefers YAPOS_FONT, then the known fonts, then nothing', () => {
  assert.equal(findFont({ YAPOS_FONT: '/my/font.ttf' }, (f) => f === '/my/font.ttf'), '/my/font.ttf');
  assert.equal(findFont({ YAPOS_FONT: '/missing.ttf' }, (f) => f === FONT_CANDIDATES[2]), FONT_CANDIDATES[2]);
  assert.equal(findFont({}, (f) => f === FONT_CANDIDATES[1] || f === FONT_CANDIDATES[3]), FONT_CANDIDATES[1]);
  assert.equal(findFont({}, () => false), null);
  assert.equal(FONT_CANDIDATES[0], 'C:/Windows/Fonts/impact.ttf');
});

test('filterPath escapes paths for both filter levels', () => {
  assert.equal(filterPath('C:\\Windows\\Fonts\\impact.ttf', true), 'C\\\\:/Windows/Fonts/impact.ttf');
  assert.equal(filterPath('C:/Users/O\'Brien/a, b/[x];.txt', true), 'C\\\\:/Users/O\\\\\\\'Brien/a\\, b/\\[x\\]\\;.txt');
  assert.equal(filterPath('/usr/share/fonts/DejaVuSans-Bold.ttf', false), '/usr/share/fonts/DejaVuSans-Bold.ttf');
  assert.equal(filterPath('/tmp/a\\b:c', false), '/tmp/a\\\\\\\\b\\\\:c');
});

test('buildArgs keeps caption text out of the filter and sets the limits', () => {
  const layout = { fontSize: 46, barHeight: 120, baselines: [57, 111], lines: ['x', 'y'] };
  const base = { type: 'png', dir: 'C:\\tmp\\job', input: 'C:\\tmp\\job\\in.png', output: 'C:\\tmp\\job\\out-480.gif', outWidth: 480, outHeight: 360, orientation: 1, animated: false, fps: 15, seconds: 12 };
  const still = buildArgs({ ...base, kind: 'caption', fontFile: 'C:/Windows/Fonts/impact.ttf', layout, lineFiles: ['C:\\tmp\\job\\line-480-0.txt', 'C:\\tmp\\job\\line-480-1.txt'] });
  assert.ok(Array.isArray(still));
  const graph = still[still.indexOf('-filter_complex') + 1];
  assert.equal((graph.match(/drawtext=/g) || []).length, 2);
  assert.match(graph, /scale=480:360/);
  assert.match(graph, /pad=480:480:0:120:color=white/);
  assert.match(graph, /textfile=C\\\\:\/tmp\/job\/line-480-1\.txt/);
  assert.match(graph, /fontfile=C\\\\:\/Windows\/Fonts\/impact\.ttf/);
  assert.match(graph, /expansion=none/);
  assert.match(graph, /x=\(w-text_w\)\/2/);
  assert.match(graph, /palettegen/);
  assert.match(graph, /paletteuse/);
  assert.ok(!/\btext=/.test(graph), 'no inline text option');
  assert.equal(still[still.indexOf('-f') + 1], 'png_pipe');
  assert.equal(still[still.indexOf('-i') + 1], base.input);
  assert.equal(still[still.indexOf('-frames:v') + 1], '1');
  assert.ok(still.includes('-noautorotate'));
  assert.ok(still.includes('-nostdin'));
  for (const args of [still]) {
    const input = args.indexOf('-i');
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
    assert.ok(args.indexOf('-protocol_whitelist') < input);
    assert.equal(args[args.indexOf('-max_pixels') + 1], String(4096 * 4096));
    assert.ok(args.indexOf('-max_pixels') < input);
    assert.equal(args[args.indexOf('-fs') + 1], String(Math.floor(9.5 * MB) + MB));
    assert.ok(args.indexOf('-fs') > input);
    assert.equal(args.filter((a) => a === '-i').length, 1);
    assert.ok(args.every((a) => typeof a === 'string'));
  }
  assert.ok(!still.includes('-t'));
  assert.equal(still[still.length - 1], base.output);

  const anim = buildArgs({ ...base, kind: 'gif', type: 'gif', animated: true, fps: 10, outWidth: 320, outHeight: 240 });
  const g2 = anim[anim.indexOf('-filter_complex') + 1];
  assert.match(g2, /fps=fps='min\(10,source_fps\)'/);
  assert.match(g2, /scale=320:240/);
  assert.ok(!/drawtext|pad=/.test(g2));
  assert.equal(anim[anim.lastIndexOf('-t') + 1], '12');
  assert.ok(!anim.includes('-frames:v'));
  assert.equal(anim[anim.indexOf('-f') + 1], 'gif');

  const turned = buildArgs({ ...base, kind: 'gif', type: 'jpg', orientation: 6 });
  assert.match(turned[turned.indexOf('-filter_complex') + 1], /^\[0:v\]transpose=1,scale=/);
  assert.equal(turned[turned.indexOf('-f') + 1], 'jpeg_pipe');
});

test('sniffImage and imageSize read the real type and size from the bytes', () => {
  assert.equal(sniffImage(png(10, 10)), 'png');
  assert.equal(sniffImage(gifHead(3, 4)), 'gif');
  assert.equal(sniffImage(jpegHead(640, 480)), 'jpg');
  assert.equal(sniffImage(Buffer.from('%PDF-1.7 not a picture at all')), null);
  assert.equal(sniffImage(Buffer.from('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n')), null);
  assert.equal(sniffImage(Buffer.alloc(4)), null);
  assert.deepEqual(imageSize(png(800, 600)), { width: 800, height: 600, orientation: 1, animated: false });
  assert.deepEqual(imageSize(gifHead(320, 240)), { width: 320, height: 240, orientation: 1, animated: true });
  assert.deepEqual(imageSize(jpegHead(640, 480)), { width: 640, height: 480, orientation: 1, animated: false });
  assert.deepEqual(imageSize(jpegHead(640, 480, 6)), { width: 480, height: 640, orientation: 6, animated: false });
  assert.deepEqual(imageSize(jpegHead(640, 480, 3)), { width: 640, height: 480, orientation: 3, animated: false });
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBP', 8, 'latin1');
  webp.write('VP8X', 12, 'latin1');
  webp[20] = 0x02;
  webp.writeUIntLE(299, 24, 3);
  webp.writeUIntLE(199, 27, 3);
  assert.equal(sniffImage(webp), 'webp');
  assert.deepEqual(imageSize(webp), { width: 300, height: 200, orientation: 1, animated: true });
  assert.equal(imageSize(png(0, 50)), null);
  const hidden = png(64, 64);
  hidden.write('tEXt', 12, 'latin1');
  assert.equal(sniffImage(hidden), 'png');
  assert.equal(imageSize(hidden), null);
  const longHeader = png(64, 64);
  longHeader.writeUInt32BE(64, 8);
  assert.equal(imageSize(longHeader), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0])), null);
});

test('extensionOf, parseDm and outputSize behave', () => {
  assert.equal(extensionOf({ name: 'Cat.PNG', path: 'abc/x.bin' }), 'png');
  assert.equal(extensionOf({ name: null, path: 'abc/def/cat.jpeg?x=1' }), 'jpeg');
  assert.equal(extensionOf('abc/doc.pdf'), 'pdf');
  assert.equal(extensionOf('abc/noext'), '');

  assert.deepEqual(parseDm('caption when it works'), { kind: 'caption', text: 'when it works' });
  assert.deepEqual(parseDm('  /Caption  Hi there '), { kind: 'caption', text: 'Hi there' });
  assert.deepEqual(parseDm('!GIF'), { kind: 'gif', text: '' });
  assert.deepEqual(parseDm('gif please'), { kind: 'gif', text: 'please' });
  assert.deepEqual(parseDm('caption\nline two'), { kind: 'caption', text: 'line two' });
  assert.deepEqual(parseDm('studio'), { kind: 'help', text: '' });
  assert.deepEqual(parseDm('Studio Help'), { kind: 'help', text: '' });
  assert.equal(parseDm('gifted kid'), null);
  assert.equal(parseDm('captions are cool'), null);
  assert.equal(parseDm('look at this caption'), null);
  assert.equal(parseDm('studio is nice'), null);
  assert.equal(parseDm(''), null);
  assert.equal(parseDm(null), null);

  assert.deepEqual(outputSize({ width: 1280, height: 720 }), { width: 480, height: 270 });
  assert.deepEqual(outputSize({ width: 1280, height: 720, maxWidth: 320 }), { width: 320, height: 180 });
  assert.deepEqual(outputSize({ width: 333, height: 201 }), { width: 332, height: 200 });
  assert.deepEqual(outputSize({ width: 100, height: 80 }), { width: 100, height: 80 });
  assert.deepEqual(outputSize({ width: 100, height: 80, minWidth: 240 }), { width: 240, height: 192 });
  assert.deepEqual(outputSize({ width: 10, height: 4000, minWidth: 240 }), { width: 10, height: 4000 });
  assert.deepEqual(outputSize({ width: 40, height: 400, minWidth: 240 }), { width: 204, height: 2040 });
  assert.deepEqual(outputSize({ width: 100, height: 1000, minWidth: 240, maxWidth: 320 }), { width: 204, height: 2040 });
  assert.deepEqual(outputSize({ width: 4096, height: 3 }), { width: 480, height: 2 });
  assert.deepEqual(outputSize({ width: 480, height: 640, maxArea: 480 * 640 }), { width: 480, height: 640 });
  for (const [width, height, maxWidth] of [[480, 4096, 480], [4096, 4096, 480], [100, 4096, 480], [64, 4000, 320], [480, 4096, 320]]) {
    const out = outputSize({ width, height, maxWidth, minWidth: 240, maxArea: 480 * 640 });
    assert.ok(out.width * out.height <= 480 * 640 * 1.02, `${width}x${height} -> ${out.width}x${out.height}`);
    assert.ok(out.width <= maxWidth && out.width % 2 === 0 && out.height % 2 === 0);
  }
  assert.deepEqual(PASSES, [{ maxWidth: 480, fps: 15 }, { maxWidth: 320, fps: 10 }]);
});

test('drawable drops characters the caption font has no shape for', () => {
  const metrics = { widths: new Map([...'abcdefghijklmnopqrstuvwxyz!'].map((c) => [c.codePointAt(0), 0.5])), missing: 0.5 };
  assert.equal(drawable('hi 😀🔥 there 日本語 !', 'fake.ttf', metrics), 'hi there !');
  assert.equal(drawable('😀\nok 😀', 'fake.ttf', metrics), 'ok');
  assert.equal(drawable('😀🔥', 'fake.ttf', metrics), '');
  assert.equal(drawable('😀 anything', null, null), '😀 anything');
  assert.equal(drawable(null, 'fake.ttf', metrics), '');
});

test('a caption the font cannot write at all is refused, and emoji are left out of the rest', { skip: !findFont() && 'no caption font on this machine' }, async () => {
  const { state, dm, lastText, filesIn } = await make();
  const cid = dmOf(IDS.member);
  await dm('caption 😀🔥', { attachments: [pic()] });
  assert.match(lastText(cid), /can't write those characters/);
  assert.equal(state.urls.length, 0);
  assert.equal(filesIn(cid).length, 0);
  await dm('caption party 😀 time', { attachments: [pic()] });
  assert.equal(filesIn(cid).length, 1);
  assert.equal(state.jobs[0].layout.lines.join(' '), 'party time');
});

test('attachment links only ever point at the two Yapin hosts', () => {
  assert.equal(attachmentUrl('abc/pic.png'), 'https://files.yapper.website/attachments/abc/pic.png');
  assert.equal(attachmentUrl('/bots/default.png'), 'https://www.yapin.gg/bots/default.png');
  assert.equal(new URL(attachmentUrl('https://evil.example/x.png')).hostname, 'files.yapper.website');
  assert.equal(attachmentUrl('//evil.example/x.png'), null);
  assert.equal(attachmentUrl('/\\evil.example/x.png'), null);
  assert.equal(attachmentUrl('abc/%2e%2e/%2e%2e/x.png'), null);
  assert.equal(attachmentUrl('abc/%2E%2E%2Fx.png'), null);
  assert.equal(attachmentUrl('abc/.%2e/x.png'), null);
  assert.equal(attachmentUrl('abc/%252e%252e/x.png'), null);
  assert.equal(attachmentUrl('abc/./x.png'), null);
  assert.equal(attachmentUrl('abc/pic.png?next=https://evil.example'), null);
  assert.equal(attachmentUrl('abc/pic.png#@evil.example'), null);
  assert.equal(attachmentUrl('abc/pic\u0000.png'), null);
  assert.equal(attachmentUrl('abc/pic\t.png'), null);
  assert.equal(attachmentUrl('abc/pic .png'), null);
  assert.equal(attachmentUrl(`abc/${'a'.repeat(600)}.png`), null);
  assert.equal(attachmentUrl({ toString: () => 'abc/pic.png' }), null);
  assert.equal(attachmentUrl(['abc/pic.png']), null);
  for (const p of ['file:///C:/Windows/win.ini', 'concat:a|b', 'pipe:0', '-i', 'C:/secret.png', 'http://127.0.0.1/x.png', 'evil.example:443/x.png', 'user:pw@evil.example/x.png']) {
    const url = attachmentUrl(p);
    assert.ok(url === null || url.startsWith('https://files.yapper.website/attachments/'), p);
  }
  assert.equal(new URL(attachmentUrl('/attachments/@evil.example/x.png')).hostname, 'www.yapin.gg');
  assert.equal(new URL(attachmentUrl('@evil.example/x.png')).hostname, 'files.yapper.website');
  assert.equal(attachmentUrl('../../secret/x.png'), null);
  assert.equal(attachmentUrl('abc/../../x.png'), null);
  assert.equal(attachmentUrl('abc\\..\\x.png'), null);
  assert.equal(attachmentUrl(''), null);
  assert.equal(attachmentUrl(null), null);
  assert.equal(isAllowedUrl('https://files.yapper.website/attachments/a.png'), true);
  assert.equal(isAllowedUrl('https://www.yapin.gg/a.png'), true);
  assert.equal(isAllowedUrl('http://files.yapper.website/attachments/a.png'), false);
  assert.equal(isAllowedUrl('https://files.yapper.website.evil.example/a.png'), false);
  assert.equal(isAllowedUrl('https://evil.example/files.yapper.website/a.png'), false);
  assert.equal(isAllowedUrl('https://user:pw@files.yapper.website/a.png'), false);
  assert.equal(isAllowedUrl('https://files.yapper.website:8443/a.png'), false);
  assert.equal(isAllowedUrl('https://yapin.gg/a.png'), false);
  assert.equal(isAllowedUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedUrl('nonsense'), false);
});

test('DM caption: the GIF comes back in the DM as caption.gif', async () => {
  const { h, state, dm, filesIn } = await make();
  await dm('caption when the code works first try', { attachments: [pic()] });
  const cid = dmOf(IDS.member);
  const sent = filesIn(cid);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].files[0].name, 'caption.gif');
  assert.ok(sent[0].files[0].text.startsWith('GIF89a'));
  assert.equal(sent[0].reply_to_id, null);
  assert.deepEqual(state.urls, ['https://files.yapper.website/attachments/abc/pic.png']);
  assert.equal(state.init.redirect, 'manual');
  assert.equal(state.jobs.length, 1);
  const job = state.jobs[0];
  assert.equal(job.kind, 'caption');
  assert.equal(job.type, 'png');
  assert.equal(job.outWidth, 480);
  assert.equal(job.outHeight, 360);
  assert.equal(job.layout.lines.join(' '), 'when the code works first try');
  assert.equal(job.lineFiles.length, job.layout.lines.length);
  assert.equal(filesIn(G).length, 0);
  assert.equal(h.engine.service('studio').stats().done, 1);
  assert.equal(h.engine.caps.state(null, 'files'), true);
});

test('DM gif: the plain GIF comes back as image.gif', async () => {
  const { state, dm, filesIn } = await make();
  state.body = gifHead(200, 100, 64);
  await dm('/GIF', { attachments: [pic({ path: 'zz/dance.gif', name: 'dance.gif', width: 200, height: 100 })] });
  const sent = filesIn(dmOf(IDS.member));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].files[0].name, 'image.gif');
  assert.equal(state.jobs[0].kind, 'gif');
  assert.equal(state.jobs[0].type, 'gif');
  assert.equal(state.jobs[0].animated, true);
  assert.equal(state.jobs[0].outWidth, 200);
  assert.deepEqual(state.jobs[0].lineFiles, []);
});

test('a DM picture without the keyword is not claimed', async () => {
  const { h, state, dm, filesIn, lastText } = await make();
  const cid = dmOf(IDS.member);
  await dm('look at this picture', { attachments: [pic()] });
  assert.match(lastText(cid), /Pocket/);
  await dm('gifted kids caption contest', { attachments: [pic()] });
  assert.equal(h.sent(cid).length, 2);
  assert.match(lastText(cid), /Pocket/);
  assert.equal(state.urls.length, 0);
  assert.equal(filesIn(cid).length, 0);
});

test('a keyword without a picture explains how, and studio help shows the how-to', async () => {
  const { state, dm, lastText, filesIn } = await make();
  const cid = dmOf(IDS.member);
  await dm('caption hello there');
  assert.match(lastText(cid), /I need a picture/);
  assert.match(lastText(cid), /Send me a picture with `caption your text`/);
  await dm('gif');
  assert.match(lastText(cid), /I need a picture/);
  await dm('studio help');
  assert.match(lastText(cid), /Studio/);
  assert.match(lastText(cid), /!caption your text/);
  await dm('Studio');
  assert.match(lastText(cid), /In my DMs/);
  await dm('caption', { attachments: [pic()] });
  assert.match(lastText(cid), /What should the caption say/);
  assert.equal(state.urls.length, 0);
  assert.equal(filesIn(cid).length, 0);
});

test('server: !caption with a picture attached replies with the GIF in the channel', async () => {
  const { state, say, filesIn } = await make();
  const msg = await say('!caption hello there', { attachment: 'abc/pic.png' });
  const sent = filesIn(G);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].files[0].name, 'caption.gif');
  assert.equal(sent[0].reply_to_id, msg.id);
  assert.deepEqual(state.urls, ['https://files.yapper.website/attachments/abc/pic.png']);
  assert.equal(state.jobs[0].layout.lines.join(' '), 'hello there');
});

test('server: replying to a picture works for !gif and !caption', async () => {
  const { h, state, say, filesIn, lastText } = await make();
  const first = await say('look at my cat', { attachment: 'zzz/cat.jpg', user: IDS.member2 });
  state.body = jpegHead(640, 480);
  await say('!gif', { replyTo: first.id });
  assert.equal(filesIn(G).length, 1);
  assert.equal(filesIn(G)[0].files[0].name, 'image.gif');
  assert.deepEqual(state.urls, ['https://files.yapper.website/attachments/zzz/cat.jpg']);
  assert.equal(state.jobs[0].type, 'jpg');
  await say('!caption so fluffy', { replyTo: first.id, user: IDS.mod });
  assert.equal(filesIn(G).length, 2);
  assert.equal(filesIn(G)[1].files[0].name, 'caption.gif');
  const plain = await say('no picture here', { user: IDS.member2 });
  await say('!caption hmm', { replyTo: plain.id, user: IDS.admin });
  assert.match(lastText(G), /That message has no picture/);
  await say('!caption nothing attached', { user: IDS.admin });
  assert.match(lastText(G), /I need a picture/);
  assert.match(lastText(G), /reply to a picture/);
  assert.equal(filesIn(G).length, 2);
  assert.equal(h.engine.service('studio').stats().done, 2);
});

test('picked from the slash menu, /caption and /gif explain privately', async () => {
  const { h, state, filesIn } = await make();
  for (const name of ['caption', 'gif']) {
    const ans = await h.slash(name, name === 'caption' ? 'hello' : '');
    assert.equal(ans.length, 1);
    assert.equal(ans[0].type, 'ephemeral');
    assert.match(h.textOf(ans[0]), /!caption your text/);
    assert.match(h.textOf(ans[0]), /reply to a picture/);
  }
  assert.equal(state.urls.length, 0);
  assert.equal(filesIn(G).length, 0);
});

test('/yap words and the menu panel reach Studio', async () => {
  const { h, say, filesIn } = await make();
  await say('!yap meme big mood', { attachment: 'abc/pic.png' });
  assert.equal(filesIn(G).length, 1);
  assert.equal(filesIn(G)[0].files[0].name, 'caption.gif');
  const ans = await h.slash('yap', 'studio');
  assert.equal(ans[0].type, 'ephemeral');
  assert.match(h.textOf(ans[0]), /Studio/);
  const viaGif = await h.slash('yap', 'gif');
  assert.match(h.textOf(viaGif[0]), /!caption your text/);
  const opened = await h.click(customId('system', 'open', 'studio'));
  assert.equal(opened[0].type, 'ephemeral');
  assert.match(h.textOf(opened[0]), /Turn a picture into a captioned GIF/);
  const help = await h.slash('help', 'studio');
  assert.match(h.textOf(help[0]), /\/caption/);
});

test('files that are not pictures are refused', async () => {
  const { state, dm, say, lastText, filesIn } = await make();
  await say('!caption nope', { attachment: 'abc/report.pdf' });
  assert.match(lastText(G), /That isn't a picture/);
  assert.match(lastText(G), /\.pdf/);
  assert.equal(state.urls.length, 0);
  const cid = dmOf(IDS.member2);
  state.body = Buffer.from('%PDF-1.7 this only pretends to be a picture');
  await dm('gif', { user: IDS.member2, attachments: [pic({ path: 'abc/fake.png', name: 'fake.png' })] });
  assert.match(lastText(cid), /I couldn't read that picture/);
  assert.equal(state.urls.length, 1);
  assert.equal(state.jobs.length, 0);
  assert.equal(filesIn(cid).length, 0);
  assert.equal(filesIn(G).length, 0);
});

test('an animated WebP is refused with a hint to send a GIF', async () => {
  const { state, dm, lastText, filesIn } = await make();
  const webp = Buffer.alloc(64);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBP', 8, 'latin1');
  webp.write('VP8X', 12, 'latin1');
  webp[20] = 0x02;
  webp.writeUIntLE(199, 24, 3);
  webp.writeUIntLE(149, 27, 3);
  state.body = webp;
  await dm('caption moving', { attachments: [pic({ path: 'abc/move.webp', name: 'move.webp' })] });
  assert.match(lastText(dmOf(IDS.member)), /animated WebP/);
  assert.match(lastText(dmOf(IDS.member)), /Send it as a GIF/);
  assert.equal(state.jobs.length, 0);
  assert.equal(filesIn(dmOf(IDS.member)).length, 0);
});

test('pictures that are too heavy or too large are refused', async () => {
  const { state, dm, lastText, filesIn } = await make();
  const users = [uuid(), uuid(), uuid(), uuid(), uuid()];
  await dm('gif', { user: users[0], attachments: [pic({ size: 16 * MB })] });
  assert.match(lastText(dmOf(users[0])), /over 15 MB/);
  assert.equal(state.urls.length, 0);

  state.headers = { 'content-length': String(16 * MB) };
  await dm('gif', { user: users[1], attachments: [pic()] });
  assert.match(lastText(dmOf(users[1])), /over 15 MB/);
  assert.equal(state.urls.length, 1);

  let pulled = 0;
  state.respond = () => new Response(new ReadableStream({
    pull(controller) {
      pulled++;
      if (pulled > 40) controller.close();
      else controller.enqueue(pulled === 1 ? Buffer.concat([png(100, 100), Buffer.alloc(MB)]) : new Uint8Array(MB));
    },
  }), { status: 200 });
  await dm('gif', { user: users[2], attachments: [pic()] });
  assert.match(lastText(dmOf(users[2])), /over 15 MB/);
  assert.ok(pulled <= 18, `stopped reading early (${pulled})`);

  state.respond = null;
  state.headers = {};
  await dm('gif', { user: users[3], attachments: [pic({ width: 5000, height: 300 })] });
  assert.match(lastText(dmOf(users[3])), /5000×300/);
  assert.equal(state.urls.length, 2);

  state.body = png(300, 5000);
  await dm('gif', { user: users[4], attachments: [pic({ width: null, height: null })] });
  assert.match(lastText(dmOf(users[4])), /300×5000/);
  assert.match(lastText(dmOf(users[4])), /4096×4096/);
  assert.equal(state.jobs.length, 0);
  for (const u of users) assert.equal(filesIn(dmOf(u)).length, 0);
});

test('a failed download gets a friendly message', async () => {
  const { state, dm, lastText } = await make();
  state.respond = () => new Response('gone', { status: 404 });
  await dm('gif', { attachments: [pic()] });
  assert.match(lastText(dmOf(IDS.member)), /couldn't download that picture/);
  assert.ok(!/404/.test(lastText(dmOf(IDS.member))));
  state.respond = () => { throw new TypeError('fetch failed: ECONNRESET 10.0.0.1'); };
  await dm('gif', { user: IDS.member2, attachments: [pic()] });
  assert.match(lastText(dmOf(IDS.member2)), /couldn't download that picture/);
  assert.ok(!/ECONNRESET/.test(lastText(dmOf(IDS.member2))));
});

test('redirects are followed only inside the allowed hosts', async () => {
  const { state, dm, lastText, filesIn } = await make();
  state.respond = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/pic.png' } });
  await dm('gif', { attachments: [pic()] });
  assert.match(lastText(dmOf(IDS.member)), /only download pictures from Yapin'/);
  assert.deepEqual(state.urls, ['https://files.yapper.website/attachments/abc/pic.png']);
  assert.equal(state.jobs.length, 0);

  state.urls.length = 0;
  state.respond = (url) => (url.includes('/moved/')
    ? new Response(png(64, 64), { status: 200 })
    : new Response(null, { status: 301, headers: { location: '/attachments/moved/pic.png' } }));
  await dm('gif', { user: IDS.member2, attachments: [pic()] });
  assert.deepEqual(state.urls, ['https://files.yapper.website/attachments/abc/pic.png', 'https://files.yapper.website/attachments/moved/pic.png']);
  assert.equal(filesIn(dmOf(IDS.member2)).length, 1);

  state.urls.length = 0;
  state.respond = () => new Response(null, { status: 302, headers: { location: 'https://files.yapper.website/attachments/loop.png' } });
  await dm('gif', { user: IDS.mod, attachments: [pic()] });
  assert.equal(state.urls.length, 4);
  assert.match(lastText(dmOf(IDS.mod)), /couldn't download/);
});

test('a caption over 300 characters is trimmed, not refused', async () => {
  const { state, dm, filesIn } = await make();
  await dm(`caption ${'very long words '.repeat(40)}`, { attachments: [pic()] });
  const sent = filesIn(dmOf(IDS.member));
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /trimmed your caption to 300 characters/);
  const layout = state.jobs[0].layout;
  assert.ok(layout.lines.length <= 6);
  assert.ok([...layout.lines.join(' ')].length <= 300);
  for (const file of state.jobs[0].lineFiles) assert.ok(!fs.existsSync(file));
});

test('one job at a time per person, then a 10 second cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const { state, dm, h, svc, filesIn, lastText } = await make();
  const cid = dmOf(IDS.member);
  let release;
  state.gate = new Promise((r) => { release = r; });
  await h.dm('caption first', { attachments: [pic()] });
  await h.dm('caption second', { attachments: [pic()] });
  assert.match(lastText(cid), /One at a time/);
  state.gate = null;
  release();
  await svc.idle();
  await h.settle();
  assert.equal(filesIn(cid).length, 1);

  await dm('caption too soon', { attachments: [pic()] });
  assert.match(lastText(cid), /Give me 10 seconds/);
  t.mock.timers.tick(6000);
  await dm('caption still too soon', { attachments: [pic()] });
  assert.match(lastText(cid), /Give me 4 seconds/);
  assert.equal(filesIn(cid).length, 1);
  await dm('caption someone else is fine', { user: IDS.member2, attachments: [pic()] });
  assert.equal(filesIn(dmOf(IDS.member2)).length, 1);
  t.mock.timers.tick(4001);
  await dm('caption now it works', { attachments: [pic()] });
  assert.equal(filesIn(cid).length, 2);
  assert.equal(state.jobs.length, 3);
});

test('two jobs run at once and the rest are told their place in line', async () => {
  const { h, state, svc, filesIn, lastText } = await make();
  let release;
  state.gate = new Promise((r) => { release = r; });
  const users = [IDS.member, IDS.member2, IDS.mod, IDS.admin];
  await h.dm('gif', { user: users[0], attachments: [pic()] });
  await h.dm('gif', { user: users[1], attachments: [pic()] });
  assert.equal(svc.stats().running, 2);
  assert.equal(h.sent(dmOf(users[0])).length, 0);
  await h.dm('gif', { user: users[2], attachments: [pic()] });
  assert.match(lastText(dmOf(users[2])), /You're #1 in line/);
  await h.dm('caption waiting', { user: users[3], attachments: [pic()] });
  assert.match(lastText(dmOf(users[3])), /You're #2 in line/);
  assert.deepEqual([svc.stats().running, svc.stats().waiting], [2, 2]);
  await until(() => state.jobs.length === 2);
  await h.settle();
  assert.equal(state.jobs.length, 2);
  state.gate = null;
  release();
  await svc.idle();
  await h.settle();
  for (const u of users) assert.equal(filesIn(dmOf(u)).length, 1);
  assert.deepEqual([svc.stats().running, svc.stats().waiting, svc.stats().done], [0, 0, 4]);
});

test('a full queue says the Studio is busy', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const { h, state, svc, lastText, filesIn } = await make();
  let release;
  state.gate = new Promise((r) => { release = r; });
  const users = Array.from({ length: 23 }, () => uuid());
  for (const u of users.slice(0, 12)) await h.dm('gif', { user: u, attachments: [pic()] });
  t.mock.timers.tick(61_000);
  for (const u of users.slice(12, 22)) await h.dm('gif', { user: u, attachments: [pic()] });
  assert.deepEqual([svc.stats().running, svc.stats().waiting], [2, 20]);
  assert.match(lastText(dmOf(users[21])), /You're #20 in line/);
  await h.dm('gif', { user: users[22], attachments: [pic()] });
  assert.match(lastText(dmOf(users[22])), /The Studio is busy/);
  assert.deepEqual([svc.stats().running, svc.stats().waiting], [2, 20]);
  state.gate = null;
  release();
  await svc.idle();
  await h.settle();
  assert.equal(filesIn(dmOf(users[22])).length, 0);
  assert.deepEqual([svc.stats().running, svc.stats().waiting], [0, 0]);
});

test('slow jobs from two different minutes cannot push more than 20 files into one minute', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const { h, state, svc, lastText, filesIn } = await make();
  let release;
  state.gate = new Promise((r) => { release = r; });
  const users = Array.from({ length: 23 }, () => uuid());
  for (const u of users.slice(0, 12)) await h.dm('gif', { user: u, attachments: [pic()] });
  t.mock.timers.tick(61_000);
  for (const u of users.slice(12, 22)) await h.dm('gif', { user: u, attachments: [pic()] });
  state.gate = null;
  release();
  await svc.idle();
  await h.settle();
  const got = users.filter((u) => filesIn(dmOf(u)).length === 1);
  assert.equal(got.length, 20);
  assert.deepEqual([svc.stats().done, svc.stats().failed, svc.stats().sentLastMinute], [20, 2, 20]);
  for (const u of users.slice(0, 22).filter((x) => !got.includes(x))) {
    assert.match(lastText(dmOf(u)), /20 files a minute/);
    assert.match(lastText(dmOf(u)), /Try again in 60 seconds/);
  }
  await h.dm('gif', { user: users[22], attachments: [pic()] });
  await svc.idle();
  assert.match(lastText(dmOf(users[22])), /20 files a minute/);
  assert.equal(state.jobs.length, 22);
  t.mock.timers.tick(60_000);
  await h.dm('gif', { user: users[22], attachments: [pic()] });
  await svc.idle();
  await h.settle();
  assert.equal(filesIn(dmOf(users[22])).length, 1);
});

test('the cooldown follows the person from a DM into a server and back', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const { state, dm, say, lastText, filesIn } = await make();
  await dm('gif', { attachments: [pic()] });
  assert.equal(filesIn(dmOf(IDS.member)).length, 1);
  await say('!gif', { attachment: 'abc/pic.png' });
  assert.match(lastText(G), /Give me 10 seconds/);
  assert.equal(filesIn(G).length, 0);
  t.mock.timers.tick(10_001);
  await say('!gif', { attachment: 'abc/pic.png' });
  assert.equal(filesIn(G).length, 1);
  await dm('gif', { attachments: [pic()] });
  assert.match(lastText(dmOf(IDS.member)), /Give me 10 seconds/);
  assert.equal(state.jobs.length, 2);
});

test('someone hammering Studio gets one slow-down notice and then silence', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const { h, state, dm, lastText, svc } = await make();
  const cid = dmOf(IDS.member);
  for (let i = 0; i < 5; i++) await dm('gif');
  assert.equal(h.sent(cid).length, 5);
  assert.match(lastText(cid), /I need a picture/);
  await dm('gif', { attachments: [pic()] });
  assert.equal(h.sent(cid).length, 6);
  assert.match(lastText(cid), /Slow down a little/);
  for (let i = 0; i < 30; i++) await dm('caption again', { attachments: [pic()] });
  assert.equal(h.sent(cid).length, 6);
  assert.equal(state.urls.length, 0);
  assert.equal(state.jobs.length, 0);
  assert.equal(svc.stats().refused, 31);
  await dm('gif', { user: IDS.member2, attachments: [pic()] });
  assert.equal(state.jobs.length, 1);
  t.mock.timers.tick(10_001);
  await dm('gif', { attachments: [pic()] });
  assert.equal(state.jobs.length, 2);
});

test('hostile file names and paths never reach the renderer or the reply', async () => {
  const { state, dm, say, lastText, filesIn, svc } = await make();
  const nasty = '-y concat:C:\\Windows\\win.ini|x.png';
  await dm('caption $(calc) `calc` %{pts} ; & | "quoted" \'single\' [x]', { attachments: [pic({ path: 'abc/-i.png', name: nasty })] });
  assert.equal(filesIn(dmOf(IDS.member)).length, 1);
  const job = state.jobs[0];
  assert.equal(path.basename(job.input), 'in.png');
  assert.equal(path.dirname(job.input), job.dir);
  assert.match(path.basename(job.dir), /^yapos-studio-[0-9a-f]{16}-.{6}$/);
  assert.equal(path.dirname(job.output), job.dir);
  for (const f of job.lineFiles) assert.match(path.basename(f), /^line-480-\d\.txt$/);
  const args = svc.buildArgs({ ...job, fontFile: job.fontFile || 'C:/Windows/Fonts/impact.ttf' });
  const flat = args.join('\n').split(path.basename(job.dir)).join('');
  for (const bad of ['concat:', 'win.ini', 'calc', 'quoted', 'pts', '-i.png']) assert.ok(!flat.includes(bad), bad);
  assert.equal(filesIn(dmOf(IDS.member))[0].files[0].name, 'caption.gif');

  await say('!gif', { attachment: 'abc/x.@everyone', user: IDS.member2 });
  assert.match(lastText(G), /That isn't a picture/);
  assert.ok(!lastText(G).includes('@everyone'));
  await dm('gif', { user: IDS.mod, attachments: [pic({ name: 'x.<@123>' })] });
  assert.ok(!lastText(dmOf(IDS.mod)).includes('<@'));

  for (const [i, p] of ['../../secret.png', 'abc/%2e%2e/%2e%2e/x.png', 'abc/pic.png?to=evil', '//evil.example/x.png'].entries()) {
    const user = uuid();
    await dm('gif', { user, attachments: [pic({ path: p })] });
    assert.match(lastText(dmOf(user)), /can't find where that picture lives/, `${i}`);
  }
  assert.equal(state.urls.length, 1);
});

test('a picture that hides its real size is refused before any work', async () => {
  const { state, dm, lastText, filesIn } = await make();
  const hidden = png(64, 64);
  hidden.write('tEXt', 12, 'latin1');
  state.body = hidden;
  await dm('gif', { attachments: [pic()] });
  assert.match(lastText(dmOf(IDS.member)), /I couldn't read that picture/);
  assert.equal(state.jobs.length, 0);
  assert.equal(filesIn(dmOf(IDS.member)).length, 0);
});

test('a download that stalls is given up on and the stream is closed', async () => {
  const { state, dm, lastText, filesIn, svc } = await make();
  svc.setLimits({ downloadMs: 60 });
  let cancelled = 0;
  state.respond = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(png(100, 100)); },
    cancel() { cancelled++; },
  }), { status: 200 });
  const started = Date.now();
  await dm('gif', { attachments: [pic()] });
  assert.match(lastText(dmOf(IDS.member)), /took too long/);
  assert.equal(cancelled, 1);
  assert.ok(Date.now() - started < 5000);

  state.respond = () => new Promise(() => {});
  await dm('gif', { user: IDS.member2, attachments: [pic()] });
  assert.match(lastText(dmOf(IDS.member2)), /took too long/);
  assert.equal(state.jobs.length, 0);
  assert.equal(filesIn(dmOf(IDS.member2)).length, 0);
  assert.deepEqual([svc.stats().running, svc.stats().waiting], [0, 0]);

  svc.setLimits();
  state.respond = null;
  await dm('gif', { user: IDS.mod, attachments: [pic()] });
  assert.equal(filesIn(dmOf(IDS.mod)).length, 1);
  assert.equal(state.init.redirect, 'manual');
  assert.equal(state.init.credentials, 'omit');
});

test('leftover work folders from a stopped run are cleared, and nothing else is touched', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yapos-studio-test-'));
  try {
    const old = new Date(Date.now() - 3600_000);
    const names = { stale: 'yapos-studio-0123456789abcdef-Ab12Cd', legacy: 'yapos-studio-Zz99Yy', fresh: 'yapos-studio-fedcba9876543210-Qq11Ww', other: 'yapos-studio-test-Ab12Cd', unrelated: 'holiday-photos' };
    for (const name of Object.values(names)) {
      await fsp.mkdir(path.join(root, name));
      await fsp.writeFile(path.join(root, name, 'in.png'), 'x');
    }
    await fsp.writeFile(path.join(root, 'yapos-studio-aaaaaaaaaaaaaaaa-file00'), 'x');
    for (const key of ['stale', 'legacy', 'other', 'unrelated']) await fsp.utimes(path.join(root, names[key]), old, old);
    await fsp.utimes(path.join(root, 'yapos-studio-aaaaaaaaaaaaaaaa-file00'), old, old);
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'yapos-studio-test-'));
    await fsp.writeFile(path.join(outside, 'keep.txt'), 'keep');
    let linked = false;
    try {
      await fsp.symlink(outside, path.join(root, 'yapos-studio-bbbbbbbbbbbbbbbb-link00'), 'junction');
      linked = true;
    } catch {
      linked = false;
    }
    if (linked) await fsp.lutimes(path.join(root, 'yapos-studio-bbbbbbbbbbbbbbbb-link00'), old, old).catch(() => {});
    assert.equal(await sweepStale(root), 2);
    const left = (await fsp.readdir(root)).sort();
    assert.ok(!left.includes(names.stale));
    assert.ok(!left.includes(names.legacy));
    for (const key of ['fresh', 'other', 'unrelated']) assert.ok(left.includes(names[key]), key);
    assert.ok(left.includes('yapos-studio-aaaaaaaaaaaaaaaa-file00'));
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
    if (linked) assert.ok(left.includes('yapos-studio-bbbbbbbbbbbbbbbb-link00'));
    assert.equal(await sweepStale(path.join(root, 'no-such-folder')), 0);
    await fsp.rm(outside, { recursive: true, force: true });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('at most 20 files a minute, then people are told when to try again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const { dm, svc, state, filesIn, lastText } = await make();
  const users = Array.from({ length: 22 }, () => uuid());
  for (let i = 0; i < 20; i++) {
    await dm('gif', { user: users[i], attachments: [pic()] });
    if (i === 9) t.mock.timers.tick(15_000);
  }
  assert.equal(state.jobs.length, 20);
  assert.equal(svc.stats().filesLastMinute, 20);
  await dm('gif', { user: users[20], attachments: [pic()] });
  assert.match(lastText(dmOf(users[20])), /20 files a minute/);
  assert.match(lastText(dmOf(users[20])), /Try again in 45 seconds/);
  assert.equal(filesIn(dmOf(users[20])).length, 0);
  assert.equal(state.jobs.length, 20);
  t.mock.timers.tick(45_000);
  await dm('gif', { user: users[21], attachments: [pic()] });
  assert.equal(filesIn(dmOf(users[21])).length, 1);
});

test('when file sending is off, people are told plainly and it is not retried', async () => {
  const { h, state, dm, say, lastText, filesIn } = await make({ features: { files: false } });
  const cid = dmOf(IDS.member);
  await dm('caption hello', { attachments: [pic()] });
  assert.match(lastText(cid), /Yapin' hasn't switched on file sending/);
  assert.ok(!/400|flag|bot_uploads/.test(lastText(cid)));
  assert.equal(state.jobs.length, 1);
  assert.equal(h.engine.caps.state(null, 'files'), false);
  await dm('caption hello again', { user: IDS.member2, attachments: [pic()] });
  assert.match(lastText(dmOf(IDS.member2)), /Yapin' hasn't switched on file sending/);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.urls.length, 1);

  await say('!caption in the server', { attachment: 'abc/pic.png', user: IDS.mod });
  assert.match(lastText(G), /Yapin' hasn't switched on file sending/);
  assert.equal(h.engine.caps.state(S, 'files'), false);
  assert.equal(state.jobs.length, 2);
  await say('!gif', { attachment: 'abc/pic.png', user: IDS.admin });
  assert.equal(state.jobs.length, 2);
  assert.equal(filesIn(G).length, 0);
  assert.equal(filesIn(cid).length, 0);
});

test('without ffmpeg every request gets a plain message and it is logged once', async () => {
  const before = process.env.YAPOS_FFMPEG;
  process.env.YAPOS_FFMPEG = path.join(os.tmpdir(), 'yapos-no-such-ffmpeg-binary');
  try {
    const h = await createHarness({ apps: ['studio'] });
    const svc = h.engine.service('studio');
    let fetched = 0;
    svc.setFetch(async () => { fetched++; return new Response(png(10, 10)); });
    assert.equal(await svc.ready(), false);
    assert.equal(svc.stats().ffmpeg, null);
    await h.dm('caption hello', { attachments: [pic()] });
    await svc.idle();
    assert.match(h.textOf(h.lastSent(dmOf(IDS.member))), /owner needs to install ffmpeg/);
    await h.message('!gif', { attachment: 'abc/pic.png' });
    await svc.idle();
    assert.match(h.textOf(h.lastSent(G)), /owner needs to install ffmpeg/);
    assert.equal(fetched, 0);
    assert.equal(h.lines.filter((l) => /ffmpeg was not found/.test(l)).length, 1);
  } finally {
    if (before === undefined) delete process.env.YAPOS_FFMPEG;
    else process.env.YAPOS_FFMPEG = before;
  }
});

test('a renderer failure is friendly and never shows raw output', async () => {
  const { state, dm, lastText, filesIn, svc } = await make();
  state.fail = Object.assign(new Error('ffmpeg exited with 187'), { stderr: '[png @ 000001] Invalid data found when processing input' });
  await dm('caption boom', { attachments: [pic()] });
  const cid = dmOf(IDS.member);
  assert.match(lastText(cid), /couldn't turn that picture into a GIF/);
  assert.ok(!/187|Invalid data|exited|stderr/.test(lastText(cid)));
  assert.equal(filesIn(cid).length, 0);
  assert.equal(svc.stats().failed, 1);

  state.fail = Object.assign(new Error('ffmpeg timed out'), { timedOut: true });
  await dm('gif', { user: IDS.member2, attachments: [pic()] });
  assert.match(lastText(dmOf(IDS.member2)), /took too long/);

  state.fail = null;
  state.out = Buffer.from('this is not a gif at all');
  await dm('gif', { user: IDS.mod, attachments: [pic()] });
  assert.match(lastText(dmOf(IDS.mod)), /couldn't turn that picture into a GIF/);
});

test('an oversized result is retried once at 320 px and 10 fps, then refused', async () => {
  const big = () => { const b = Buffer.alloc(Math.floor(9.5 * MB) + 1); gifHead(480, 400).copy(b); return b; };
  const { state, dm, lastText, filesIn } = await make();
  state.out = (job) => (job.maxWidth === 480 ? big() : gifHead(320, 266));
  await dm('caption retry me', { attachments: [pic()] });
  assert.equal(state.jobs.length, 2);
  assert.deepEqual([state.jobs[0].maxWidth, state.jobs[0].fps, state.jobs[0].outWidth], [480, 15, 480]);
  assert.deepEqual([state.jobs[1].maxWidth, state.jobs[1].fps, state.jobs[1].outWidth], [320, 10, 320]);
  assert.ok(state.jobs[1].layout.fontSize < state.jobs[0].layout.fontSize);
  assert.equal(filesIn(dmOf(IDS.member)).length, 1);

  state.out = big;
  await dm('gif', { user: IDS.member2, attachments: [pic()] });
  assert.equal(state.jobs.length, 4);
  assert.match(lastText(dmOf(IDS.member2)), /too large/i);
  assert.match(lastText(dmOf(IDS.member2)), /9\.5 MB/);
  assert.equal(filesIn(dmOf(IDS.member2)).length, 0);
});

test('the temp folder is removed after success and after failure', async () => {
  const { state, dm } = await make();
  let seenDuring = null;
  state.out = (job) => { seenDuring = fs.existsSync(job.input) && job.lineFiles.every((f) => fs.existsSync(f)); return gifHead(10, 10); };
  await dm('caption tidy up', { attachments: [pic()] });
  assert.equal(seenDuring, true);
  const ok = state.jobs[0];
  assert.ok(ok.dir.startsWith(os.tmpdir()));
  assert.match(path.basename(ok.dir), /^yapos-studio-/);
  assert.equal(fs.existsSync(ok.dir), false);

  state.fail = new Error('boom');
  await dm('caption fail', { user: IDS.member2, attachments: [pic()] });
  assert.equal(state.jobs.length, 2);
  assert.notEqual(state.jobs[1].dir, ok.dir);
  assert.equal(fs.existsSync(state.jobs[1].dir), false);
});

test('uninstalling Studio in a server stops its commands there', async () => {
  const { h, state, say, dm, filesIn, lastText } = await make();
  h.engine.settings.setEnabled(S, 'studio', false);
  await say('!caption hello', { attachment: 'abc/pic.png' });
  assert.match(lastText(G), /Studio isn't installed here/);
  const ans = await h.slash('gif', '');
  assert.match(h.textOf(ans[0]), /isn't installed here/);
  const viaYap = await h.slash('yap', 'caption hi');
  assert.match(h.textOf(viaYap[0]), /isn't installed here/);
  assert.equal(state.urls.length, 0);
  assert.equal(filesIn(G).length, 0);
  await dm('caption still fine in DMs', { attachments: [pic()] });
  assert.equal(filesIn(dmOf(IDS.member)).length, 1);
  h.engine.settings.setEnabled(S, 'studio', true);
  await say('!caption back again', { attachment: 'abc/pic.png', user: IDS.member2 });
  assert.equal(filesIn(G).length, 1);
});

test('Studio posts no buttons, so there is nothing of someone else to press', async () => {
  const { h, state, say, dm, filesIn } = await make();
  assert.deepEqual([...h.engine.router.handlers.keys()].filter((k) => k.startsWith('studio:')), []);
  const answers = [];
  for (const user of [IDS.member, IDS.member2, IDS.mod]) {
    const opened = await h.click(customId('system', 'open', 'studio'), { user });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].type, 'ephemeral');
    assert.match(h.textOf(opened[0]), /Turn a picture into a captioned GIF/);
    answers.push(...opened);
  }
  answers.push(...await h.slash('caption', 'hello', { user: IDS.member }));
  answers.push(...await h.slash('gif', '', { user: IDS.member2 }));
  answers.push(...await h.slash('yap', 'studio', { user: IDS.member }));
  answers.push(...await h.slash('yap', 'caption hi', { user: IDS.member2 }));
  for (const a of answers) {
    assert.equal(a.type, 'ephemeral');
    assert.equal(h.allButtons([a]).length, 0);
  }
  await say('!caption hello there', { attachment: 'abc/pic.png', user: IDS.member });
  await say('!gif', { user: IDS.member2 });
  await say('!yap studio', { user: IDS.mod });
  await dm('studio help', { user: IDS.member2 });
  await dm('caption', { user: IDS.member2, attachments: [pic()] });
  assert.equal(filesIn(G).length, 1);
  const posted = [...h.sent(G), ...h.sent(dmOf(IDS.member2))];
  assert.ok(posted.length >= 4);
  assert.equal(h.allButtons(posted).length, 0);
  for (const m of posted) assert.ok(!m.components?.length);
});

test('a forged Studio button does nothing, with or without a message behind it', async () => {
  const { h, state, say, svc, filesIn } = await make();
  await say('!caption hello there', { attachment: 'abc/pic.png', user: IDS.member });
  const gif = filesIn(G)[0];
  const before = { urls: state.urls.length, jobs: state.jobs.length, sent: h.sent(G).length, done: svc.stats().done };
  const forged = [customId('studio', 'caption', IDS.member), customId('studio', 'gif'), customId('studio', 'panel'), customId('studio', 'produce', 'abc/pic.png')];
  for (const user of [IDS.member2, IDS.mod, IDS.owner]) {
    for (const id of forged) {
      for (const messageId of [null, gif.id]) {
        const ans = await h.click(id, { user, messageId });
        assert.equal(ans.length, 1);
        assert.equal(ans[0].type, 'ephemeral');
        assert.match(h.textOf(ans[0]), /older panel/);
        assert.equal(h.allButtons(ans).length, 0);
      }
    }
  }
  await svc.idle();
  await h.settle();
  assert.deepEqual({ urls: state.urls.length, jobs: state.jobs.length, sent: h.sent(G).length, done: svc.stats().done }, before);
});

test('a reply only ever reads a picture from the channel the command was typed in', async () => {
  const { h, state, say, filesIn, lastText } = await make();
  const elsewhere = await h.message('staff only picture', { attachment: 'zzz/secret.png', user: IDS.mod, channel: IDS.channels.modlog });
  await say('!gif', { replyTo: elsewhere.id, user: IDS.member });
  assert.match(lastText(G), /That message has no picture/);
  assert.equal(state.urls.length, 0);
  assert.equal(filesIn(G).length, 0);
});

function addServer(h) {
  const B = uuid();
  const ch = uuid(5);
  const botRole = uuid(7);
  const memberRole = uuid(7);
  const st = h.fake.state;
  st.servers[B] = { id: B, name: 'Other Town', icon_path: null, owner_id: IDS.member2, member_count: 3, online_count: 1 };
  st.roles[B] = [
    { id: botRole, name: 'YapOS', color: null, position: 6, perms: { send_messages: true, embed_links: true, manage_messages: true }, auto: null, mentionable: false },
    { id: memberRole, name: 'Member', color: null, position: 1, perms: { send_messages: true }, auto: null, mentionable: false },
  ];
  st.members[B] = [
    { id: IDS.member2, username: 'riley', display_name: 'Riley', nickname: null, roles: [memberRole], joined_at: '2026-02-01T00:00:00Z' },
    { id: IDS.bot, username: 'yapos', display_name: 'YapOS', nickname: null, roles: [botRole], joined_at: '2026-02-02T00:00:00Z' },
    { id: IDS.member, username: 'sam', display_name: 'Sam', nickname: null, roles: [memberRole], joined_at: '2026-02-03T00:00:00Z' },
  ];
  st.channels[B] = [{ id: ch, name: 'general', type: 'text', kind: 'text', server_id: B, position: 0, category: null, category_id: null, private: false, read_only: false, slowmode: 0 }];
  st.bans[B] = [];
  st.everyone[B] = { send_messages: true, view_channel: true };
  return { B, ch };
}

const HOW_TO = /Turn a picture into a captioned GIF/;
const OPEN_STUDIO = customId('system', 'open', 'studio');
const TILE = /^yo:system:open:studio$/;

test('the Studio tile answers only the person whose home screen it is, and staff see nothing more than a member', async () => {
  const { h, state } = await make();
  const menu = await h.slash('menu', '', { user: IDS.member });
  const tile = h.findButton(TILE, menu);
  assert.ok(tile?.messageId, 'the home screen has a Studio tile');
  assert.equal(tile.custom_id, OPEN_STUDIO);
  const own = await h.click(tile.custom_id, { user: IDS.member, messageId: tile.messageId });
  assert.equal(own.length, 1);
  assert.equal(own[0].type, 'ephemeral');
  assert.match(h.textOf(own[0]), HOW_TO);
  assert.equal(h.allButtons(own).length, 0);
  h.addSecondAdmin();
  for (const user of [IDS.member2, IDS.mod, IDS.admin, IDS.admin2]) {
    const other = await h.click(tile.custom_id, { user, messageId: tile.messageId });
    assert.equal(other.length, 1);
    assert.equal(other[0].type, 'ephemeral');
    assert.match(h.textOf(other[0]), /Not your panel/);
    assert.doesNotMatch(h.textOf(other[0]), HOW_TO);
  }

  await h.message('!menu', { user: IDS.member2 });
  const typedTile = h.findButton(TILE, [h.lastSent(G)]);
  assert.ok(typedTile?.messageId, 'the typed home screen has a Studio tile');
  const barged = await h.click(typedTile.custom_id, { user: IDS.member, messageId: typedTile.messageId });
  assert.match(h.textOf(barged[0]), /Not your panel/);
  const second = await h.click(typedTile.custom_id, { user: IDS.member2, messageId: typedTile.messageId });
  assert.match(h.textOf(second[0]), HOW_TO);

  const ownerOnTheirs = await h.click(tile.custom_id, { user: IDS.owner, messageId: tile.messageId });
  assert.equal(ownerOnTheirs.length, 1);
  assert.doesNotMatch(h.textOf(ownerOnTheirs[0]), /Not your panel/);
  assert.equal(h.textOf(ownerOnTheirs[0]), h.textOf(own[0]));
  assert.equal(h.allButtons(ownerOnTheirs).length, 0);

  const ownerMenu = await h.slash('menu', '', { user: IDS.owner });
  const ownerTile = h.findButton(TILE, ownerMenu);
  const ownerView = await h.click(ownerTile.custom_id, { user: IDS.owner, messageId: ownerTile.messageId });
  assert.equal(h.textOf(ownerView[0]), h.textOf(own[0]));
  assert.equal(h.allButtons(ownerView).length, 0);
  assert.equal(state.urls.length, 0);
});

test('ids and values pasted onto the Studio tile change nothing', async () => {
  const { h, state, svc } = await make();
  const menu = await h.slash('menu', '', { user: IDS.member });
  const tile = h.findButton(TILE, menu);
  const plainView = h.textOf((await h.click(OPEN_STUDIO, { user: IDS.member }))[0]);
  assert.match(plainView, HOW_TO);
  const sentBefore = h.sent().length;
  const hostile = { text: 'x'.repeat(5000), path: '../../secret.png', user: IDS.owner, server: uuid(), role: IDS.roles.top, kind: 'admin' };
  for (const extra of [IDS.owner, IDS.member2, IDS.mod, IDS.roles.top, IDS.roles.admin, IDS.bot, uuid(), 'admin', 'owner']) {
    for (const messageId of [null, tile.messageId]) {
      const pressed = await h.click(customId('system', 'open', 'studio', extra), { user: IDS.member, messageId });
      assert.equal(pressed.length, 1);
      assert.equal(pressed[0].type, 'ephemeral');
      assert.equal(h.textOf(pressed[0]), plainView);
    }
  }
  const picked = await h.pick(OPEN_STUDIO, [IDS.owner, 'admin', 'mod'], { user: IDS.member, messageId: tile.messageId });
  assert.equal(h.textOf(picked[0]), plainView);
  const submitted = await h.submit(OPEN_STUDIO, hostile, { user: IDS.member });
  assert.equal(h.textOf(submitted[0]), plainView);
  for (const name of ['studio/../mod', 'STUDIO', '__proto__', 'constructor', 'studio mod', '']) {
    const odd = await h.click(customId('system', 'open', name), { user: IDS.member, messageId: tile.messageId });
    assert.equal(odd.length, 1);
    assert.equal(odd[0].type, 'ephemeral');
    assert.match(h.textOf(odd[0]), /Nothing to open/);
  }
  await svc.idle();
  assert.equal(h.sent().length, sentBefore);
  assert.deepEqual([state.urls.length, state.jobs.length], [0, 0]);
});

test('forged undo, form and Studio ids from a member do nothing, whatever values ride along', async () => {
  const { h, state, say, svc, filesIn } = await make();
  await say('!caption hello there', { attachment: 'abc/pic.png', user: IDS.member });
  const gif = filesIn(G)[0];
  const menu = await h.slash('menu', '', { user: IDS.member });
  const tile = h.findButton(TILE, menu);
  const before = { urls: state.urls.length, jobs: state.jobs.length, sent: h.sent().length, done: svc.stats().done, refused: svc.stats().refused };
  const hostile = { text: 'pwn', caption: 'pwn', path: 'zzz/secret.png', attachment: 'zzz/secret.png', reply_to_id: gif.id, user: IDS.owner };
  const ids = [
    customId('sys', 'undo', 'abc123'), customId('sys', 'undo', IDS.owner), customId('sys', 'form', 'abc123'), customId('sys', 'form', IDS.member2),
    customId('studio', 'caption'), customId('studio', 'gif', IDS.owner), customId('studio', 'request', 'caption', 'zzz/secret.png'), customId('studio', 'setLimits'), customId('studio', 'setRenderer'),
  ];
  for (const id of ids) {
    for (const messageId of [null, gif.id, tile.messageId]) {
      for (const press of [h.click, h.submit, h.pick]) {
        const ans = press === h.click ? await h.click(id, { user: IDS.member, messageId }) : await press(id, press === h.pick ? Object.values(hostile) : hostile, { user: IDS.member, messageId });
        assert.equal(ans.length, 1, id);
        assert.equal(ans[0].type, 'ephemeral', id);
        assert.match(h.textOf(ans[0]), /Too late to undo|This form expired|older panel/, id);
        assert.doesNotMatch(h.textOf(ans[0]), /\b[45]\d\d\b|Error|undefined/);
      }
    }
  }
  await svc.idle();
  await h.settle();
  assert.deepEqual({ urls: state.urls.length, jobs: state.jobs.length, sent: h.sent().length, done: svc.stats().done, refused: svc.stats().refused }, before);
});

test('a home screen opened before Studio was uninstalled cannot be replayed afterwards', async () => {
  const { h, state, say, filesIn, lastText } = await make();
  const picture = await say('look at my cat', { attachment: 'zzz/cat.jpg', user: IDS.member2 });
  const menu = await h.slash('menu', '', { user: IDS.member });
  const tile = h.findButton(TILE, menu);
  h.engine.settings.setEnabled(S, 'studio', false);
  for (const messageId of [tile.messageId, null]) {
    const replay = await h.click(tile.custom_id, { user: IDS.member, messageId });
    assert.equal(replay.length, 1);
    assert.match(h.textOf(replay[0]), /Studio isn't installed here/);
    assert.doesNotMatch(h.textOf(replay[0]), HOW_TO);
  }
  await say('!gif', { replyTo: picture.id, user: IDS.member });
  assert.match(lastText(G), /Studio isn't installed here/);
  await say('!yap gif', { replyTo: picture.id, user: IDS.member });
  assert.match(lastText(G), /Studio isn't installed here/);
  await say('!yap studio', { user: IDS.member });
  assert.match(lastText(G), /Studio isn't installed here/);
  const viaName = await h.slash('yap', 'Studio', { user: IDS.member });
  assert.match(h.textOf(viaName[0]), /isn't installed here/);
  assert.equal(state.urls.length, 0);
  assert.equal(filesIn(G).length, 0);
});

test('installing or removing Studio in one server changes nothing in another', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const { h, state, say, filesIn, lastText } = await make();
  const { B, ch } = addServer(h);
  h.engine.settings.setEnabled(B, 'studio', false);
  for (const id of [OPEN_STUDIO, customId('system', 'open', 'studio', S)]) {
    const pressed = await h.click(id, { user: IDS.member, server: B, channel: ch });
    assert.match(h.textOf(pressed[0]), /Studio isn't installed here/);
  }
  await say('!caption hi', { attachment: 'abc/pic.png', user: IDS.member, server: B, channel: ch });
  assert.match(lastText(ch), /Studio isn't installed here/);
  assert.equal(state.urls.length, 0);
  await say('!caption hi', { attachment: 'abc/pic.png', user: IDS.member });
  assert.equal(filesIn(G).length, 1);

  h.engine.settings.setEnabled(S, 'studio', false);
  h.engine.settings.setEnabled(B, 'studio', true);
  await say('!gif', { attachment: 'abc/pic.png', user: IDS.member2, server: B, channel: ch });
  assert.equal(filesIn(ch).length, 1);
  await say('!gif', { attachment: 'abc/pic.png', user: IDS.member2 });
  assert.match(lastText(G), /Studio isn't installed here/);
  assert.equal(filesIn(G).length, 1);

  t.mock.timers.tick(10_001);
  const secret = await h.message('staff only picture', { attachment: 'zzz/secret.png', user: IDS.mod, channel: IDS.channels.modlog });
  const urls = state.urls.length;
  await say('!gif', { replyTo: secret.id, user: IDS.member, server: B, channel: ch });
  assert.match(lastText(ch), /That message has no picture/);
  assert.equal(state.urls.length, urls);
  assert.equal(filesIn(ch).length, 1);
});

test('a reply that resolves to a message from another channel is never used as the picture', async () => {
  const { h, state, say, filesIn, lastText } = await make();
  const elsewhere = await h.message('staff only picture', { attachment: 'zzz/secret.png', user: IDS.mod, channel: IDS.channels.modlog });
  const stored = h.fake.state.messages[IDS.channels.modlog].find((m) => m.id === elsewhere.id);
  const real = h.bot.message.bind(h.bot);
  h.bot.message = async () => ({ ...stored });
  await say('!gif', { replyTo: elsewhere.id, user: IDS.member });
  assert.match(lastText(G), /That message has no picture/);
  await say('!caption got it', { replyTo: elsewhere.id, user: IDS.member2 });
  assert.match(lastText(G), /That message has no picture/);
  h.bot.message = async () => ({ ...stored, channel_id: G, deleted: true });
  await say('!gif', { replyTo: elsewhere.id, user: IDS.mod });
  assert.match(lastText(G), /That message has no picture/);
  assert.equal(state.urls.length, 0);
  assert.equal(filesIn(G).length, 0);

  h.bot.message = real;
  const here = await say('look at my cat', { attachment: 'zzz/cat.jpg', user: IDS.member2 });
  await say('!gif', { replyTo: here.id, user: IDS.admin });
  assert.deepEqual(state.urls, ['https://files.yapper.website/attachments/zzz/cat.jpg']);
  assert.equal(filesIn(G).length, 1);
});

test('a path or link typed as text is never downloaded, from chat or from the slash menu', async () => {
  const { h, state, say, filesIn, lastText } = await make();
  await say('!gif zzz/secret.png', { user: IDS.member });
  assert.match(lastText(G), /I need a picture/);
  await say(`!caption <@${IDS.owner}> https://files.yapper.website/attachments/zzz/secret.png`, { user: IDS.member2 });
  assert.match(lastText(G), /I need a picture/);
  await say('!yap gif /bots/default.png', { user: IDS.mod });
  assert.match(lastText(G), /I need a picture/);
  for (const [name, args] of [['caption', 'zzz/secret.png'], ['gif', 'https://files.yapper.website/attachments/zzz/secret.png'], ['yap', 'caption zzz/secret.png']]) {
    const ans = await h.slash(name, args, { user: IDS.member });
    assert.equal(ans.length, 1);
    assert.equal(ans[0].type, 'ephemeral');
    assert.match(h.textOf(ans[0]), /can't carry a picture/);
  }
  assert.equal(state.urls.length, 0);
  assert.equal(state.jobs.length, 0);
  assert.equal(filesIn(G).length, 0);
});

test('a DM reply cannot pull a picture out of a server channel', async () => {
  const { h, state, dm, say, filesIn, lastText } = await make();
  const cid = dmOf(IDS.member);
  const secret = await h.message('staff only picture', { attachment: 'zzz/secret.png', user: IDS.mod, channel: IDS.channels.modlog });
  const open = await say('look at my cat', { attachment: 'zzz/cat.jpg', user: IDS.member2 });
  const dmReply = async (text, replyTo) => {
    h.fake.state.dms[cid] = IDS.member;
    await h.bot.handle({ id: 900000 + h.sent().length, type: 'dm_message', data: { id: uuid(4), channel_id: cid, dm_channel_id: cid, server_id: null, is_dm: true, dm: true, author_id: IDS.member, author: 'sam', author_name: 'sam', content: text, attachment: null, attachments: [], reply_to_id: replyTo, created_at: new Date().toISOString(), author_bot: false } });
    await h.engine.service('studio').idle();
    await h.settle();
  };
  await dmReply('gif', secret.id);
  assert.match(lastText(cid), /That message has no picture/);
  await dmReply('caption mine now', open.id);
  assert.match(lastText(cid), /That message has no picture/);
  const stored = h.fake.state.messages[IDS.channels.modlog].find((m) => m.id === secret.id);
  h.bot.message = async () => ({ ...stored });
  await dmReply('gif', secret.id);
  assert.match(lastText(cid), /That message has no picture/);
  assert.equal(state.urls.length, 0);
  assert.equal(state.jobs.length, 0);
  assert.equal(filesIn(cid).length, 0);
  assert.equal(filesIn(G).length, 0);
});

const FFMPEG = await findFfmpeg();
const FONT = findFont();
const noFfmpeg = !FFMPEG && 'ffmpeg is not installed';
const noCaption = (!FFMPEG && 'ffmpeg is not installed') || (!FONT && 'no caption font on this machine');
const TRICKY = 'me: "100% sure" it\'s C:\\fine, %{pts} really; [ok] 50%\nsecond line: \\n stays';

function ffprobePath() {
  if (!FFMPEG) return null;
  const candidate = path.isAbsolute(FFMPEG) ? path.join(path.dirname(FFMPEG), `ffprobe${path.extname(FFMPEG)}`) : 'ffprobe';
  const r = spawnSync(candidate, ['-version'], { windowsHide: true });
  return r.status === 0 ? candidate : null;
}
const FFPROBE = ffprobePath();

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames:format=duration', '-of', 'json', file], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  const out = JSON.parse(String(r.stdout));
  return { width: out.streams[0].width, height: out.streams[0].height, frames: Number(out.streams[0].nb_read_frames), duration: Number(out.format.duration) };
}

let fixtures = null;
async function realSetup() {
  if (!fixtures) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yapos-studio-test-'));
    const gen = (args, name) => {
      const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', ...args, path.join(dir, name)], { windowsHide: true });
      assert.equal(r.status, 0, String(r.stderr));
      return fs.readFileSync(path.join(dir, name));
    };
    fixtures = {
      dir,
      png: gen(['-i', 'testsrc=size=320x240:rate=10', '-frames:v', '1'], 'still.png'),
      gif: gen(['-i', 'testsrc=size=160x120:rate=10', '-t', '1'], 'anim.gif'),
      jpg: gen(['-i', 'testsrc=size=100x80:rate=10', '-frames:v', '1'], 'small.jpg'),
      wide: gen(['-i', 'testsrc=size=1280x720:rate=10', '-frames:v', '1'], 'wide.png'),
      webp: gen(['-i', 'testsrc=size=120x90:rate=10', '-frames:v', '1'], 'still.webp'),
      fast: gen(['-i', 'testsrc=size=64x48:rate=30', '-t', '14'], 'fast.gif'),
    };
  }
  const h = await createHarness({ apps: ['studio'] });
  const svc = h.engine.service('studio');
  assert.equal(await svc.ready(), true);
  const check = async (buf, name) => {
    assert.ok(['GIF89a', 'GIF87a'].includes(buf.toString('latin1', 0, 6)), 'starts with a GIF header');
    assert.ok(buf.length > 300 && buf.length < 9.5 * MB, `sensible size (${buf.length})`);
    const size = imageSize(buf);
    const frames = gifFrames(buf);
    if (FFPROBE) {
      const file = path.join(fixtures.dir, name);
      await fsp.writeFile(file, buf);
      const p = probe(file);
      assert.deepEqual([p.width, p.height, p.frames], [size.width, size.height, frames]);
      return { ...size, frames, duration: p.duration };
    }
    return { ...size, frames, duration: null };
  };
  return { h, svc, check, ...fixtures };
}

test.after(async () => {
  if (fixtures) await fsp.rm(fixtures.dir, { recursive: true, force: true }).catch(() => {});
});

test('real ffmpeg: a still picture gets a caption bar on top', { skip: noCaption }, async () => {
  const { svc, check, png: still } = await realSetup();
  const out = await svc.produce({ kind: 'caption', data: still, text: 'when the code works first try' });
  const info = await check(out, 'caption-still.gif');
  assert.equal(info.width, 320);
  assert.ok(info.height > 240, `taller than the input (${info.height})`);
  assert.equal(info.height % 2, 0);
  assert.equal(info.frames, 1);
  const layout = svc.wrapText('when the code works first try', { width: 320 });
  assert.equal(info.height, 240 + layout.barHeight);
});

test('real ffmpeg: an animated GIF stays animated under a caption full of special characters', { skip: noCaption }, async () => {
  const { svc, check, gif } = await realSetup();
  const out = await svc.produce({ kind: 'caption', data: gif, text: TRICKY });
  const info = await check(out, 'caption-anim.gif');
  assert.equal(info.width, 240);
  assert.ok(info.height > 180, `taller than the scaled input (${info.height})`);
  assert.ok(info.frames > 1, `more than one frame (${info.frames})`);
  assert.equal(info.frames, gifFrames(gif));
});

test('real ffmpeg: caption text files and the font work from a folder with awkward characters', { skip: noCaption }, async () => {
  const { svc, check, png: still, dir } = await realSetup();
  const odd = path.join(dir, "it's a [odd], dir; 100% = ok");
  await fsp.mkdir(odd);
  let job = null;
  const out = await svc.produce({ kind: 'caption', data: still, text: TRICKY, tmpRoot: odd, onJob: (j) => { job = j; } });
  const info = await check(out, 'caption-odd.gif');
  assert.ok(info.height > 240);
  assert.ok(job.dir.startsWith(odd));
  assert.ok(job.lineFiles.length >= 2);
  assert.deepEqual(await fsp.readdir(odd), []);
});

test('real ffmpeg: a narrow tall picture is enlarged so the caption keeps whole words', { skip: noCaption }, async () => {
  const { svc, check, dir } = await realSetup();
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=40x400:rate=10', '-frames:v', '1', path.join(dir, 'narrow.png')], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  let job = null;
  const out = await svc.produce({ kind: 'caption', data: fs.readFileSync(path.join(dir, 'narrow.png')), text: 'narrow and very tall picture', onJob: (j) => { job = j; } });
  const info = await check(out, 'caption-narrow.gif');
  assert.equal(info.width, 204);
  assert.equal(info.height, 2040 + job.layout.barHeight);
  assert.equal(job.layout.lines.join(' '), 'narrow and very tall picture');
  assert.equal(job.layout.truncated, false);
});

test('real ffmpeg: gif converts stills and keeps animations moving', { skip: noFfmpeg }, async () => {
  const { svc, check, png: still, gif, webp, jpg } = await realSetup();
  const one = await check(await svc.produce({ kind: 'gif', data: still }), 'gif-still.gif');
  assert.deepEqual([one.width, one.height, one.frames], [320, 240, 1]);
  const many = await check(await svc.produce({ kind: 'gif', data: gif }), 'gif-anim.gif');
  assert.deepEqual([many.width, many.height], [160, 120]);
  assert.ok(many.frames > 1);
  const fromWebp = await check(await svc.produce({ kind: 'gif', data: webp }), 'gif-webp.gif');
  assert.deepEqual([fromWebp.width, fromWebp.height, fromWebp.frames], [120, 90, 1]);
  const fromJpg = await check(await svc.produce({ kind: 'gif', data: jpg }), 'gif-jpg.gif');
  assert.deepEqual([fromJpg.width, fromJpg.height, fromJpg.frames], [100, 80, 1]);
});

test('real ffmpeg: wide pictures are scaled to 480 and sideways photos are turned upright', { skip: noFfmpeg }, async () => {
  const { svc, check, wide, jpg } = await realSetup();
  const scaled = await check(await svc.produce({ kind: 'gif', data: wide }), 'gif-wide.gif');
  assert.deepEqual([scaled.width, scaled.height], [480, 270]);
  const sideways = Buffer.concat([jpg.subarray(0, 2), exifSegment(6), jpg.subarray(2)]);
  assert.deepEqual(imageSize(sideways), { width: 80, height: 100, orientation: 6, animated: false });
  const turned = await check(await svc.produce({ kind: 'gif', data: sideways }), 'gif-turned.gif');
  assert.deepEqual([turned.width, turned.height], [80, 100]);
});

test('real ffmpeg: long fast animations are capped at 15 fps and 12 seconds', { skip: noFfmpeg }, async () => {
  const { svc, check, fast } = await realSetup();
  assert.ok(gifFrames(fast) > 400);
  const info = await check(await svc.produce({ kind: 'gif', data: fast }), 'gif-fast.gif');
  assert.ok(info.frames > 100 && info.frames <= 181, `frames ${info.frames}`);
  if (info.duration !== null) assert.ok(info.duration <= 12.2, `duration ${info.duration}`);
});

test('real ffmpeg: the whole DM flow sends a real GIF, and a damaged picture fails kindly', { skip: noCaption }, async () => {
  const { h, svc, png: still } = await realSetup();
  let body = still;
  svc.setFetch(async () => new Response(body, { status: 200 }));
  await h.dm('caption it really works', { attachments: [pic()] });
  await svc.idle();
  await h.settle();
  const cid = dmOf(IDS.member);
  const sent = h.sent(cid).filter((m) => m.files?.length);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].files[0].name, 'caption.gif');
  assert.ok(sent[0].files[0].text.startsWith('GIF8'));
  assert.ok(sent[0].files[0].size > 1000);

  body = Buffer.concat([png(64, 64), Buffer.from('this is definitely not picture data '.repeat(20))]);
  await h.dm('gif', { user: IDS.member2, attachments: [pic()] });
  await svc.idle();
  await h.settle();
  const text = h.textOf(h.lastSent(dmOf(IDS.member2)));
  assert.match(text, /couldn't turn that picture into a GIF/);
  assert.ok(!/Invalid data|png_pipe|Error|exited/.test(text));
  assert.equal(svc.stats().running, 0);
});

function webpBomb(FFMPEG_BIN, dir) {
  const r = spawnSync(FFMPEG_BIN, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=4200x4200:rate=1', '-frames:v', '1', '-lossless', '1', path.join(dir, 'huge.webp')], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  const real = fs.readFileSync(path.join(dir, 'huge.webp'));
  const claim = Buffer.alloc(18);
  claim.write('VP8X', 0, 'latin1');
  claim.writeUInt32LE(10, 4);
  claim.writeUIntLE(99, 12, 3);
  claim.writeUIntLE(99, 15, 3);
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), claim, real.subarray(12)]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return { real, bomb: Buffer.concat([head, body]) };
}

test('real ffmpeg: a tiny file that unpacks to a huge picture is stopped by the pixel limit', { skip: noFfmpeg }, async () => {
  const { h, svc, dir } = await realSetup();
  const { real, bomb } = webpBomb(FFMPEG, dir);
  assert.ok(bomb.length < 4096, `the bomb is tiny (${bomb.length} bytes)`);
  assert.deepEqual(imageSize(real), { width: 4200, height: 4200, orientation: 1, animated: false });
  assert.deepEqual(imageSize(bomb), { width: 100, height: 100, orientation: 1, animated: false });
  let job = null;
  await assert.rejects(svc.produce({ kind: 'gif', data: bomb, onJob: (j) => { job = j; } }), (e) => !e.friendly && /exited/.test(e.message) && /max pixel count/.test(e.stderr));
  assert.equal(fs.existsSync(job.dir), false);

  svc.setFetch(async () => new Response(bomb, { status: 200 }));
  await h.dm('gif', { attachments: [pic({ path: 'abc/small.webp', name: 'small.webp', width: 100, height: 100 })] });
  await svc.idle();
  await h.settle();
  const text = h.textOf(h.lastSent(dmOf(IDS.member)));
  assert.match(text, /couldn't turn that picture into a GIF/);
  assert.ok(!/pixel|IMGUTILS|webp @|yapos-studio|Temp|exited/.test(text));
  assert.equal(h.sent(dmOf(IDS.member)).filter((m) => m.files?.length).length, 0);
});

test('real ffmpeg: other protocols and extra inputs are refused by ffmpeg itself', { skip: noFfmpeg }, async () => {
  const { svc, dir, png: still } = await realSetup();
  const secret = path.join(dir, 'secret.png');
  await fsp.writeFile(secret, still);
  const base = { kind: 'gif', type: 'png', dir, output: path.join(dir, 'leak.gif'), outWidth: 320, outHeight: 240, orientation: 1, animated: false, fps: 15, seconds: 12 };
  const ok = spawnSync(FFMPEG, svc.buildArgs({ ...base, input: secret }), { windowsHide: true });
  assert.equal(ok.status, 0, String(ok.stderr));
  await fsp.rm(base.output, { force: true });
  for (const input of [`concat:${secret}`, `subfile,,start,0,end,${still.length},,:${secret}`, 'pipe:0', 'http://127.0.0.1:9/x.png', 'data:image/png;base64,AAAA', `crypto:${secret}`]) {
    const r = spawnSync(FFMPEG, svc.buildArgs({ ...base, input }), { windowsHide: true, input: still });
    assert.notEqual(r.status, 0, input);
    assert.equal(fs.existsSync(base.output), false, input);
  }
});

test('real ffmpeg: a render that runs out of time is killed and its folder removed', { skip: noFfmpeg }, async () => {
  const { h, svc, fast } = await realSetup();
  svc.setLimits({ renderMs: 1 });
  let job = null;
  await assert.rejects(svc.produce({ kind: 'gif', data: fast, onJob: (j) => { job = j; } }), (e) => e.timedOut === true);
  assert.equal(svc.stats().processes, 0);
  assert.equal(fs.existsSync(job.dir), false);

  svc.setFetch(async () => new Response(fast, { status: 200 }));
  await h.dm('gif', { attachments: [pic({ path: 'abc/fast.gif', name: 'fast.gif', width: 64, height: 48 })] });
  await svc.idle();
  await h.settle();
  assert.match(h.textOf(h.lastSent(dmOf(IDS.member))), /took too long/);
  assert.deepEqual([svc.stats().running, svc.stats().processes], [0, 0]);
  svc.setLimits();
  const out = await svc.produce({ kind: 'gif', data: fast });
  assert.equal(out.toString('latin1', 0, 3), 'GIF');
});

test('real ffmpeg: the output stops growing just past the size limit and tall animations are shrunk', { skip: noFfmpeg }, async () => {
  const { svc, check, dir } = await realSetup();
  const gen = (args, name) => {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', ...args, path.join(dir, name)], { windowsHide: true });
    assert.equal(r.status, 0, String(r.stderr));
    return path.join(dir, name);
  };
  const noisy = gen(['-i', 'testsrc2=size=480x640:rate=15,noise=alls=100:allf=t', '-t', '12'], 'noisy.gif');
  assert.ok(fs.statSync(noisy).size > 40 * MB);
  const job = { kind: 'gif', type: 'gif', dir, input: noisy, output: path.join(dir, 'stopped.gif'), outWidth: 480, outHeight: 640, orientation: 1, animated: true, fps: 15, seconds: 12 };
  const r = spawnSync(FFMPEG, svc.buildArgs(job), { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  const size = fs.statSync(job.output).size;
  assert.ok(size > Math.floor(9.5 * MB), `still counts as too large (${size})`);
  assert.ok(size < 13 * MB, `stopped early (${size})`);
  await fsp.rm(noisy, { force: true });
  await fsp.rm(job.output, { force: true });

  const tall = fs.readFileSync(gen(['-i', 'testsrc2=size=480x2000:rate=10', '-t', '1'], 'tall.gif'));
  const info = await check(await svc.produce({ kind: 'gif', data: tall }), 'gif-tall.gif');
  assert.ok(info.width * info.height <= 480 * 640 * 1.02, `${info.width}x${info.height}`);
  assert.ok(info.frames > 1);
  assert.ok(Math.abs(info.height / info.width - 2000 / 480) < 0.05);
});

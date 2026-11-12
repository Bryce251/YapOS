import { createCall, LIMITS, formatBytes } from './limits.js';

const NAMES = ['Pip', 'Juno', 'Rex', 'Mila', 'Ozzy', 'Tess', 'Bo', 'Kit'];
const MAX_PLAYERS = 8;
const START_PLAYERS = 3;
const LOG_LIMIT = 200;
const ORIGIN = location.origin;

const call = createCall();
const players = [];
let seq = 0;
let latency = 0;
let instance = newId();
let warnings = 0;
let picked = null;
let drawQueued = false;

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function participant(p) {
  return { id: p.id, display_name: p.name, username: p.name.toLowerCase().replace(/\s+/g, ''), avatar_url: null };
}

const participants = () => players.map(participant);
const hostId = () => (players[0] ? players[0].id : null);
const nameOf = (id) => players.find((p) => p.id === id)?.name || 'Someone who left';

function log(text, level = 'info') {
  const list = $('log');
  const item = el('li', `log-item ${level}`);
  const time = new Date();
  item.append(el('time', 'log-time', time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), el('span', 'log-text', text));
  list.prepend(item);
  while (list.children.length > LOG_LIMIT) list.lastElementChild.remove();
  if (level === 'warn') {
    warnings += 1;
    const badge = $('warn-count');
    badge.textContent = String(warnings);
    badge.hidden = false;
  }
}

function warn(p, result) {
  const text = result.personal === false || !p ? result.text : `${p.name} ${result.text}`;
  log(text, 'warn');
  if (!p || !p.tile) return;
  p.tile.classList.remove('flash');
  void p.tile.offsetWidth;
  p.tile.classList.add('flash');
  p.refs.warn.textContent = result.text.replace(/^./, (c) => c.toUpperCase());
  p.refs.warn.hidden = false;
  clearTimeout(p.warnTimer);
  p.warnTimer = setTimeout(() => {
    p.refs.warn.hidden = true;
  }, 6000);
}

function schedule(p, lane, fn) {
  const now = performance.now();
  const at = Math.max(now + latency, p[lane]);
  p[lane] = at;
  setTimeout(fn, Math.max(0, at - now));
}

function deliver(p, msg) {
  schedule(p, 'downAt', () => {
    if (!players.includes(p) || !p.frame.contentWindow) return;
    p.frame.contentWindow.postMessage({ yapper: 1, ...msg }, ORIGIN);
  });
}

function broadcast(msg, except = null) {
  for (const p of players) if (p.ready && p !== except) deliver(p, msg);
}

function sendInit(p) {
  deliver(p, { type: 'init', me: participant(p), host: hostId(), participants: participants(), state: call.snapshot(), instance });
}

function sendParticipants() {
  broadcast({ type: 'participants', participants: participants(), host: hostId() });
}

function handle(p, m) {
  if (!players.includes(p)) return;
  if (m.type === 'ready') {
    const again = p.ready;
    p.ready = true;
    p.refs.status.textContent = 'Connected';
    p.tile.classList.add('ready');
    log(again ? `${p.name} said hello again and got a fresh copy of everything.` : `${p.name} loaded the activity.`);
    sendInit(p);
    return;
  }
  if (!p.ready) {
    warn(p, { text: `sent "${m.type}" before saying hello, so it was ignored.` });
    return;
  }
  if (m.type === 'set') {
    const result = call.set(p.id, m.key, m.val);
    if (!result.ok) return warn(p, result);
    broadcast({ type: 'state', key: result.key, val: result.val, by: p.id });
    queueDraw();
    return;
  }
  if (m.type === 'send') {
    const result = call.send(p.id, m.data);
    if (!result.ok) return warn(p, result);
    broadcast({ type: 'message', data: result.data, by: p.id }, p);
    queueDraw();
    return;
  }
  if (m.type === 'close') {
    log(`${p.name} closed the activity.`);
    removePlayer(p);
    return;
  }
  warn(p, { text: `sent a message type the call does not know: "${String(m.type).slice(0, 40)}".` });
}

addEventListener('message', (e) => {
  if (e.origin !== ORIGIN) return;
  const p = players.find((x) => x.frame.contentWindow === e.source);
  if (!p) return;
  const m = e.data;
  if (!m || m.yapper !== 1 || typeof m.type !== 'string') return;
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(m));
  } catch {
    warn(p, { text: 'sent something that is not plain JSON, so it was dropped.' });
    return;
  }
  schedule(p, 'upAt', () => handle(p, copy));
});

function frameSrc(p) {
  return `/activity/?dev=1&as=${p.n}`;
}

function buildTile(p) {
  const tile = el('article', 'tile');
  const head = el('header', 'tile-head');
  const who = el('div', 'who');
  const avatar = el('span', 'avatar', p.name.slice(0, 1));
  avatar.dataset.tone = String(p.n % 6);
  const label = el('div', 'who-text');
  const nameLine = el('strong', 'who-name', p.name);
  const host = el('span', 'host-badge', 'Host');
  host.hidden = true;
  nameLine.append(' ', host);
  const status = el('span', 'who-status', 'Loading');
  label.append(nameLine, status);
  who.append(avatar, label);
  const ops = el('span', 'ops', `0 / ${LIMITS.perPerson}`);
  ops.title = 'Sets and sends in the last 10 seconds';
  const actions = el('div', 'tile-actions');
  const reload = el('button', 'btn small', 'Reload');
  reload.type = 'button';
  reload.title = 'Reload this player to test joining late';
  reload.addEventListener('click', () => reloadPlayer(p));
  const leave = el('button', 'btn small', 'Leave');
  leave.type = 'button';
  leave.addEventListener('click', () => {
    log(`${p.name} left the call.`);
    removePlayer(p);
  });
  actions.append(ops, reload, leave);
  head.append(who, actions);
  const warnLine = el('p', 'tile-warn');
  warnLine.hidden = true;
  warnLine.setAttribute('role', 'status');
  const frame = el('iframe', 'frame');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', '');
  frame.title = `YapOS Party as ${p.name}`;
  frame.src = frameSrc(p);
  const wrap = el('div', 'frame-wrap');
  wrap.append(frame);
  tile.append(head, warnLine, wrap);
  p.tile = tile;
  p.frame = frame;
  p.refs = { host, status, ops, warn: warnLine };
  return tile;
}

function addPlayer() {
  if (players.length >= MAX_PLAYERS) {
    warn(null, { text: `This test call holds up to ${MAX_PLAYERS} players. Remove someone first.`, personal: false });
    return;
  }
  seq += 1;
  const base = NAMES[(seq - 1) % NAMES.length];
  const round = Math.floor((seq - 1) / NAMES.length);
  const p = { n: seq, id: newId(), name: round ? `${base} ${round + 1}` : base, ready: false, upAt: 0, downAt: 0 };
  players.push(p);
  $('stage').append(buildTile(p));
  log(`${p.name} joined the call${players.length === 1 ? ' and is the host' : ''}.`);
  sendParticipants();
  queueDraw();
}

function removePlayer(p) {
  const i = players.indexOf(p);
  if (i < 0) return;
  const wasHost = i === 0;
  players.splice(i, 1);
  clearTimeout(p.warnTimer);
  p.frame.src = 'about:blank';
  p.tile.remove();
  call.forget(p.id);
  if (!players.length) {
    call.clear();
    instance = newId();
    picked = null;
    log('Everyone left, so the activity stopped and the shared state was cleared.', 'warn');
  } else {
    if (wasHost) log(`The host left. ${players[0].name} is the new host.`);
    sendParticipants();
  }
  queueDraw();
}

function reloadPlayer(p) {
  p.ready = false;
  p.tile.classList.remove('ready');
  p.refs.status.textContent = 'Loading';
  p.frame.src = 'about:blank';
  setTimeout(() => {
    if (players.includes(p)) p.frame.src = frameSrc(p);
  }, 30);
  log(`${p.name} is reloading and will rejoin from the shared state.`);
}

function restart() {
  call.clear();
  instance = newId();
  picked = null;
  log('The activity restarted with empty shared state.');
  for (const p of players) reloadPlayer(p);
  queueDraw();
}

function meter(id, used, max) {
  const node = $(id);
  const pct = Math.min(100, Math.round((used / max) * 100));
  node.style.setProperty('--fill', String(pct));
  node.classList.toggle('high', pct >= 80);
}

function queueDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function draw() {
  const host = hostId();
  for (const p of players) {
    p.refs.host.hidden = p.id !== host;
    const ops = call.opsFor(p.id);
    p.refs.ops.textContent = `${ops} / ${LIMITS.perPerson}`;
    p.refs.ops.classList.toggle('high', ops >= LIMITS.perPerson * 0.8);
  }
  $('remove-host').disabled = !players.length;
  $('add').disabled = players.length >= MAX_PLAYERS;
  meter('keys-meter', call.keys, LIMITS.keys);
  $('keys-text').textContent = `${call.keys} / ${LIMITS.keys}`;
  meter('bytes-meter', call.bytes, LIMITS.stateBytes);
  $('bytes-text').textContent = `${formatBytes(call.bytes)} / 64 KB`;
  const callOps = call.callOpsCount();
  meter('ops-meter', callOps, LIMITS.perCall);
  $('ops-text').textContent = `${callOps} / ${LIMITS.perCall}`;
  const rows = call.list();
  const list = $('keys');
  list.replaceChildren(...rows.map((r) => {
    const item = el('li');
    const btn = el('button', `key${r.key === picked ? ' on' : ''}`);
    btn.type = 'button';
    btn.append(el('code', 'key-name', r.key), el('span', 'key-size', formatBytes(r.bytes)), el('span', 'key-by', nameOf(r.by)));
    btn.addEventListener('click', () => {
      picked = picked === r.key ? null : r.key;
      queueDraw();
    });
    item.append(btn);
    return item;
  }));
  $('keys-empty').hidden = rows.length > 0;
  const value = $('value');
  const row = rows.find((r) => r.key === picked);
  if (!row) picked = null;
  value.hidden = !row;
  if (row) value.textContent = `${row.key}\n${JSON.stringify(row.val, null, 2)}`;
}

function setWidth(v) {
  document.body.classList.remove('w-phone', 'w-small', 'w-wide');
  document.body.classList.add(`w-${v}`);
}

$('add').addEventListener('click', addPlayer);
$('remove-host').addEventListener('click', () => {
  if (players[0]) {
    log(`Removed the host, ${players[0].name}.`);
    removePlayer(players[0]);
  }
});
$('restart').addEventListener('click', restart);
$('latency').addEventListener('input', (e) => {
  latency = Number(e.target.value) || 0;
  $('latency-out').textContent = `${latency} ms`;
});
$('width').addEventListener('change', (e) => setWidth(e.target.value));
$('clear-log').addEventListener('click', () => {
  $('log').replaceChildren();
  warnings = 0;
  $('warn-count').hidden = true;
});

setWidth($('width').value);
setInterval(draw, 500);
for (let i = 0; i < START_PLAYERS; i += 1) addPlayer();
log('Each frame is the activity as a different person. The first player is the host.');

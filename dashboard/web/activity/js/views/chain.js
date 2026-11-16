import chain, { checkWord, usedFrom, PROBLEMS, MAX_LETTERS, wordRef, catProblem } from '../games/chain.js';
import { load as loadDictionary } from '../dictionary.js';
import { h, memo, timer, profileButton, button, plural, clock } from '../ui/dom.js';
import { textFlag } from '../ui/report.js';

export function speedText(span) {
  return `Speeding up! Turns are now ${span} s`;
}

export function eventText(m) {
  const said = [baseEvent(m), skipText(m)].filter(Boolean).join(' ');
  if (!m.sped || !m.span || m.phase !== 'turn') return said;
  return [said, `${speedText(m.span)}.`].filter(Boolean).join(' ');
}

export function skipText(m) {
  const p = m.skipped;
  if (!p || m.phase !== 'turn') return '';
  return p.isMe ? '❄️ You were frozen, so your turn was skipped.' : `❄️ ${p.name} was frozen, so their turn was skipped.`;
}

export function problemText(why, m) {
  if (why === 'cat' && m && m.cat) return catProblem(m.cat.id);
  return PROBLEMS[why] || 'That word does not work.';
}

function baseEvent(m) {
  const e = m.last;
  if (m.note === 'first' && m.cur) return `${m.cur.isMe ? 'You go' : `${m.cur.name} goes`} first.`;
  if (!e) return '';
  const who = e.isMe ? 'You' : e.name;
  if (e.kind === 'word') {
    if (m.vote) return '';
    if (e.bonus) return `💥 ${who} played “${e.w}”, ending on ${e.w.slice(-1).toUpperCase()} for double points!`;
    return `${who} played “${e.w}”.`;
  }
  if (e.kind === 'miss') return `${who} ran out of time and lost a life.`;
  if (e.kind === 'out') return e.isMe ? "You're out of lives!" : `${e.name} is out of lives!`;
  if (e.kind === 'reject') return `“${e.w}” was voted not a word. ${who} lost a life.`;
  if (e.kind === 'left') return `${e.name} left, so their turn was skipped.`;
  if (e.kind === 'time') return "Time's up!";
  if (e.kind === 'skip') return `An admin skipped ${e.isMe ? 'your' : `${e.name}'s`} turn. No life lost.`;
  return '';
}

export function turnText(m) {
  if (m.phase !== 'turn' || !m.cur) return m.fin ? 'Most lives left wins, then most points.' : 'That’s the game!';
  const L = m.letter.toUpperCase();
  if (m.myTurn && m.cat && m.catOn) return `Your turn! Type ${m.cat.what} that starts with ${L}.`;
  if (m.myTurn) return `Your turn! Type a word that starts with ${L}.`;
  if (!m.playing) return `You're watching. ${m.cur.name} needs a word that starts with ${L}.`;
  if (!m.alive) return m.dict ? `You're out, but you can keep watching. ${m.cur.name} is up.` : `You're out, but you can still vote. ${m.cur.name} is up.`;
  return `${m.cur.name} needs a word that starts with ${L}.`;
}

function hearts(n, max) {
  const full = Math.max(0, n);
  const out = [];
  for (let i = 0; i < max; i += 1) out.push(h('span', { class: ['heart', i < full ? 'is-full' : null], text: i < full ? '♥' : '♡' }));
  return h('span', { class: 'hearts', attrs: { 'aria-label': plural(full, 'life', 'lives') } }, out);
}

const QUIET = { play() {}, burst() {}, float() {} };

function idOf(snap, slot) {
  const p = snap && Array.isArray(snap.players) ? snap.players.find((x) => x.slot === slot) : null;
  return p && p.id !== undefined && p.id !== null ? p.id : null;
}

export function chainMoments(was, m) {
  const lives = new Map(m.players.map((p) => [p.slot, p.lives]));
  const top = m.words.reduce((a, w) => Math.max(a, w.n), was ? was.top : -1);
  const now = { t: m.t, lives, top };
  if (!was) return { now, cues: [] };
  const cues = [];
  if (top > was.top) cues.push({ name: 'send', word: top });
  if (top > was.top && m.last && m.last.kind === 'word' && m.last.bonus) cues.push({ name: 'correct', word: top, boom: true, opts: { at: 180 } });
  let lost = 0;
  let out = false;
  for (const p of m.players) {
    const before = was.lives.get(p.slot);
    if (before === undefined || p.lives >= before) continue;
    lost += 1;
    if (p.lives <= 0) out = true;
  }
  if (m.phase === 'turn' && lost) cues.push({ name: 'lose', opts: { volume: out ? 1 : 0.55 } });
  if (m.myTurn && m.t !== was.t) cues.push({ name: 'turn', opts: cues.length ? { at: 260 } : undefined });
  return { now, cues };
}

export function createChainView({ engine, toast, cues, fx }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const el = h('section', { class: 'game game-chain', attrs: { 'aria-label': 'Word Chain' } });
  const head = h('div', { class: 'chain-headwrap' });
  const ring = h('div', { class: 'chain-ring' });
  const stage = h('div', { class: 'chain-stage' });
  const input = h('input', {
    class: 'word-input',
    dataset: { key: 'chain-input' },
    attrs: { type: 'text', maxlength: MAX_LETTERS + 4, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': 'Your word', placeholder: 'Type a word' },
  });
  const sendBtn = button('Play', { variant: 'primary', key: 'chain-send', on: () => submit() });
  const hint = h('p', { class: 'entry-hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  const entry = h('div', { class: 'chain-entry' }, h('div', { class: 'entry-row' }, input, sendBtn), hint);
  const voteBox = h('div', { class: 'chain-vote' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, ring, stage, entry, voteBox, foot);

  const local = { nope: null, t: null, sentT: null, sent: '', bad: null };
  loadDictionary();
  let snap = null;
  let model = null;
  let heard = null;

  function refuse() {
    cue.play('error');
    input.classList.remove('is-refused');
    void input.offsetWidth;
    input.classList.add('is-refused');
  }

  function hear(m) {
    const { now, cues: list } = chainMoments(heard, m);
    heard = now;
    for (const c of list) {
      cue.play(c.name, c.opts);
      if (c.word === undefined) continue;
      const i = m.words.findIndex((w) => w.n === c.word);
      const chips = stage.querySelector('.chain-words');
      const chip = chips && i >= 0 ? chips.children[i] : null;
      if (!chip) continue;
      if (!c.boom) {
        cue.burst(chip, { count: 10, spread: 44 });
        continue;
      }
      cue.burst(chip, { count: 22, spread: 80, emoji: ['💥', '✨', '⭐'] });
      cue.float(chip, '×2');
      if (fx && typeof fx.confetti === 'function') fx.confetti(30);
    }
  }

  input.addEventListener('animationend', () => input.classList.remove('is-refused'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    hint.textContent = '';
    input.classList.remove('is-refused');
  });

  function submit() {
    if (!model || !model.myTurn || !snap) return;
    const st = snap.state.chain;
    if (local.sentT === model.t) return;
    const problem = checkWord(input.value, st.letter, usedFrom(snap.state), { cat: model.catOn && model.cat ? model.cat.id : null });
    if (problem) {
      hint.textContent = problemText(problem, model);
      refuse();
      return;
    }
    local.sentT = model.t;
    local.sent = input.value.trim().toLowerCase();
    engine.act({ type: 'word', text: local.sent, t: model.t });
    input.value = '';
    hint.textContent = 'Sent!';
  }

  function nope(v) {
    if (!v || !v.canVote) return;
    local.nope = v.n;
    engine.act({ type: 'nope', n: v.n });
    if (snap) update(snap);
  }

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: plural(m.count, 'word', 'words') }),
      m.until && m.phase === 'turn'
        ? h(
            'span',
            { class: 'chip chip-static countdown chain-clock', dataset: { starts: m.starts, ends: m.until }, attrs: { role: 'timer', 'aria-label': 'Time left in the game' } },
            h('span', { class: 'chain-clock-lead', text: 'Game ends in' }),
            h('strong', { class: 'countdown-num', text: clock(m.until - m.starts) }),
          )
        : null,
      m.span && m.phase === 'turn'
        ? h('span', { class: ['chip', 'chip-static', 'chain-speed', m.sped ? 'is-faster' : null], attrs: { title: m.extra ? 'Category words and Q, X or Z starts get a few extra seconds' : m.fast ? 'Turns get 1 s shorter each lap, down to 5 s' : 'Turns stay this long all game' } }, m.extra ? `${m.span} s turns +${m.extra} s` : `${m.span} s turns`)
        : null,
      m.bonus && m.phase === 'turn' ? h('span', { class: 'chip chip-static chain-bonus-chip', attrs: { title: 'End a word on Q, X or Z for double points' } }, 'Q X Z ×2') : null,
      m.phase === 'turn' ? timer(m.starts, m.ends, 'Time left for this turn') : null,
    ),
  );

  const paintRing = memo((m) =>
    h(
      'ul',
      { class: 'chain-players', attrs: { 'aria-label': 'Players' } },
      m.players.map((p) =>
        h(
          'li',
          { class: ['chain-player', p.isCur ? 'is-up' : null, p.out ? 'is-out' : null, p.isMe ? 'is-me' : null, p.present ? null : 'is-away'] },
          profileButton(p, 'sm'),
          h('span', { class: 'chain-name', text: p.isMe ? `${p.name} (you)` : p.name }),
          hearts(p.lives, m.max),
        ),
      ),
    ),
  );

  const paintStage = memo((m) => [
    m.cat
      ? h(
          'div',
          { class: ['chain-cat', m.catOn ? 'is-on' : 'is-free'], attrs: { role: 'status' } },
          h('span', { class: 'chain-cat-emoji', text: m.cat.emoji, attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'chain-cat-text' }, h('strong', { text: `Category round: ${m.cat.name}` }), h('span', { class: 'chain-cat-sub', text: m.catOn ? `Every word must be ${m.cat.what}.` : `Nothing on my list starts with ${(m.letter || '').toUpperCase()}, so any word goes!` })),
        )
      : null,
    h(
      'div',
      { class: ['chain-letter-wrap', m.hard ? 'is-hard' : null] },
      h('span', { class: 'eyebrow chain-eyebrow', text: 'Next word starts with' }),
      h('span', { class: 'chain-letter', text: (m.letter || '?').toUpperCase(), attrs: { 'aria-live': 'polite' } }),
    ),
    m.words.length
      ? h(
          'ol',
          { class: 'chain-words', attrs: { 'aria-label': 'Words so far' } },
          m.words.map((w) =>
            h(
              'li',
              { class: ['chain-word', w.latest ? 'is-latest' : null, w.bonus ? 'is-bonus' : null, w.isMe ? 'is-me' : 'has-flag'] },
              h('span', { class: 'chain-word-text' }, h('strong', { text: w.word.slice(0, 1).toUpperCase() }), w.word.slice(1, -1), h('strong', { class: 'chain-tail', text: w.word.length > 1 ? w.word.slice(-1) : '' })),
              h('span', { class: 'chain-by', text: w.isMe ? 'you' : w.name }),
              w.isMe ? null : textFlag(engine, wordRef(w.n), { toast, corner: true }),
            ),
          ),
        )
      : h('p', { class: 'muted chain-empty', text: 'The chain is empty. The first word can be anything that starts with this letter.' }),
  ]);

  const paintVote = memo((m) => {
    const v = m.vote;
    const off = !m.dict && m.phase === 'turn' ? h('p', { class: 'muted vote-note', text: "The word list didn't load this time, so players vote out anything that isn't a real word." }) : null;
    if (!v || m.phase !== 'turn') return off;
    const mineWord = v.by.isMe;
    const card = h(
      'div',
      { class: 'vote-card' },
      h('span', { class: 'vote-text' }, mineWord ? 'Your word ' : `${v.by.name} played `, h('strong', { text: `“${v.word}”` }), '.'),
      !v.open
        ? h('span', { class: 'muted vote-note', text: 'Voting on words needs 4 or more players.' })
        : mineWord
        ? h('span', { class: 'muted vote-note', text: v.count ? `${v.count} of ${v.need} votes say it isn't a word.` : 'Others can vote if they think it isn’t a real word.' })
        : v.onClock
        ? h('span', { class: 'muted vote-note', text: v.count ? `${v.count} of ${v.need} votes say it isn't a word. The others decide while it's your turn.` : "The others can vote while it's your turn." })
        : button(v.voted ? `Voted (${v.count}/${v.need})` : `Not a word? (${v.count}/${v.need})`, { variant: v.voted ? 'ghost' : 'secondary', size: 'sm', key: 'nope', disabled: !v.canVote, on: () => nope(v) }),
    );
    return off ? [off, card] : card;
  });

  const paintFoot = memo((m) => h('span', { class: 'foot-text', text: [eventText(m), turnText(m)].filter(Boolean).join(' ') }));

  function update(next) {
    snap = next;
    const m = chain.model(next, local);
    model = m;
    if (!m) {
      paintHead(head, { count: 0, phase: 'wait' });
      return;
    }
    paintHead(head, { count: m.count, phase: m.phase, starts: m.starts, ends: m.ends, until: m.until, span: m.span, fast: m.fast, sped: m.sped, bonus: m.bonus, extra: m.extra });
    paintRing(ring, { max: m.max, players: m.players.map((p) => ({ ...p, id: idOf(next, p.slot) })) });
    paintStage(stage, { letter: m.letter, words: m.words, cat: m.phase === 'turn' ? m.cat : null, catOn: m.catOn, hard: m.bonus && 'qxz'.includes(m.letter || '-') });
    paintVote(voteBox, { vote: m.vote, phase: m.phase, dict: m.dict });
    const badKey = m.bad ? `${m.t}:${m.bad.k}` : null;
    if (badKey && badKey !== local.bad && local.sentT === m.t) {
      local.bad = badKey;
      local.sentT = null;
      if (!input.value) input.value = local.sent;
      hint.textContent = problemText(m.bad.why, m);
      refuse();
    }
    paintFoot(foot, m);
    hear(m);
    const open = m.myTurn && local.sentT !== m.t;
    input.disabled = !open;
    sendBtn.disabled = !open;
    entry.classList.toggle('is-open', open);
    entry.classList.toggle('is-hidden', !m.playing || !m.alive);
    input.setAttribute('placeholder', m.myTurn ? (m.catOn && m.cat ? `${m.cat.name}, starts with ${m.letter.toUpperCase()}…` : `Starts with ${m.letter.toUpperCase()}…`) : 'Wait your turn');
    if (local.t !== m.t) {
      if (m.sped && local.t !== null && m.phase === 'turn') {
        toast(speedText(m.span));
      }
      local.t = m.t;
      if (!open) input.value = '';
      if (m.note === 'again' && m.myTurn) hint.textContent = m.last && m.last.kind === 'reject' && m.last.isMe ? 'That word was voted out. Try another!' : `The last word was voted out, so it's back to ${m.letter.toUpperCase()}. Your clock restarted.`;
      else if (!m.myTurn) hint.textContent = '';
      if (open && typeof input.focus === 'function') input.focus();
      if (m.last && m.last.isMe && m.last.kind === 'out') toast(m.dict ? "You're out of lives! You can keep watching the chain." : "You're out of lives! You can still vote on words.");
    }
  }

  return { el, update, destroy() {} };
}

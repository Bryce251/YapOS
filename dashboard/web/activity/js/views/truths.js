import truths, { KEY, STATEMENT_MAX, PROBLEMS, mask, problemOf } from '../games/truths.js';
import { ideaAt, sampleAt, IDEAS } from '../../data/truths.js';
import { cleanText } from '../text.js';
import { h, memo, timer, avatar, who, button, plural } from '../ui/dom.js';

const QUIET = { play() {}, burst() {}, float() {} };

function faces(list, max = 7) {
  if (!list || !list.length) return null;
  return h(
    'span',
    { class: 'faces', attrs: { title: list.map((p) => (p.isMe ? 'You' : p.name)).join(', ') } },
    list.slice(0, max).map((p) => avatar(p, 'xs')),
    list.length > max ? h('span', { class: 'faces-more', text: `+${list.length - max}` }) : null,
  );
}

function names(list) {
  const out = list.map((p) => (p.isMe ? 'You' : p.name));
  if (out.length <= 1) return out.join('');
  return `${out.slice(0, -1).join(', ')} and ${out[out.length - 1]}`;
}

export function verdict(m) {
  if (!m) return '';
  if (m.phase === 'write') {
    const count = `${m.doneCount} of ${plural(m.inCount, 'player', 'players')} ready`;
    if (m.late) return `You joined after writing started, so you're a detective this game. ${count}.`;
    if (!m.writer) return `You're watching. ${count}.`;
    if (m.done) return m.doneCount >= m.inCount ? 'Everyone is ready!' : `Locked in! Waiting for the others. ${count}.`;
    return `Write two truths and one lie about yourself. ${count}.`;
  }
  if (m.phase === 'vote') {
    const count = `${m.voted} of ${plural(m.voterCount, 'vote', 'votes')} in`;
    if (m.isWriter) return `Everyone is hunting for your lie. Keep a straight face! ${count}.`;
    if (m.watching) return `You're watching. ${count}.`;
    if (m.myPick !== null) return `Vote in! ${count}.`;
    return `Which one is the lie? ${count}.`;
  }
  if (m.phase === 'reveal') {
    if (m.lost) return 'The host changed and this answer got lost, so nobody scores on this one.';
    const writer = m.writerFace.name;
    if (m.isWriter) {
      if (!m.totalVotes) return 'Nobody voted on your statements.';
      if (!m.fooled) return 'Everyone spotted your lie. Better luck next time!';
      if (m.fooled === m.totalVotes) return `You fooled everyone! +${m.myGain}`;
      return `You fooled ${plural(m.fooled, 'person', 'people')}! +${m.myGain}`;
    }
    if (m.spotted) return `You spotted ${writer}'s lie! +${m.myGain}`;
    if (m.fooledMe) return `${writer} fooled you!`;
    if (m.watching) return `That was ${writer}'s lie.`;
    return `You didn't vote. That was ${writer}'s lie.`;
  }
  if (m.phase === 'end') {
    if (m.empty) return 'Nobody finished writing, so there was nothing to guess this time.';
    return 'Thanks for playing! Final scores are next.';
  }
  return '';
}

export function truthsMoment(was, m) {
  if (!m) return { now: was, cues: [] };
  const now = { n: m.n, phase: m.phase, v: m.v, done: m.phase === 'write' ? m.doneCount : 0, mineDone: Boolean(m.done) };
  if (!was || was.n !== m.n) return { now, cues: [] };
  const cues = [];
  if (m.phase === 'write' && was.phase === 'write') {
    const others = now.done - was.done - (m.done && !was.mineDone ? 1 : 0);
    if (others > 0) cues.push('pop');
  }
  if (m.phase === 'vote' && (was.phase !== 'vote' || was.v !== m.v)) cues.push(m.isWriter ? 'turn' : 'whoosh');
  if (m.phase === 'reveal' && was.phase !== 'reveal') {
    cues.push('reveal');
    if (!m.lost) {
      if (m.myGain > 0) cues.push('correct');
      else if (m.fooledMe) cues.push('wrong');
    }
  }
  if (m.phase === 'end' && was.phase !== 'end' && !m.empty) cues.push('reveal');
  return { now, cues };
}

export function createTruthsView({ engine, fx, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const el = h('section', { class: 'game game-truths', attrs: { 'aria-label': 'Two Truths and a Lie' } });
  const head = h('div', { class: 'truths-headwrap' });
  const stage = h('div', { class: 'truths-stage' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });

  const rows = [0, 1, 2].map((i) => {
    const input = h('input', {
      class: 'word-input truths-input',
      dataset: { key: `truths-input-${i}` },
      attrs: { type: 'text', maxlength: STATEMENT_MAX, autocomplete: 'off', spellcheck: 'true', enterkeyhint: i < 2 ? 'next' : 'done', 'aria-label': `Statement ${i + 1}` },
    });
    const lieBtn = h(
      'button',
      {
        class: ['truths-lie-btn', 'spot'],
        type: 'button',
        dataset: { key: `truths-lie-${i}` },
        attrs: { 'aria-pressed': 'false', 'aria-label': `Statement ${i + 1} is the lie` },
        on: { click: () => pickLie(i) },
      },
      h('span', { class: 'truths-lie-icon', text: '🤥', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'truths-lie-label', text: 'Lie' }),
    );
    const left = h('span', { class: 'truths-left', attrs: { 'aria-hidden': 'true' } });
    const row = h('div', { class: 'truths-row' }, h('span', { class: 'truths-num', text: String(i + 1), attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'truths-field' }, input, left), lieBtn);
    input.addEventListener('input', () => {
      hint.textContent = '';
      const n = Array.from(input.value).length;
      left.textContent = n >= STATEMENT_MAX - 15 ? String(Math.max(0, STATEMENT_MAX - n)) : '';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (i < 2 && typeof rows[i + 1].input.focus === 'function') rows[i + 1].input.focus();
      else lock();
    });
    return { row, input, lieBtn, left };
  });

  const idea = h('span', { class: 'truths-idea-text' });
  const ideaBtn = h(
    'button',
    { class: ['truths-idea-btn', 'spot'], type: 'button', dataset: { key: 'truths-idea' }, attrs: { 'aria-label': 'Show another idea' }, on: { click: () => nextIdea() } },
    '🎲',
  );
  const ideaBox = h('p', { class: 'truths-idea' }, h('span', { class: 'truths-idea-lead', text: 'Stuck? Try: ' }), idea, ideaBtn);
  const lockBtn = button('Lock it in', { variant: 'primary', key: 'truths-lock', on: () => lock() });
  const editBtn = button('Change my answers', { variant: 'ghost', key: 'truths-edit', on: () => edit() });
  const hint = h('p', { class: 'entry-hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  const form = h(
    'div',
    { class: ['truths-form', 'truths-off'] },
    h('p', { class: 'eyebrow truths-eyebrow', text: 'Two truths and one lie about you' }),
    rows.map((r) => r.row),
    ideaBox,
    h('div', { class: 'truths-actions' }, lockBtn, editBtn),
    hint,
  );
  el.append(head, stage, form, foot);

  const local = { n: null, h: null, lie: null, locked: null, editing: false, v: null, pick: null, idea: 0, cheered: null };
  let snap = null;
  let model = null;
  let heard = null;

  function nextIdea() {
    local.idea = (local.idea + 1) % IDEAS.length;
    idea.textContent = ideaAt(local.idea);
    cue.play('tap');
  }

  function pickLie(i) {
    if (!model || model.phase !== 'write' || !model.writer || (model.done && !local.editing)) return;
    local.lie = i;
    hint.textContent = '';
    cue.play('toggle');
    paintLie();
  }

  function paintLie() {
    rows.forEach((r, i) => {
      const on = local.lie === i;
      r.row.classList.toggle('truths-row-lie', on);
      r.lieBtn.classList.toggle('truths-lie-on', on);
      r.lieBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function values() {
    return rows.map((r) => r.input.value);
  }

  function sendSet(list, lie, open) {
    if (!snap || !snap.state[KEY]) return;
    const st = snap.state[KEY];
    engine.act({ type: 'set', n: st.n, s: list, c: mask(lie, st.n), open: open || undefined });
  }

  function lock() {
    if (!model || model.phase !== 'write' || !model.writer) return;
    if (model.done && !local.editing) return;
    const raw = values();
    const problem = problemOf(raw, local.lie);
    if (problem) {
      hint.textContent = PROBLEMS[problem];
      cue.play('error');
      return;
    }
    const list = raw.map((x) => cleanText(x, STATEMENT_MAX));
    rows.forEach((r, i) => {
      r.input.value = list[i];
    });
    local.locked = { s: list, lie: local.lie };
    local.editing = false;
    sendSet(list, local.lie, false);
    cue.play('send');
    hint.textContent = 'Locked in!';
    if (snap) update(snap);
  }

  function edit() {
    if (!model || model.phase !== 'write' || !model.writer || !model.done || local.editing) return;
    local.editing = true;
    engine.act({ type: 'edit', n: model.n });
    cue.play('tap');
    hint.textContent = 'Make your changes, then lock it in again.';
    if (snap) update(snap);
  }

  function vote(i) {
    if (!model || !model.canVote) return;
    local.v = model.v;
    local.pick = i;
    engine.act({ type: 'vote', v: model.v, pick: i });
    cue.play('send');
    if (snap) update(snap);
  }

  function reset(m) {
    local.n = m.n;
    local.h = m.h;
    local.lie = null;
    local.locked = null;
    local.editing = false;
    local.v = null;
    local.pick = null;
    local.idea = Math.abs((m.n || 0) + (m.me || 0) * 7) % IDEAS.length;
    idea.textContent = ideaAt(local.idea);
    const sample = sampleAt((m.n || 0) + (m.me || 0));
    rows.forEach((r, i) => {
      r.input.value = '';
      r.left.textContent = '';
      r.input.setAttribute('placeholder', `e.g. ${sample[i]}`);
    });
    hint.textContent = '';
    paintLie();
  }

  const paintHead = memo((m) => {
    if (!m) return null;
    const label = m.phase === 'write' ? 'Writing time' : m.phase === 'end' ? 'Awards' : `Set ${m.number} of ${m.total}`;
    const showTimer = m.phase !== 'end';
    const timerLabel = m.phase === 'write' ? 'Time left to write' : m.phase === 'vote' ? 'Time left to vote' : 'Next set in';
    return h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: 'Two Truths and a Lie' }),
      h('span', { class: 'game-count', text: label }),
      showTimer ? timer(m.starts, m.ends, timerLabel) : null,
    );
  });

  function statement(m, s) {
    const reveal = m.phase === 'reveal';
    const known = reveal && !m.lost;
    return h(
      'button',
      {
        class: [
          'option',
          `option-${s.i + 1}`,
          'spot',
          'truths-statement',
          s.mine ? 'is-mine' : null,
          known && s.isLie ? 'truths-is-lie' : null,
          known && !s.isLie ? 'truths-is-true' : null,
        ],
        type: 'button',
        disabled: !m.canVote,
        dataset: { key: `truths-pick-${s.i}` },
        attrs: { 'aria-pressed': s.mine ? 'true' : 'false' },
        on: { click: () => vote(s.i) },
      },
      h('span', { class: 'option-letter', text: String(s.i + 1), attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'option-text', text: s.text }),
      known ? h('span', { class: ['truths-tag', s.isLie ? 'truths-tag-lie' : 'truths-tag-true'], text: s.isLie ? 'Lie' : 'True' }) : null,
      known ? faces(s.voters, 5) : null,
    );
  }

  function award(title, icon, a, unit) {
    const has = a.people.length && a.n > 0;
    return h(
      'div',
      { class: ['truths-award', 'glass', a.isMe ? 'truths-award-me' : null] },
      h('span', { class: 'truths-award-icon', text: icon, attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'eyebrow truths-award-title', text: title }),
      has
        ? h('div', { class: 'truths-award-people' }, a.people.slice(0, 3).map((p) => who(p, { size: 'md' })))
        : h('p', { class: 'muted', text: 'Nobody this time!' }),
      has ? h('p', { class: 'truths-award-line', text: `${names(a.people.slice(0, 3))} ${unit(a.n)}` }) : null,
    );
  }

  const paintStage = memo((m) => {
    if (!m) return h('p', { class: 'waiting', text: 'Getting the game ready…' });
    const notice = m.note === 'host' ? h('p', { class: 'notice', text: m.phase === 'vote' ? 'The host changed, so voting on this one starts again. Vote again!' : 'The host changed. Your answers are being sent again.' }) : null;
    if (m.phase === 'write') {
      if (m.writer) return [notice, m.doneBy.length ? h('div', { class: 'truths-ready' }, h('span', { class: 'muted', text: 'Ready:' }), faces(m.doneBy, 10)) : null];
      return [
        notice,
        h(
          'div',
          { class: 'truths-wait glass' },
          h('span', { class: 'truths-wait-icon', text: '🕵️', attrs: { 'aria-hidden': 'true' } }),
          h('p', { class: 'truths-wait-text', text: m.late ? 'Everyone is writing two truths and a lie. You get to play detective on all of them!' : 'Everyone is writing two truths and a lie. Get ready to guess!' }),
          faces(m.doneBy, 10),
        ),
      ];
    }
    if (m.phase === 'end') {
      if (m.empty) return h('p', { class: 'waiting', text: 'Nobody locked in their statements this time.' });
      return h(
        'div',
        { class: 'truths-awards' },
        award('Best liar', '🎭', m.liar, (n) => `fooled ${plural(n, 'person', 'people')}`),
        award('Best detective', '🔍', m.detective, (n) => `spotted ${plural(n, 'lie', 'lies')}`),
      );
    }
    return [
      h(
        'div',
        { class: 'truths-writer' },
        who(m.writerFace, { size: 'md' }),
        h('span', { class: 'truths-writer-says', text: m.isWriter ? 'These are yours!' : 'says…' }),
      ),
      notice,
      h('h2', { class: 'question truths-question', text: m.phase === 'vote' ? (m.isWriter ? 'Can they find your lie?' : 'Which one is the lie?') : m.lost ? 'This one got lost' : 'The lie was…' }),
      h('div', { class: 'truths-options' }, m.statements.map((s) => statement(m, s))),
      m.phase === 'vote' ? h('div', { class: 'truths-voted' }, faces(m.votedBy, 10)) : null,
    ];
  });

  const paintFoot = memo((m) => (m ? h('span', { class: 'foot-text', text: verdict(m) }) : null));

  function paintForm(m) {
    const show = Boolean(m && m.phase === 'write' && m.writer);
    form.classList.toggle('truths-off', !show);
    if (!show) return;
    const locked = m.done && !local.editing;
    for (const r of rows) {
      r.input.disabled = locked;
      r.lieBtn.disabled = locked;
    }
    form.classList.toggle('truths-locked', locked);
    lockBtn.classList.toggle('truths-off', locked);
    editBtn.classList.toggle('truths-off', !locked);
    ideaBox.classList.toggle('truths-off', locked);
  }

  function hear(m) {
    const { now, cues: list } = truthsMoment(heard, m);
    heard = now;
    list.forEach((name, i) => cue.play(name, i ? { at: 320 } : undefined));
    if (m && m.phase === 'reveal' && list.includes('correct')) {
      const target = m.isWriter ? stage.querySelector('.truths-writer') : stage.querySelector('.truths-is-lie');
      if (target) {
        cue.burst(target, { count: 14, emoji: m.isWriter ? ['🤥', '🎭'] : ['🔍', '🎉'] });
        if (m.myGain) cue.float(target, `+${m.myGain}`);
      }
    }
  }

  function resend(m) {
    if (local.h === null) {
      local.h = m.h;
      return;
    }
    if (m.h === local.h) return;
    local.h = m.h;
    if (!local.locked || local.n !== m.n) return;
    if (m.phase === 'write' || m.phase === 'vote' || m.phase === 'reveal') sendSet(local.locked.s, local.locked.lie, m.phase === 'write' && local.editing);
  }

  function update(next) {
    snap = next;
    const st = next && next.state ? next.state[KEY] : null;
    const m = st ? truths.model(next, local) : null;
    if (m && m.n !== local.n) reset(m);
    model = m;
    paintHead(head, m ? { phase: m.phase, number: m.number, total: m.total, starts: m.starts, ends: m.ends } : null);
    paintStage(stage, m);
    paintForm(m);
    paintFoot(foot, m);
    if (m) resend(m);
    hear(m);
    if (m && m.phase === 'end' && (m.liar.isMe || m.detective.isMe) && local.cheered !== m.n) {
      local.cheered = m.n;
      if (fx && typeof fx.confetti === 'function') fx.confetti(40);
    }
  }

  return { el, update, destroy() {} };
}

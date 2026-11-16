import bluff, { KEY, FAKE_MAX, seal, factParts, fakeRef, isTruth } from '../games/bluff.js';
import { factById } from '../../data/bluff.js';
import { cleanText, hidesWords } from '../text.js';
import { HIDDEN_NOTE } from '../filter.js';
import { h, memo, timer, button, plural, profileButton } from '../ui/dom.js';
import { textFlag } from '../ui/report.js';

const QUIET = { play() {}, burst() {}, float() {} };
export const PICK_WAIT_MS = 6000;
export const TRUTH_REFUSAL = "That's actually the real answer! Keep it secret and write a fake one.";

function nameOf(p) {
  return p.isMe ? 'You' : p.username ? `${p.name} (@${p.username})` : p.name;
}

function names(list) {
  const shown = list.map((p) => (p.isMe ? 'you' : p.name));
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function faces(list, max = 8, size = 'xs') {
  if (!list || !list.length) return null;
  return h(
    'span',
    { class: ['faces', `faces-${size}`], attrs: { title: list.map(nameOf).join(', ') } },
    list.slice(0, max).map((p) => profileButton(p, size)),
    list.length > max ? h('span', { class: 'faces-more', text: `+${list.length - max}` }) : null,
  );
}

export function footText(m) {
  if (!m) return '';
  if (m.phase === 'write') {
    const count = `${m.done} of ${plural(m.players, 'player', 'players')} wrote a fake`;
    if (m.waiting) return `You joined near the end of this one, so you can still pick. ${count}`;
    if (m.watching) return `You're watching this round. ${count}`;
    if (m.wrote) return `Fake in! ${count}`;
    return count;
  }
  if (m.phase === 'pick') {
    const count = `${m.picked} picked`;
    if (m.watching) return `You're watching. ${count}`;
    if (m.hasPicked) return `Locked in! ${count}`;
    return `Which one is real? You can't pick your own. ${count}`;
  }
  if (m.note === 'nofakes') return 'Nobody wrote a fake, so here is the truth.';
  if (m.lost) return 'The host changed mid-pick, so nobody scored this round. Here is the truth!';
  const bits = [];
  if (m.foundTruth) bits.push('You found the truth!');
  else if (m.fooledBy.length) bits.push(`You fell for ${names(m.fooledBy)}'s fake.`);
  if (m.fooledCount) bits.push(`Your fake fooled ${plural(m.fooledCount, 'player', 'players')}.`);
  if (m.myGain) bits.push(`+${m.myGain}`);
  return bits.length ? bits.join(' ') : 'Here is the truth!';
}

export function heroLabel(m) {
  if (!m) return '';
  if (m.phase === 'write') return 'Strange but true';
  if (m.phase === 'pick') return 'One of these is real';
  return 'The real answer';
}

export function bluffMoment(was, m) {
  const now = { n: m.n, phase: m.phase };
  if (!was || (was.n === m.n && was.phase === m.phase)) return { now, cues: [] };
  if (m.phase === 'write') return { now, cues: ['whoosh'] };
  if (m.phase === 'pick') return { now, cues: ['pop'] };
  if (m.foundTruth || m.fooledCount) return { now, cues: ['reveal', 'correct'] };
  if (m.fooledBy && m.fooledBy.length) return { now, cues: ['reveal', 'wrong'] };
  return { now, cues: ['reveal'] };
}

function factLine(m, fill) {
  const { before, after } = factParts(m.fact);
  return h(
    'h2',
    { class: 'question bluff-fact' },
    before,
    fill ? h('span', { class: 'bluff-blank is-filled', text: fill }) : h('span', { class: 'bluff-blank', text: ' ', attrs: { 'aria-label': 'blank' } }),
    after,
  );
}

export function createBluffView({ engine, fx, cues, toast, win }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const confetti = fx && typeof fx.confetti === 'function' ? fx.confetti : () => {};
  const tell = typeof toast === 'function' ? toast : () => {};
  const el = h('section', { class: 'game game-bluff', attrs: { 'aria-label': 'Bluff' } });
  const head = h('div', { class: 'bluff-headwrap' });
  const top = h('div', { class: 'bluff-top' });
  const input = h('input', {
    class: 'word-input bluff-input',
    dataset: { key: 'bluff-input' },
    attrs: { type: 'text', maxlength: FAKE_MAX * 2, autocomplete: 'off', enterkeyhint: 'send', 'aria-label': 'Your fake answer', placeholder: 'Write a fake that sounds real' },
  });
  const sendBtn = button('Send', { variant: 'primary', key: 'bluff-send', on: () => submit() });
  const left = h('span', { class: 'bluff-left', attrs: { 'aria-hidden': 'true' } });
  const hint = h('p', { class: 'entry-hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  const entry = h('div', { class: 'bluff-entry is-hidden' }, h('div', { class: 'entry-row' }, input, sendBtn), h('div', { class: 'bluff-entry-foot' }, hint, left));
  const stage = h('div', { class: 'bluff-stage' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, top, entry, stage, foot);

  const local = { n: null, sent: null, pick: null, lastSent: null, hid: false };
  const w = win || globalThis;
  let pickTimer = null;
  let model = null;
  let snap = null;
  let heard = null;
  let cheered = null;
  let seenN = null;

  function counter() {
    const rest = FAKE_MAX - Array.from(input.value).length;
    left.textContent = String(rest);
    left.classList.toggle('is-low', rest < 8);
  }

  function refuse(text) {
    hint.textContent = text;
    cue.play('error');
    input.classList.remove('is-refused');
    void input.offsetWidth;
    input.classList.add('is-refused');
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
    counter();
  });

  function sentNote() {
    return local.hid ? `Sent! ${HIDDEN_NOTE}` : 'Sent! Now wait for the others.';
  }

  function submit() {
    const m = model;
    if (!m || m.phase !== 'write' || !m.canWrite || local.n === m.n) return;
    const text = cleanText(input.value, FAKE_MAX);
    if (!text) {
      refuse('Write a fake answer first!');
      return;
    }
    if (isTruth(factById(m.fid), text)) {
      refuse(TRUTH_REFUSAL);
      return;
    }
    local.n = m.n;
    local.sent = text;
    local.lastSent = text;
    local.hid = hidesWords(text);
    local.pick = null;
    cue.play('send');
    engine.act({ type: 'fake', n: m.n, code: seal(text, m.nonce) });
    input.value = '';
    counter();
    hint.textContent = sentNote();
    if (snap) update(snap);
  }

  function stopPickTimer() {
    if (pickTimer !== null && typeof w.clearTimeout === 'function') w.clearTimeout(pickTimer);
    pickTimer = null;
  }

  function watchPick(n) {
    stopPickTimer();
    if (typeof w.setTimeout !== 'function') return;
    pickTimer = w.setTimeout(() => {
      pickTimer = null;
      const st = snap && snap.state ? snap.state[KEY] : null;
      const mine = snap ? snap.meSlot : null;
      if (!st || st.n !== n || st.phase !== 'pick' || local.n !== n || local.pick === null) return;
      if (Array.isArray(st.picked) && st.picked.includes(mine)) return;
      local.pick = null;
      tell('That pick didn’t go through. Try again!');
      update(snap);
    }, PICK_WAIT_MS);
  }

  function choose(m, c) {
    if (!m.canPick || c.isMine) return;
    local.n = m.n;
    local.pick = c.id;
    cue.play('send');
    engine.act({ type: 'pick', n: m.n, id: c.id });
    watchPick(m.n);
    if (snap) update(snap);
  }

  const paintHead = memo((m) => {
    if (!m) return null;
    const label = m.phase === 'write' ? 'Time left to write' : m.phase === 'pick' ? 'Time left to pick' : 'Next fact in';
    return h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: m.phase === 'write' ? 'Write a fake' : m.phase === 'pick' ? 'Spot the truth' : 'The truth' }),
      h('span', { class: 'game-count', text: `Fact ${m.number} of ${m.total}` }),
      timer(m.starts, m.ends, label),
    );
  });

  const paintTop = memo((m) => {
    if (!m) return h('p', { class: 'waiting', text: 'Digging up a strange fact…' });
    const notice =
      m.note === 'host' && m.phase === 'write'
        ? h('p', { class: 'notice', text: 'The host changed, so this fact starts again. Send your fake again!' })
        : null;
    return [h('div', { class: ['bluff-hero', m.phase === 'reveal' ? 'is-reveal' : null] }, h('p', { class: 'bluff-eyebrow', text: heroLabel(m) }), factLine(m, m.phase === 'reveal' ? m.answer : null)), notice];
  });

  function writeStage(m) {
    if (m.wrote) {
      return h(
        'div',
        { class: 'bluff-sent' },
        h('span', { class: 'bluff-sent-icon', text: '🃏', attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'bluff-eyebrow', text: 'Your fake' }),
        h('p', { class: 'bluff-sent-text', text: m.mySent ? `“${m.mySent}”` : 'Sent and hidden until everyone picks.' }),
        h('p', { class: 'muted', text: m.done >= m.players ? 'Everyone is in!' : `Waiting for ${plural(Math.max(0, m.players - m.done), 'more fake', 'more fakes')}…` }),
      );
    }
    if (m.waiting) return h('p', { class: 'muted bluff-wait', text: "This round is almost over. You'll get to pick in a moment." });
    if (m.watching) return h('p', { class: 'muted bluff-wait', text: 'Fakes are being written. You can pick soon.' });
    return h('p', { class: 'muted bluff-tip', text: 'Make it sound believable. Everyone else will try to spot the real answer.' });
  }

  function flagFor(m, c) {
    return textFlag(engine, fakeRef(m.n, m.nonce, c.id), { toast, corner: true });
  }

  function pickStage(m) {
    return h(
      'ul',
      { class: 'bluff-cards', attrs: { 'aria-label': 'Answers' } },
      m.cards.map((c, i) =>
        h(
          'li',
          { class: ['bluff-item', c.isMine ? null : 'has-flag'] },
          h(
            'button',
            {
              class: ['bluff-card', 'bluff-pick', 'spot', `bluff-tone-${i % 4}`, c.isMine ? 'is-own' : null, m.myPick === c.id ? 'is-picked' : null, m.hasPicked && m.myPick !== c.id ? 'is-dim' : null],
              type: 'button',
              disabled: !m.canPick || c.isMine,
              dataset: { key: `pick-${c.id}` },
              attrs: { 'aria-pressed': m.myPick === c.id ? 'true' : 'false' },
              on: { click: () => choose(m, c) },
            },
            h('span', { class: 'bluff-letter', text: LETTERS[i % LETTERS.length], attrs: { 'aria-hidden': 'true' } }),
            h('span', { class: 'bluff-text', text: c.text }),
            c.isMine ? h('span', { class: 'bluff-tag', text: 'Yours' }) : m.myPick === c.id ? h('span', { class: 'bluff-tag is-pick', text: 'Your pick' }) : null,
          ),
          c.isMine ? null : flagFor(m, c),
        ),
      ),
    );
  }

  function revealStage(m) {
    if (!m.cards.length) return null;
    return h(
      'ol',
      { class: 'bluff-cards is-reveal', attrs: { 'aria-label': 'Results' } },
      m.cards.map((c, i) => {
        const reportable = !m.lost && !c.truth && !c.isMine && c.owners.length > 0;
        return h(
          'li',
          { class: ['bluff-item', reportable ? 'has-flag' : null] },
          h(
            'div',
            { class: ['bluff-card', 'bluff-result', c.truth ? 'is-truth' : 'is-fake', c.isMine ? 'is-own' : null, c.iPicked ? 'is-picked' : null], dataset: { key: `res-${c.id}` }, vars: { '--bluff-order': i } },
            h('span', { class: ['bluff-badge', c.truth ? 'is-truth' : null], text: c.truth ? '✅ The truth' : '🃏 Fake' }),
            h('span', { class: 'bluff-text', text: c.text }),
            c.owners.length
              ? h('div', { class: 'bluff-by' }, faces(c.owners, 4, 'sm'), h('span', { class: 'bluff-name', text: `by ${names(c.owners)}` }), c.fooled ? h('span', { class: 'bluff-gain', text: `fooled ${c.fooled}` }) : null)
              : null,
            c.pickers.length ? h('div', { class: 'bluff-pickers' }, h('span', { class: 'bluff-count', text: `${plural(c.pickers.length, 'pick', 'picks')}` }), faces(c.pickers, 6)) : null,
          ),
          reportable ? flagFor(m, c) : null,
        );
      }),
    );
  }

  const paintStage = memo((m) => {
    if (!m) return null;
    if (m.phase === 'write') return writeStage(m);
    if (m.phase === 'pick') return pickStage(m);
    return revealStage(m);
  });

  const paintFoot = memo((m) => {
    if (!m) return null;
    const list = m.phase === 'write' ? m.doneBy : m.phase === 'pick' ? m.pickedBy : null;
    const locked = (m.phase === 'write' && m.wrote) || (m.phase === 'pick' && m.hasPicked);
    return [locked ? h('span', { class: 'bluff-locked', text: '✓ Locked in' }) : null, h('span', { class: 'foot-text', text: footText(m) }), faces(list, 8, 'sm')];
  });

  function cardFor(id) {
    for (const node of stage.querySelectorAll('.bluff-result')) if (node.dataset && node.dataset.key === `res-${id}`) return node;
    return null;
  }

  function hear(m) {
    const { now, cues: list } = bluffMoment(heard, m);
    heard = now;
    list.forEach((name, i) => cue.play(name, i ? { at: 320 } : undefined));
    if (m.phase !== 'reveal' || !list.length) return;
    const truth = m.cards.find((c) => c.truth);
    const node = truth ? cardFor(truth.id) : null;
    if (node && m.foundTruth) cue.burst(node, { count: 14, emoji: ['✅', '🧠'] });
    if (m.myGain) {
      const mine = m.cards.find((c) => c.isMine) || truth;
      const at = mine ? cardFor(mine.id) : null;
      if (at) cue.float(at, `+${m.myGain}`);
    }
    if (m.fooledCount >= 2 && cheered !== m.n) {
      cheered = m.n;
      confetti(40);
    }
  }

  function syncEntry(m) {
    const pending = m && m.phase === 'write' && local.n === m.n && !m.wrote;
    const open = Boolean(m && m.phase === 'write' && m.canWrite && !pending);
    input.disabled = !open;
    sendBtn.disabled = !open;
    entry.classList.toggle('is-hidden', !m || m.phase !== 'write' || (!m.canWrite && !pending));
    entry.classList.toggle('is-open', open);
    if (pending) hint.textContent = 'Sending…';
    if (m && seenN !== m.n) {
      const first = seenN === null;
      seenN = m.n;
      if (m.phase === 'write') {
        if (m.note === 'host' && local.lastSent && m.canWrite) {
          input.value = local.lastSent;
          hint.textContent = 'The host changed, so send your fake again.';
        } else {
          input.value = '';
          hint.textContent = '';
        }
        counter();
        if (open && !first && typeof input.focus === 'function') input.focus();
      }
    }
    if (m && m.phase === 'write' && m.wrote && hint.textContent === 'Sending…') hint.textContent = sentNote();
  }

  function update(next) {
    snap = next;
    const m = bluff.model(next, local);
    model = m;
    paintHead(head, m);
    paintTop(top, m);
    syncEntry(m);
    paintStage(stage, m);
    paintFoot(foot, m);
    if (!m) return;
    if (m.phase === 'pick' && local.n === m.n && local.sent && !m.cards.some((c) => c.isMine) && m.cards.length && heard && heard.phase === 'write') tell('Your fake didn’t make it in time. You can still pick!');
    hear(m);
  }

  counter();
  return {
    el,
    update,
    destroy() {
      stopPickTimer();
    },
  };
}

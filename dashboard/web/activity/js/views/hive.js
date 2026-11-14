import hive, { checkWord, cleanWord, problemText, wordPoints, isPangram, knownWord, loadWords, veil, MAX_LETTERS, REVEAL_MS } from '../games/hive.js';
import { h, memo, timer, avatar, button, plural } from '../ui/dom.js';

const QUIET = { play() {}, burst() {}, float() {} };

export function shuffled(list, random = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function footText(m) {
  if (m.phase === 'load') return 'Gathering letters for the hive…';
  if (m.phase === 'fail') return "The word list didn't load, so Letter Hive can't run this time. Try again in a moment or pick another game.";
  if (m.phase === 'reveal') {
    if (m.reveal && m.reveal.lost) return 'The host changed, so the word lists were lost. Scores still count!';
    return 'Time’s up! Here’s what everyone found.';
  }
  if (!m.playing) return "You're watching. Join the next game to play along.";
  if (m.last && !m.last.isMe) return `🌟 ${m.last.name} found a pangram!`;
  if (m.last && m.last.isMe) return '🌟 You found a pangram!';
  return `Make words with ${m.centre.toUpperCase()} in them. Letters can repeat.`;
}

export function hiveMoments(was, m) {
  const now = { id: m.id, phase: m.phase, last: m.last ? m.last.n : 0 };
  if (!was) return { now, cues: [] };
  const cues = [];
  if (m.phase === 'reveal' && was.phase !== 'reveal') cues.push('reveal');
  if (m.phase === 'play' && was.phase === 'play' && was.id === m.id && now.last > was.last && m.last && !m.last.isMe) cues.push('pop');
  if (m.phase === 'play' && was.phase === 'load') cues.push('turn');
  return { now, cues };
}

function wordChip(x, extra) {
  return h(
    'li',
    { class: ['hive-word', x.pangram ? 'is-pangram' : null, x.only ? 'is-only' : null, extra || null], attrs: { title: x.pangram ? `Pangram! ${x.pts} points` : `${x.pts} ${x.pts === 1 ? 'point' : 'points'}` } },
    x.pangram ? h('span', { class: 'hive-star', text: '🌟', attrs: { 'aria-hidden': 'true' } }) : null,
    h('span', { class: 'hive-word-text', text: x.w }),
    h('span', { class: 'hive-word-pts', text: `+${x.pts}` }),
  );
}

export function createHiveView({ engine, fx, cues }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const el = h('section', { class: 'game game-hive', attrs: { 'aria-label': 'Letter Hive' } });
  const head = h('div', { class: 'hive-headwrap' });
  const rank = h('div', { class: 'hive-rankwrap' });
  const comb = h('div', { class: 'hive-combwrap' });
  const input = h('input', {
    class: 'word-input hive-input',
    dataset: { key: 'hive-input' },
    attrs: { type: 'text', maxlength: MAX_LETTERS, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': 'Your word', placeholder: 'Tap or type a word' },
  });
  const delBtn = button('Delete', { variant: 'ghost', key: 'hive-delete', on: () => backspace() });
  const mixBtn = button('Shuffle', { variant: 'ghost', key: 'hive-shuffle', on: () => mix() });
  const sendBtn = button('Enter', { variant: 'primary', key: 'hive-enter', on: () => submit() });
  const hint = h('p', { class: 'entry-hint hive-hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  const entry = h('div', { class: 'hive-entry' }, input, h('div', { class: 'hive-controls' }, delBtn, mixBtn, sendBtn), hint);
  const found = h('div', { class: 'hive-foundwrap' });
  const board = h('div', { class: 'hive-boardwrap' });
  const results = h('div', { class: 'hive-revealwrap' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, rank, comb, entry, found, board, results, foot);

  const local = { id: null, order: [], found: [], pending: new Map(), seen: new Set(), q: Math.floor(Math.random() * 1e6) };
  loadWords();
  let model = null;
  let heard = null;

  function refuse(text) {
    hint.textContent = text;
    hint.classList.remove('is-good');
    cue.play('error');
    input.classList.remove('is-refused');
    void input.offsetWidth;
    input.classList.add('is-refused');
  }

  function good(text) {
    hint.textContent = text;
    hint.classList.add('is-good');
  }

  const keep = (e) => e.preventDefault();
  for (const b of [delBtn, mixBtn, sendBtn]) b.addEventListener('mousedown', keep);
  el.addEventListener('keydown', (e) => {
    if (e.target === input || e.ctrlKey || e.metaKey || e.altKey || !model || !model.canPlay) return;
    const key = String(e.key || '');
    if (key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (key === 'Backspace') {
      e.preventDefault();
      backspace();
    } else if (/^[a-zA-Z]$/.test(key)) {
      e.preventDefault();
      type(key.toLowerCase());
    }
  });
  input.addEventListener('animationend', () => input.classList.remove('is-refused'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    const clean = String(input.value || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, MAX_LETTERS);
    if (clean !== input.value) input.value = clean;
    input.classList.remove('is-refused');
    hint.textContent = '';
  });

  function type(letter) {
    if (!model || !model.canPlay) return;
    if (String(input.value || '').length >= MAX_LETTERS) return;
    input.value = `${input.value || ''}${letter}`;
    hint.textContent = '';
    cue.play('type');
  }

  function backspace() {
    if (!model || !model.canPlay || !input.value) return;
    input.value = input.value.slice(0, -1);
    hint.textContent = '';
    cue.play('tap');
  }

  function mix() {
    if (!model || !model.outer.length) return;
    let next = shuffled(local.order);
    for (let i = 0; i < 4 && next.join('') === local.order.join(''); i += 1) next = shuffled(local.order);
    local.order = next;
    cue.play('whoosh');
    paintComb(comb, combModel(model));
  }

  function submit() {
    if (!model || !model.canPlay) return;
    const word = cleanWord(input.value);
    const puzzle = { letters: model.letters, centre: model.centre };
    const problem = checkWord(word, puzzle, local.found);
    if (problem) {
      refuse(problemText(problem, model.centre));
      return;
    }
    local.q += 1;
    local.pending.set(local.q, word);
    const sure = knownWord(word, model.letters, model.centre) === true;
    if (sure) local.found.push(word);
    const pts = wordPoints(word, model.letters);
    const pangram = isPangram(word, model.letters);
    engine.act({ type: 'word', x: veil(word, model.id), q: local.q, id: model.id });
    input.value = '';
    cue.play('send');
    if (sure) celebrate(word, pts, pangram);
    else good('Checking…');
    paintFound(found, foundModel());
  }

  function celebrate(word, pts, pangram) {
    good(pangram ? `🌟 Pangram! +${pts}` : `${pts >= 7 ? 'Amazing!' : pts >= 5 ? 'Nice!' : 'Good!'} +${pts}`);
    const mid = comb.querySelector('.hive-cell.is-centre');
    if (mid) {
      cue.float(mid, `+${pts}`);
      if (pangram) cue.burst(mid, { count: 18, emoji: ['🐝', '🌟', '🍯'] });
    }
    if (pangram) {
      cue.play('correct', { at: 140 });
      if (fx && typeof fx.confetti === 'function') fx.confetti(30);
    }
  }

  function settle(m) {
    for (const r of m.results) {
      if (!local.pending.has(r.q) || local.seen.has(r.q)) continue;
      local.seen.add(r.q);
      const word = local.pending.get(r.q);
      local.pending.delete(r.q);
      const had = local.found.includes(word);
      if (r.code === 'ok') {
        if (!had) {
          local.found.push(word);
          celebrate(word, r.pts, isPangram(word, m.letters));
        }
      } else {
        if (had && r.code !== 'found') local.found = local.found.filter((w) => w !== word);
        if (r.code === 'found' && !had) local.found.push(word);
        refuse(problemText(r.code, m.centre));
      }
    }
  }

  function combModel(m) {
    return { letters: m.letters, centre: m.centre, order: local.order.slice(), can: m.canPlay };
  }

  function cell(letter, i, centre, can) {
    return h(
      'button',
      {
        class: ['hive-cell', centre ? 'is-centre' : `hive-cell-${i}`],
        type: 'button',
        disabled: !can,
        dataset: { key: centre ? 'hive-centre' : `hive-cell-${i}`, letter },
        attrs: { 'aria-label': centre ? `${letter.toUpperCase()}, the middle letter` : letter.toUpperCase() },
        on: { click: () => type(letter), mousedown: (e) => e.preventDefault() },
      },
      h('span', { class: 'hive-cell-letter', text: letter.toUpperCase() }),
    );
  }

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: `🐝 ${plural(m.total, 'word', 'words')} to find` }),
      m.pg ? h('span', { class: 'chip chip-static hive-pg', text: `🌟 ${plural(m.pg, 'pangram', 'pangrams')}` }) : null,
      m.phase === 'play' || m.phase === 'reveal' ? timer(m.phase === 'reveal' ? m.ends - REVEAL_MS : m.starts, m.ends, m.phase === 'reveal' ? 'Results in' : 'Time left') : null,
    ),
  );

  const paintRank = memo((m) => {
    if (m.phase !== 'play' || !m.playing) return null;
    return h(
      'div',
      { class: 'hive-rank' },
      h(
        'div',
        { class: 'hive-rank-top' },
        h('strong', { class: 'hive-rank-name', text: m.rank.name }),
        h('span', { class: 'hive-rank-score', text: `${plural(m.me.pts, 'point', 'points')} · ${plural(m.me.count, 'word', 'words')}` }),
      ),
      h('div', { class: 'hive-rank-track', attrs: { role: 'img', 'aria-label': `${m.rank.name}, ${m.rank.pct}% of the way to the top rank` } }, h('span', { class: 'hive-rank-fill', vars: { '--pct': m.rank.pct } })),
      m.rank.next ? h('span', { class: 'hive-rank-next muted', text: `${plural(m.rank.need, 'point', 'points')} to ${m.rank.next}` }) : h('span', { class: 'hive-rank-next', text: 'Top rank! 👑' }),
    );
  });

  const paintComb = memo((c) => {
    if (!c.letters) return null;
    return h(
      'div',
      { class: ['hive-comb', c.can ? 'is-live' : null], attrs: { role: 'group', 'aria-label': 'Letters' } },
      c.order.map((l, i) => cell(l, i, false, c.can)),
      cell(c.centre, 0, true, c.can),
    );
  });

  function foundModel() {
    if (!model || model.phase !== 'play' || !model.playing) return null;
    return { words: local.found.slice().sort(), letters: model.letters, latest: local.found[local.found.length - 1] || null };
  }

  const paintFound = memo((f) => {
    if (!f) return null;
    return h(
      'div',
      { class: 'hive-found' },
      h('span', { class: 'eyebrow', text: f.words.length ? `You found ${plural(f.words.length, 'word', 'words')}` : 'Your words show up here' }),
      f.words.length
        ? h(
            'ul',
            { class: 'hive-words', attrs: { 'aria-label': 'Words you found' } },
            f.words.map((w) => wordChip({ w, pts: wordPoints(w, f.letters), pangram: isPangram(w, f.letters) }, w === f.latest ? 'is-new' : null)),
          )
        : h('p', { class: 'muted hive-empty', text: 'Only you can see your words until time runs out.' }),
    );
  });

  const paintBoard = memo((m) => {
    if (m.phase !== 'play' || !m.board.length) return null;
    return h(
      'ol',
      { class: 'hive-board', attrs: { 'aria-label': 'Scores' } },
      m.board.map((p, i) =>
        h(
          'li',
          { class: ['hive-player', p.isMe ? 'is-me' : null, p.present ? null : 'is-away', i === 0 && p.pts > 0 ? 'is-top' : null] },
          avatar(p, 'sm'),
          h('span', { class: 'hive-player-name', text: p.isMe ? `${p.name} (you)` : p.name }),
          p.pangrams ? h('span', { class: 'hive-star', text: '🌟', attrs: { title: 'Found a pangram', 'aria-label': 'Found a pangram' } }) : null,
          h('span', { class: 'hive-player-stat', text: `${plural(p.count, 'word', 'words')} · ${p.pts}` }),
        ),
      ),
    );
  });

  const paintReveal = memo((m) => {
    if (m.phase !== 'reveal' || !m.reveal) return null;
    const r = m.reveal;
    const pangramLine = r.pangramBy.length
      ? `🌟 Pangram found by ${r.pangramBy.map((p) => (p.isMe ? 'you' : p.name)).join(', ')}!`
      : r.lost
      ? null
      : '🌟 Nobody found a pangram this time.';
    return h(
      'div',
      { class: 'hive-reveal' },
      h(
        'div',
        { class: 'hive-letters', attrs: { 'aria-label': `The letters were ${m.letters.toUpperCase().split('').join(' ')}` } },
        m.letters.split('').map((l) => h('span', { class: ['hive-tile', l === m.centre ? 'is-centre' : null], text: l.toUpperCase() })),
      ),
      pangramLine ? h('p', { class: 'hive-pangram-line', text: pangramLine }) : null,
      r.players.length
        ? h(
            'ol',
            { class: 'hive-cards' },
            r.players.map((p) =>
              h(
                'li',
                { class: ['hive-card', p.isMe ? 'is-me' : null] },
                h(
                  'div',
                  { class: 'hive-card-head' },
                  avatar(p, 'sm'),
                  h('strong', { class: 'hive-card-name', text: p.isMe ? `${p.name} (you)` : p.name }),
                  h('span', { class: 'hive-card-score', text: `${plural(p.count, 'word', 'words')} · ${plural(p.pts, 'point', 'points')}` }),
                ),
                p.words.length ? h('ul', { class: 'hive-words' }, p.words.map((x) => wordChip(x))) : h('p', { class: 'muted hive-empty', text: 'No words this time.' }),
                p.more ? h('p', { class: 'muted hive-more', text: `and ${p.more} more` }) : null,
              ),
            ),
          )
        : null,
      r.missed.length
        ? h(
            'div',
            { class: 'hive-missed' },
            h('span', { class: 'eyebrow', text: r.lost ? 'Some great words in this hive' : 'Best words nobody found' }),
            h('ul', { class: 'hive-words' }, r.missed.map((x) => wordChip(x, 'is-missed'))),
            r.missedCount > r.missed.length ? h('p', { class: 'muted hive-more', text: `and ${r.missedCount - r.missed.length} more` }) : null,
          )
        : !r.lost
        ? h('p', { class: 'hive-pangram-line', text: '🍯 Every word in the hive was found. Amazing teamwork!' })
        : null,
      r.players.some((p) => p.words.some((x) => x.only)) ? h('p', { class: 'muted hive-key', text: 'Highlighted words were found by just one player.' }) : null,
    );
  });

  const paintFoot = memo((m) => h('span', { class: 'foot-text', text: footText(m) }));

  function update(next) {
    const m = hive.model(next);
    model = m;
    if (!m) {
      paintHead(head, { total: 0, pg: 0, phase: 'wait' });
      return;
    }
    if (m.id !== local.id) {
      local.id = m.id;
      local.order = shuffled(m.outer);
      local.found = [];
      local.pending.clear();
      local.seen.clear();
      input.value = '';
      hint.textContent = '';
    }
    if (local.order.length !== m.outer.length) local.order = shuffled(m.outer);
    settle(m);
    paintHead(head, { total: m.total, pg: m.pg, phase: m.phase, starts: m.starts, ends: m.ends });
    paintRank(rank, { phase: m.phase, playing: m.playing, rank: m.rank, me: m.me });
    paintComb(comb, m.phase === 'play' ? combModel(m) : {});
    paintFound(found, foundModel());
    paintBoard(board, { phase: m.phase, board: m.board });
    paintReveal(results, { phase: m.phase, letters: m.letters, centre: m.centre, reveal: m.reveal });
    paintFoot(foot, m);
    const open = m.canPlay;
    input.disabled = !open;
    delBtn.disabled = !open;
    mixBtn.disabled = !open;
    sendBtn.disabled = !open;
    entry.classList.toggle('is-hidden', m.phase !== 'play' || !m.playing);
    el.classList.toggle('is-reveal', m.phase === 'reveal');
    const { now, cues: list } = hiveMoments(heard, m);
    const fresh = heard === null;
    heard = now;
    list.forEach((name, i) => cue.play(name, i ? { at: 260 } : undefined));
    if (open && (fresh || list.includes('turn')) && typeof input.focus === 'function') input.focus();
  }

  return { el, update, destroy() {} };
}

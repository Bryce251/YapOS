import { h, replace, nextId } from '../dom.js';
import { button, card, confirmDialog, emptyState, linkButton, pageHeader, setBusy, toast } from '../ui.js';
import { state } from '../state.js';
import { TITLE_MAX, ARTIST_MAX, CREDIT_MAX, OFFSET_MIN, OFFSET_MAX, DIFF_IDS, DIFF_NAMES } from '../../activity/js/games/beatcodec.js';
import { SONGS_PATH, SONG_ACCEPT, ALREADY, fileProblem, uploadSong, usageText, formatLength, formatMb } from '../song-upload.js';
import { decodeSong, analyzeSong, createSongEditor, clampOffset, NO_PLAY } from '../song-editor.js';

export const SONGS_PAGE = '/party/songs';
export const RIGHTS_TEXT = 'I own this song or have permission to use it in YapOS Party.';
export const CREDIT_HINT = 'e.g. CC BY 4.0 - Artist name, or Made by me';
export const OGG_NOTE = 'MP3, OGG or M4A, up to 8 MB and 30 seconds to 6 minutes long. OGG may not play on older iPhones, so MP3 or M4A is safest.';

export function readSongs(data) {
  const d = data && typeof data === 'object' ? data : {};
  const songs = (Array.isArray(d.songs) ? d.songs : []).filter((s) => s && typeof s.id === 'string').map((s) => ({
    id: s.id,
    title: String(s.title || ''),
    artist: String(s.artist || ''),
    credit: String(s.credit || ''),
    duration_ms: Number(s.duration_ms) || 0,
    bytes: Number(s.bytes) || 0,
    bpm: Number(s.bpm) || 0,
    offset_ms: Number(s.offset_ms) || 0,
    start_ms: Number(s.start_ms) || 0,
    end_ms: Number(s.end_ms) || 0,
    cv: Number(s.cv) || 1,
    counts: Array.isArray(s.counts) ? s.counts.map((n) => Number(n) || 0) : [],
    hidden: s.hidden === true,
    uploader: String(s.uploader || ''),
    uploaderName: typeof s.uploaderName === 'string' ? s.uploaderName : '',
    url: typeof s.url === 'string' && s.url.startsWith('/song-audio/') ? s.url : '',
  }));
  const u = d.usage && typeof d.usage === 'object' ? d.usage : {};
  return {
    songs,
    usage: { count: Number(u.count) || 0, bytes: Number(u.bytes) || 0, capCount: Number(u.capCount) || 40, capBytes: Number(u.capBytes) || 200 * 1048576 },
    role: d.role === 'owner' ? 'owner' : d.role === 'admin' ? 'admin' : null,
  };
}

export function canChangeNotes(song, role, me) {
  return role === 'owner' || (Boolean(me) && song.uploader === String(me).toLowerCase());
}

function staffOnly() {
  return emptyState({
    icon: 'lock',
    title: 'Only party staff can open this',
    body: 'Beat Drop songs are managed by the owner and party admins of YapOS Party.',
    action: linkButton({ label: 'Back to your servers', href: '/servers', icon: 'chevron-left' }),
  });
}

function textField(label, { max, placeholder = '', value = '' } = {}) {
  const id = nextId('song-field');
  const input = h('input', { id, class: 'input', type: 'text', maxLength: max, placeholder, value, autocomplete: 'off', spellcheck: false });
  return { input, el: h('div', { class: 'field' }, h('label', { class: 'field-label', htmlFor: id, text: label }), input) };
}

export function renderPartySongs(ctx, deps = {}) {
  const { api, main } = ctx;
  const win = deps.win || globalThis;
  const fetchImpl = deps.fetch || ((...a) => win.fetch(...a));
  const sleep = deps.sleep;
  if (typeof ctx.setChrome === 'function') ctx.setChrome({ variant: 'plain', section: 'party-songs', crumbs: [{ label: 'Party admins', href: '/party' }, { label: 'Beat Drop songs' }] });
  if (!state.partyAdmin && !state.partyOwner) {
    main.replaceChildren(h('div', { class: 'page page-narrow' }, staffOnly()));
    return null;
  }

  let view = readSongs(null);
  let picked = null;
  let editor = null;
  let busy = false;
  let gen = 0;

  const fileId = nextId('song-file');
  const fileInput = h('input', { id: fileId, type: 'file', class: 'input song-file', attrs: { accept: SONG_ACCEPT } });
  const fileStatus = h('p', { class: 'field-help song-file-status', attrs: { 'aria-live': 'polite' } });
  const analyzeBar = h('progress', { class: 'song-progress', max: 1, value: 0, hidden: true, attrs: { 'aria-label': 'Reading the song' } });
  const editorBox = h('div', { class: 'song-editor-box' });
  const title = textField('Song title', { max: TITLE_MAX });
  const artist = textField('Artist', { max: ARTIST_MAX });
  const credit = textField('Credit', { max: CREDIT_MAX, placeholder: CREDIT_HINT });
  const rightsId = nextId('song-rights');
  const rights = h('input', { id: rightsId, type: 'checkbox', class: 'song-rights-box' });
  const uploadBar = h('progress', { class: 'song-progress', max: 1, value: 0, hidden: true, attrs: { 'aria-label': 'Uploading the song' } });
  const uploadStatus = h('p', { class: 'field-help', attrs: { 'aria-live': 'polite' } });
  const uploadBtn = button({ label: 'Upload song', icon: 'upload', variant: 'primary', disabled: true, onClick: () => doUpload() });
  const meterText = h('p', { class: 'song-meter-text muted' });
  const meter = h('progress', { class: 'song-meter', max: 1, value: 0, attrs: { 'aria-label': 'Song shelf space used' } });
  const listBox = h('div', { class: 'song-list-wrap' });

  function ready() {
    return Boolean(picked && editor && editor.value() && rights.checked && title.input.value.trim() && artist.input.value.trim() && !busy);
  }
  function refreshButton() {
    uploadBtn.disabled = !ready();
  }
  for (const el of [title.input, artist.input, credit.input]) el.addEventListener('input', refreshButton);
  rights.addEventListener('change', refreshButton);

  function dropEditor() {
    if (editor) editor.destroy();
    editor = null;
    replace(editorBox);
  }

  async function openFile(file) {
    const mine = ++gen;
    dropEditor();
    picked = null;
    refreshButton();
    const problem = fileProblem(file);
    fileStatus.textContent = problem;
    fileStatus.classList.toggle('is-error', Boolean(problem));
    if (problem) return;
    fileStatus.textContent = 'Reading the song...';
    analyzeBar.hidden = false;
    analyzeBar.value = 0;
    try {
      const buf = await file.arrayBuffer();
      const decoded = await (deps.decode || decodeSong)(buf, win);
      if (mine !== gen) return;
      if (decoded.duration_ms < 30000 || decoded.duration_ms > 360000) throw new Error('Songs must be between 30 seconds and 6 minutes long.');
      fileStatus.textContent = 'Finding the beat...';
      const analysis = await (deps.analyze || analyzeSong)(decoded.pcm, decoded.sr, { win, onProgress: (p) => { analyzeBar.value = p; } });
      if (mine !== gen) return;
      picked = { buf, duration_ms: decoded.duration_ms, name: file.name };
      editor = createSongEditor({ analysis, buf, win, onChange: refreshButton });
      replace(editorBox, editor.el);
      if (!title.input.value.trim()) title.input.value = String(file.name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').slice(0, TITLE_MAX);
      fileStatus.textContent = `Found ${analysis.bpm} BPM. Pick the part to play, check the notes, then upload.`;
    } catch (err) {
      if (mine !== gen) return;
      fileStatus.textContent = err && err.message ? err.message : NO_PLAY;
      fileStatus.classList.add('is-error');
    } finally {
      if (mine === gen) analyzeBar.hidden = true;
      refreshButton();
    }
  }

  fileInput.addEventListener('change', () => openFile(fileInput.files && fileInput.files[0]));

  async function doUpload() {
    if (!ready()) return;
    const v = editor.value();
    busy = true;
    setBusy(uploadBtn, true, 'Uploading...');
    uploadBar.hidden = false;
    uploadBar.value = 0;
    uploadStatus.textContent = '';
    try {
      const meta = { title: title.input.value.trim(), artist: artist.input.value.trim(), credit: credit.input.value.trim(), rights: rights.checked === true, duration_ms: picked.duration_ms, bpm: v.charts.bpm, ...v };
      const out = await uploadSong({ buf: picked.buf, meta, api, fetchImpl, sleep, digest: deps.digest, signal: ctx.signal, onProgress: (p) => { uploadBar.value = p.of ? p.done / p.of : 0; } });
      if (out.exists) {
        uploadStatus.textContent = ALREADY;
        toast(ALREADY, { tone: 'info' });
      } else {
        toast(`"${out.song.title}" is on the shelf.`);
        gen += 1;
        dropEditor();
        picked = null;
        fileInput.value = '';
        fileStatus.textContent = '';
        for (const f of [title, artist, credit]) f.input.value = '';
        rights.checked = false;
      }
      await load();
    } catch (err) {
      uploadStatus.textContent = err && err.message ? err.message : 'The upload did not finish. Try again.';
    } finally {
      busy = false;
      uploadBar.hidden = true;
      setBusy(uploadBtn, false);
      refreshButton();
    }
  }

  function songRow(s) {
    const me = state.user && state.user.id;
    const facts = [formatLength(s.duration_ms), `${Math.round(s.bpm)} BPM`, formatMb(s.bytes), s.counts.length === 4 ? DIFF_IDS.map((id, i) => `${DIFF_NAMES[id]} ${s.counts[i]}`).join(', ') : ''].filter(Boolean);
    const body = h('div', { class: 'song-row-body' });
    const hideBtn = button({ label: s.hidden ? 'Show' : 'Hide', icon: s.hidden ? 'eye' : 'eye-off', size: 'sm', onClick: async () => {
      setBusy(hideBtn, true);
      try {
        await api.patch(`${SONGS_PATH}/${s.id}`, { hidden: !s.hidden });
        await load();
      } catch (err) {
        toast(err.message, { tone: 'danger' });
        setBusy(hideBtn, false);
      }
    } });
    const editBtn = button({ label: 'Edit', size: 'sm', onClick: () => replace(body, editForm(s, body)) });
    const delBtn = canChangeNotes(s, view.role, me) ? button({ label: 'Delete', icon: 'trash', variant: 'danger', size: 'sm', onClick: async () => {
      const ok = await confirmDialog({ title: `Delete ${s.title}?`, body: 'Games already using it will switch to built-in beats.', confirmLabel: 'Delete song' });
      if (!ok) return;
      setBusy(delBtn, true);
      try {
        await api.request('DELETE', `${SONGS_PATH}/${s.id}`);
        toast(`Deleted "${s.title}".`);
        await load();
      } catch (err) {
        toast(err.message, { tone: 'danger' });
        setBusy(delBtn, false);
      }
    } }) : null;
    return h('li', { class: ['song-item', s.hidden ? 'is-hidden' : ''], dataset: { song: s.id } },
      h('div', { class: 'song-item-head' },
        h('div', { class: 'song-item-text' },
          h('p', { class: 'song-item-title', text: `${s.title} - ${s.artist}` }),
          s.credit ? h('p', { class: 'song-item-credit muted', text: `Credit: ${s.credit}` }) : null,
          h('p', { class: 'song-item-facts muted', text: facts.join(' / ') }),
          s.hidden ? h('p', { class: 'song-item-flag', text: 'Hidden from Beat Drop' }) : null),
        h('div', { class: 'song-item-actions' }, hideBtn, editBtn, delBtn)),
      body);
  }

  function editForm(s, body) {
    const t = textField('Song title', { max: TITLE_MAX, value: s.title });
    const a = textField('Artist', { max: ARTIST_MAX, value: s.artist });
    const c = textField('Credit', { max: CREDIT_MAX, value: s.credit, placeholder: CREDIT_HINT });
    const offId = nextId('song-offset');
    const off = h('input', { id: offId, class: 'input song-offset', type: 'number', min: OFFSET_MIN, max: OFFSET_MAX, step: 1, value: s.offset_ms });
    const err = h('p', { class: 'field-error', attrs: { 'aria-live': 'polite' } });
    const save = button({ label: 'Save', variant: 'primary', size: 'sm', onClick: async () => {
      setBusy(save, true);
      try {
        await api.patch(`${SONGS_PATH}/${s.id}`, { title: t.input.value.trim(), artist: a.input.value.trim(), credit: c.input.value.trim(), offset_ms: clampOffset(off.value) });
        toast('Saved.');
        await load();
      } catch (e) {
        err.textContent = e.message;
        setBusy(save, false);
      }
    } });
    const me = state.user && state.user.id;
    const notes = canChangeNotes(s, view.role, me) && s.url ? button({ label: 'Remake notes', size: 'sm', onClick: () => rechart(s, body) }) : null;
    return h('div', { class: 'song-edit' }, t.el, a.el, c.el,
      h('div', { class: 'field' }, h('label', { class: 'field-label', htmlFor: offId, text: `Offset in ms (${OFFSET_MIN} to ${OFFSET_MAX})` }), off),
      err,
      h('div', { class: 'song-row' }, save, notes, button({ label: 'Cancel', size: 'sm', onClick: () => replace(body) })));
  }

  async function rechart(s, body) {
    const msg = h('p', { class: 'field-help', attrs: { 'aria-live': 'polite' }, text: 'Loading the song...' });
    const bar = h('progress', { class: 'song-progress', max: 1, value: 0, attrs: { 'aria-label': 'Reading the song' } });
    replace(body, msg, bar);
    try {
      const res = await fetchImpl(s.url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('That song could not be loaded.');
      const buf = await res.arrayBuffer();
      const decoded = await (deps.decode || decodeSong)(buf, win);
      msg.textContent = 'Finding the beat...';
      const analysis = await (deps.analyze || analyzeSong)(decoded.pcm, decoded.sr, { win, onProgress: (p) => { bar.value = p; } });
      const ed = createSongEditor({ analysis, buf, win, initial: { start_ms: s.start_ms, end_ms: s.end_ms, offset_ms: s.offset_ms } });
      const err = h('p', { class: 'field-error', attrs: { 'aria-live': 'polite' } });
      const save = button({ label: 'Save new notes', variant: 'primary', size: 'sm', onClick: async () => {
        const v = ed.value();
        if (!v) return;
        setBusy(save, true);
        try {
          await api.patch(`${SONGS_PATH}/${s.id}`, v);
          ed.destroy();
          toast('New notes saved. Games starting now use them.');
          await load();
        } catch (e) {
          err.textContent = e.message;
          setBusy(save, false);
        }
      } });
      replace(body, ed.el, err, h('div', { class: 'song-row' }, save, button({ label: 'Cancel', size: 'sm', onClick: () => {
        ed.destroy();
        replace(body);
      } })));
    } catch (e) {
      msg.textContent = e && e.message ? e.message : NO_PLAY;
      bar.remove();
    }
  }

  function renderList() {
    meterText.textContent = usageText(view.usage);
    meter.value = view.usage.capBytes ? Math.min(1, Math.max(view.usage.bytes / view.usage.capBytes, view.usage.count / view.usage.capCount)) : 0;
    if (!view.songs.length) {
      replace(listBox, emptyState({ icon: 'volume', title: 'No songs yet', body: 'Beat Drop plays built-in beats until you upload a song.', compact: true }));
      return;
    }
    replace(listBox, h('ul', { class: 'song-list' }, ...view.songs.map(songRow)));
  }

  async function load() {
    try {
      view = readSongs(await api.get(SONGS_PATH, { signal: ctx.signal }));
      renderList();
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) return;
      replace(listBox, emptyState({ icon: 'alert', title: 'Songs could not load', body: err.message, action: button({ label: 'Try again', onClick: () => load() }), compact: true }));
    }
  }

  if (ctx.signal && typeof ctx.signal.addEventListener === 'function') ctx.signal.addEventListener('abort', () => dropEditor());

  main.replaceChildren(h('div', { class: 'page page-narrow songs-page' },
    pageHeader({
      title: 'Beat Drop songs',
      description: 'Upload songs you own or have permission to use. YapOS finds the beat and makes Chill, Normal, Hard and Expert notes, always on 4 lanes. Songs show up in Beat Drop in YapOS Party.',
      actions: h('div', { class: 'owner-links' },
        linkButton({ label: 'Party admins', href: '/party', icon: 'crown', size: 'sm' }),
        linkButton({ label: 'Reports', href: '/party/reports', icon: 'flag', size: 'sm' })),
    }),
    card({ title: 'Add a song', icon: 'upload' },
      h('div', { class: 'field' }, h('label', { class: 'field-label', htmlFor: fileId, text: 'Song file' }), fileInput, h('p', { class: 'field-help', text: OGG_NOTE }), fileStatus, analyzeBar),
      editorBox,
      title.el, artist.el, credit.el,
      h('div', { class: 'song-rights' }, rights, h('label', { htmlFor: rightsId, text: RIGHTS_TEXT })),
      h('div', { class: 'song-row' }, uploadBtn),
      uploadBar, uploadStatus),
    card({ title: 'Song shelf', icon: 'list' }, meterText, meter, listBox)));
  load();
  return { load, openFile, doUpload, get editor() { return editor; }, get view() { return view; } };
}

import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { appGlyph, button, card, emptyState, linkButton, loadingRegion, setBusy, skeleton, skeletonBlock, switchControl, toast } from '../ui.js';
import { loadServer, mountAsync } from './common.js';
import { serverChrome } from './overview.js';
import { changeApp } from './apps.js';
import { serverPath } from '../router.js';
import { buildPatch, dirtyKeys, initialEdits, normalizeSchema, sameValue, toEditValue, validateAll, validateField } from '../forms.js';
import { fieldRow } from '../fields.js';
import { getDetail } from '../state.js';
import { OFFLINE_MESSAGE, SLOW_AFTER_MS, isAbort } from '../api.js';

function settingsSkeleton() {
  return loadingRegion('Loading settings',
    h('div', { class: 'settings-head' }, skeleton('skeleton-glyph-lg'), h('div', { class: 'settings-head-text' }, skeleton('skeleton-title skeleton-w-30'), skeleton('skeleton-text skeleton-w-60'))),
    h('section', { class: 'card' }, h('div', { class: 'card-body' }, ...Array.from({ length: 4 }, () => h('div', { class: 'field' }, h('div', { class: 'field-text' }, skeletonBlock(2)), h('div', { class: 'field-control' }, skeleton('skeleton-input')))))));
}

function settingsHeader(ctx, app, onToggled) {
  const name = app.name || app.id;
  const status = h('span', { class: 'settings-switch-label', text: app.enabled ? 'Installed' : 'Not installed' });
  const sw = switchControl({
    checked: Boolean(app.enabled),
    label: `${name} installed`,
    disabled: app.canDisable === false && app.enabled,
    onChange: async (next, control) => {
      control.setDisabled(true);
      control.setBusy(true);
      status.textContent = 'Waiting for YapOS…';
      let slow = null;
      try {
        const res = await changeApp(ctx, app.id, { enabled: next }, {
          signal: ctx.signal,
          onPending: () => {
            slow = setTimeout(() => {
              status.textContent = "YapOS hasn't answered yet";
            }, SLOW_AFTER_MS);
          },
        });
        const err = res.errors.enabled || res.message || Object.values(res.errors)[0];
        if (err) throw new Error(String(err));
        app.enabled = next;
        toast(`${name} ${next ? 'installed' : 'uninstalled'}.`);
        onToggled(next);
      } catch (e) {
        if (isAbort(e)) return;
        control.set(!next);
        toast(e.message || OFFLINE_MESSAGE, { tone: 'danger', title: `Couldn't change ${name}`, timeout: 7000 });
      } finally {
        clearTimeout(slow);
        control.setBusy(false);
        control.setDisabled(app.canDisable === false && app.enabled);
        status.textContent = app.enabled ? 'Installed' : 'Not installed';
      }
    },
  });
  return h('header', { class: 'settings-head' },
    appGlyph(app, 'lg'),
    h('div', { class: 'settings-head-text' },
      h('h1', { class: 'page-title', text: name }),
      app.description ? h('p', { class: 'page-description', text: app.description }) : null),
    h('div', { class: 'settings-head-switch' }, status, sw.el));
}

export function renderAppSettings(ctx) {
  const { main, params } = ctx;
  serverChrome(ctx, 'apps', 'Settings');
  const body = h('div', { class: 'page-body' });
  main.replaceChildren(h('div', { class: 'page page-settings' },
    h('div', { class: 'back-row' }, h('a', { href: serverPath(params.sid, 'apps'), class: 'link-subtle', dataset: { link: '' } }, icon('chevron-left', { size: 14 }), 'All apps')),
    body));

  mountAsync(body, {
    signal: ctx.signal,
    skeleton: settingsSkeleton,
    load: ({ onPending, signal }) => loadServer(ctx, { onPending, signal }),
    render: (detail) => {
      const app = detail.apps.find((a) => String(a.id) === params.app);
      const entry = detail.settings?.[params.app];
      if (!app && !entry) {
        serverChrome(ctx, 'apps', 'Not found');
        body.replaceChildren(emptyState({ icon: 'apps', title: 'App not found', body: "This server doesn't have an app with that name.", action: linkButton({ label: 'Back to apps', href: serverPath(params.sid, 'apps') }) }));
        return;
      }
      const appInfo = app || { id: params.app, name: params.app, enabled: true };
      serverChrome(ctx, 'apps', appInfo.name || appInfo.id);
      ctx.setTitle(`${appInfo.name || appInfo.id} settings`);
      buildForm(ctx, body, detail, appInfo, entry);
    },
  });
}

function buildForm(ctx, body, detail, app, entry) {
  const fields = normalizeSchema(entry?.schema);
  const rawValues = entry?.values && typeof entry.values === 'object' ? entry.values : {};
  const lookups = detail.settings?.lookups || {};
  const editable = fields.filter((f) => !f.readOnly);
  const readOnly = fields.filter((f) => f.readOnly);
  const base = initialEdits(fields, rawValues);
  const current = initialEdits(fields, rawValues);
  const serverErrors = {};
  const rows = new Map();
  let saving = false;
  let saveSeq = 0;

  const notice = h('div', { class: 'notice-slot' });
  const drawNotice = (enabled) => replace(notice, enabled ? null : h('p', { class: 'notice notice-info' }, icon('info', { size: 16 }), h('span', { text: 'This app is not installed. Turn it on above before changing its settings.' })));
  drawNotice(app.enabled !== false);

  const barText = h('span', { class: 'save-bar-text', text: 'You have unsaved changes' });
  const barIcon = h('span', { class: 'save-bar-icon' }, icon('info', { size: 16 }));
  const resetBtn = button({ label: 'Reset', variant: 'ghost', size: 'sm' });
  const saveBtn = button({ label: 'Save', variant: 'primary', size: 'sm' });
  const bar = h('div', { class: 'save-bar', attrs: { role: 'region', 'aria-label': 'Unsaved changes', 'aria-hidden': 'true' } },
    h('div', { class: 'save-bar-inner' }, barIcon, h('div', { class: 'save-bar-msg', attrs: { 'aria-live': 'polite' } }, barText), h('div', { class: 'save-bar-actions' }, resetBtn, saveBtn)));
  bar.inert = true;

  function isDirty() {
    return dirtyKeys(fields, base, current).length > 0;
  }

  function refreshBar() {
    const dirtySet = new Set(dirtyKeys(fields, base, current));
    for (const [key, row] of rows) row.setDirty(dirtySet.has(key));
    const show = dirtySet.size > 0 || saving;
    bar.classList.toggle('is-visible', show);
    bar.setAttribute('aria-hidden', show ? 'false' : 'true');
    bar.inert = !show;
    if (!saving) {
      bar.classList.remove('is-slow');
      replace(barIcon, icon('info', { size: 16 }));
      barText.textContent = dirtySet.size === 1 ? 'You have 1 unsaved change' : `You have ${dirtySet.size} unsaved changes`;
    }
  }

  function onChange(key, value) {
    current[key] = value;
    const field = fields.find((f) => f.key === key);
    delete serverErrors[key];
    rows.get(key)?.setError(validateField(field, value));
    refreshBar();
  }

  for (const f of fields) {
    rows.set(f.key, fieldRow(f, { edit: current[f.key], rawValue: rawValues[f.key] ?? f.default, lookups, onChange: (v) => onChange(f.key, v) }));
  }

  function reset() {
    for (const f of editable) {
      current[f.key] = Array.isArray(base[f.key]) ? base[f.key].slice() : base[f.key];
      rows.get(f.key).setValue(current[f.key]);
      rows.get(f.key).setError('');
      delete serverErrors[f.key];
    }
    refreshBar();
  }

  async function save() {
    if (saving) return;
    const localErrors = validateAll(fields, current);
    const keys = dirtyKeys(fields, base, current);
    if (!keys.length) return;
    const badKeys = keys.filter((k) => localErrors[k]);
    if (badKeys.length) {
      for (const k of badKeys) rows.get(k).setError(localErrors[k]);
      rows.get(badKeys[0]).focus();
      toast('Fix the highlighted fields before saving.', { tone: 'danger' });
      return;
    }
    const patch = buildPatch(fields, base, current);
    const sent = Object.fromEntries(keys.map((k) => [k, Array.isArray(current[k]) ? current[k].slice() : current[k]]));
    saveSeq += 1;
    const mine = saveSeq;
    saving = true;
    setBusy(saveBtn, true, 'Saving…');
    resetBtn.disabled = true;
    refreshBar();
    replace(barIcon, h('span', { class: 'spinner spinner-sm', attrs: { 'aria-hidden': 'true' } }));
    barText.textContent = 'Waiting for YapOS…';
    let slow = null;
    try {
      const res = await changeApp(ctx, app.id, { settings: patch }, {
        signal: ctx.signal,
        onPending: () => {
          slow = setTimeout(() => {
            bar.classList.add('is-slow');
            replace(barIcon, icon('signal-off', { size: 16 }));
            barText.textContent = "YapOS hasn't answered yet. It may be offline or restarting.";
            setBusy(saveBtn, false);
            saveBtn.querySelector('.btn-label').textContent = 'Retry';
            saving = false;
          }, SLOW_AFTER_MS);
        },
      });
      clearTimeout(slow);
      if (mine !== saveSeq) return;
      if (res.denied || (res.message && !Object.keys(res.errors).length)) {
        toast(res.message, { tone: 'danger', title: 'Not saved', timeout: 8000 });
        return;
      }
      const cachedValues = getDetail(ctx.params.sid)?.settings?.[app.id]?.values;
      let appliedCount = 0;
      for (const key of keys) {
        const field = fields.find((f) => f.key === key);
        const row = rows.get(key);
        if (Object.prototype.hasOwnProperty.call(res.errors, key)) {
          serverErrors[key] = String(res.errors[key]);
          row.setError(serverErrors[key]);
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(res.applied, key)) {
          const edit = toEditValue(field, res.applied[key]);
          base[key] = edit;
          if (sameValue(current[key], sent[key])) {
            current[key] = Array.isArray(edit) ? edit.slice() : edit;
            row.setValue(current[key]);
          }
          if (cachedValues && typeof cachedValues === 'object') cachedValues[key] = res.applied[key];
          row.setError('');
          appliedCount += 1;
        } else {
          serverErrors[key] = "YapOS didn't confirm this change. Try saving again.";
          row.setError(serverErrors[key]);
        }
      }
      const errorKeys = Object.keys(serverErrors);
      if (errorKeys.length) {
        rows.get(errorKeys[0])?.focus();
        toast(appliedCount ? `Saved ${appliedCount}, but ${errorKeys.length} need${errorKeys.length === 1 ? 's' : ''} attention.` : 'Nothing was saved. Check the highlighted fields.', { tone: 'danger', title: 'Some settings were not saved', timeout: 7000 });
      } else {
        toast(appliedCount === 1 ? '1 setting saved.' : `${appliedCount} settings saved.`, { title: `${app.name || app.id} updated` });
      }
    } catch (e) {
      clearTimeout(slow);
      if (isAbort(e) || mine !== saveSeq) return;
      toast(e.message || OFFLINE_MESSAGE, { tone: 'danger', title: 'Not saved', timeout: 8000 });
    } finally {
      if (mine === saveSeq) {
        saving = false;
        setBusy(saveBtn, false);
        saveBtn.querySelector('.btn-label').textContent = 'Save';
        resetBtn.disabled = false;
        refreshBar();
      }
    }
  }

  resetBtn.addEventListener('click', reset);
  saveBtn.addEventListener('click', save);
  const form = h('form', { class: 'settings-form', attrs: { novalidate: true, 'aria-label': `${app.name || app.id} settings` } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && form.isConnected) {
      e.preventDefault();
      if (isDirty()) save();
    }
  };
  document.addEventListener('keydown', onKey);
  ctx.signal.addEventListener('abort', () => document.removeEventListener('keydown', onKey), { once: true });

  if (editable.length) {
    form.appendChild(card({ title: 'Settings', icon: 'sliders', bodyClass: 'field-list' }, ...editable.map((f) => rows.get(f.key).el)));
  } else {
    form.appendChild(card({ title: 'Settings', icon: 'sliders' }, emptyState({ icon: 'sliders', title: 'Nothing to change here', body: 'This app has no settings that can be changed on the dashboard.', compact: true })));
  }
  if (readOnly.length) {
    form.appendChild(card({ title: 'Managed with commands', icon: 'lock', bodyClass: 'field-list' },
      h('p', { class: 'card-intro', text: 'These settings are shown for reference. Change them with the command in your server.' }),
      ...readOnly.map((f) => rows.get(f.key).el)));
  }
  form.appendChild(bar);

  body.replaceChildren(settingsHeader(ctx, app, (on) => drawNotice(on)), notice, form);
  ctx.setLeaveGuard({ isDirty });
  refreshBar();
}

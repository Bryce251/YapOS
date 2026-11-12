import { h, nextId, replace } from '../dom.js';
import { icon } from '../icons.js';
import { button, card, copyButton, linkButton, loadingRegion, pageHeader, setBusy, skeleton, skeletonBlock, switchControl, toast } from '../ui.js';
import { loadServer, mountAsync } from './common.js';
import { serverChrome } from './overview.js';
import { publicPath } from '../router.js';
import { isValidSlug, slugify } from '../format.js';
import { readChangeResult } from '../forms.js';
import { getDetail, mergeSnapshot } from '../state.js';
import { OFFLINE_MESSAGE, SLOW_AFTER_MS, isAbort } from '../api.js';

export function readPublicSetting(detail) {
  const s = detail?.settings || {};
  const candidates = [s.system?.values?.publicPage, s.core?.publicPage, s.core?.values?.publicPage, s.publicPage, detail?.overview?.publicPage];
  const found = candidates.find((c) => c && typeof c === 'object');
  return { enabled: found?.enabled === true, slug: typeof found?.slug === 'string' ? found.slug : '' };
}

function storePublicSetting(sid, value) {
  const d = getDetail(sid);
  if (!d) return;
  d.settings = d.settings || {};
  if (d.settings.system && typeof d.settings.system === 'object') {
    d.settings.system.values = { ...(d.settings.system.values || {}), publicPage: value };
  } else {
    d.settings.core = { ...(d.settings.core || {}), publicPage: value };
  }
}

function publicSkeleton() {
  return loadingRegion('Loading public page settings', h('section', { class: 'card' }, h('div', { class: 'card-body' }, skeletonBlock(2), skeleton('skeleton-input'), skeletonBlock(2))));
}

export function renderPublicSettings(ctx) {
  const { main, params } = ctx;
  serverChrome(ctx, 'public-settings', 'Public page');
  const body = h('div', { class: 'page-body' });
  main.replaceChildren(h('div', { class: 'page page-narrow' },
    pageHeader({ title: 'Public page', description: 'Share a leaderboard anyone can open, no login needed. It shows levels, coins and last month’s Wrapped from public channels.' }),
    body));
  mountAsync(body, {
    signal: ctx.signal,
    skeleton: publicSkeleton,
    load: ({ onPending, signal }) => loadServer(ctx, { onPending, signal }),
    render: (detail) => {
      serverChrome(ctx, 'public-settings', 'Public page');
      const saved = readPublicSetting(detail);
      const name = detail.overview?.name || '';
      let enabled = saved.enabled;
      let serverError = '';
      const ids = { slug: nextId('slug'), help: nextId('slug-help'), err: nextId('slug-err'), toggle: nextId('pub-l') };
      const slugInput = h('input', {
        id: ids.slug,
        type: 'text',
        class: 'input input-mono',
        value: saved.slug || slugify(name),
        maxLength: 32,
        autocomplete: 'off',
        spellcheck: false,
        placeholder: 'my-server',
        attrs: { 'aria-describedby': `${ids.help} ${ids.err}` },
      });
      const errEl = h('p', { class: 'field-error', id: ids.err, attrs: { 'aria-live': 'polite' } });
      const urlPreview = h('span', { class: 'url-preview-path' });
      const status = h('span', { class: 'save-status', attrs: { 'aria-live': 'polite' } });
      const saveBtn = button({ label: 'Save', variant: 'primary' });
      const linkRow = h('div', { class: 'share-row' });
      const sw = switchControl({ checked: enabled, onChange: (v) => {
        enabled = v;
        serverError = '';
        update();
      } });
      sw.el.setAttribute('aria-labelledby', ids.toggle);

      function slugValue() {
        return slugInput.value.trim().toLowerCase();
      }
      function slugError() {
        const v = slugValue();
        if (!v) return enabled ? 'Pick an address for your page.' : '';
        if (!isValidSlug(v)) return 'Use 3 to 32 lowercase letters, numbers or dashes.';
        return '';
      }
      function dirty() {
        return enabled !== saved.enabled || slugValue() !== saved.slug;
      }
      function update() {
        const v = slugValue();
        urlPreview.textContent = v || 'your-address';
        const err = serverError || (v ? slugError() : '');
        errEl.textContent = err;
        slugInput.classList.toggle('is-invalid', Boolean(err));
        if (err) slugInput.setAttribute('aria-invalid', 'true');
        else slugInput.removeAttribute('aria-invalid');
        saveBtn.disabled = !dirty();
        const live = saved.enabled && saved.slug;
        replace(linkRow, live
          ? h('div', { class: 'share-live' },
            h('span', { class: 'live-pill' }, h('span', { class: 'status-dot status-success' }), 'Live'),
            h('a', { href: publicPath(saved.slug), class: 'share-url', target: '_blank', rel: 'noopener', text: `${window.location.host}${publicPath(saved.slug)}` }),
            h('div', { class: 'share-actions' },
              copyButton({ getText: () => `${window.location.origin}${publicPath(saved.slug)}`, size: 'sm' }),
              linkButton({ label: 'Preview', href: publicPath(saved.slug), icon: 'external', size: 'sm', external: true })))
          : h('p', { class: 'muted', text: 'Your page is not published. Turn it on and save to get a link.' }));
      }
      slugInput.addEventListener('input', () => {
        const cleaned = slugInput.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-');
        if (cleaned !== slugInput.value) {
          const pos = slugInput.selectionStart;
          slugInput.value = cleaned;
          slugInput.setSelectionRange(pos, pos);
        }
        serverError = '';
        update();
      });

      saveBtn.addEventListener('click', async () => {
        const err = slugError();
        if (err) {
          errEl.textContent = err;
          slugInput.classList.add('is-invalid');
          slugInput.setAttribute('aria-invalid', 'true');
          slugInput.focus();
          return;
        }
        const payload = { enabled };
        if (slugValue()) payload.slug = slugValue();
        setBusy(saveBtn, true, 'Saving…');
        status.textContent = 'Waiting for YapOS…';
        let slow = null;
        try {
          const { data } = await ctx.api.run('PATCH', `/api/servers/${encodeURIComponent(params.sid)}/public`, payload, {
            signal: ctx.signal,
            onPending: () => {
              slow = setTimeout(() => {
                status.textContent = OFFLINE_MESSAGE;
              }, SLOW_AFTER_MS);
            },
          });
          const res = readChangeResult(data);
          if (res.snapshot) mergeSnapshot(params.sid, res.snapshot);
          const fieldErr = res.errors.slug || res.errors.publicPage || res.errors.enabled || Object.values(res.errors)[0];
          if (res.message || fieldErr) {
            const msg = String(fieldErr || res.message);
            serverError = msg;
            toast(msg, { tone: 'danger', title: 'Not saved', timeout: 7000 });
            return;
          }
          const applied = res.applied.publicPage && typeof res.applied.publicPage === 'object' ? res.applied.publicPage : payload;
          saved.enabled = applied.enabled === true;
          saved.slug = typeof applied.slug === 'string' ? applied.slug : (payload.slug || saved.slug);
          enabled = saved.enabled;
          sw.set(enabled);
          slugInput.value = saved.slug;
          storePublicSetting(params.sid, { enabled: saved.enabled, slug: saved.slug });
          toast(saved.enabled ? 'Your public page is live.' : 'Your public page is now off.', { title: 'Saved' });
        } catch (e) {
          if (isAbort(e)) return;
          const code = e?.data && typeof e.data === 'object' ? e.data.error : '';
          if (e?.status === 409 || e?.status === 400 || code === 'slug_taken' || code === 'bad_slug') {
            serverError = e.message || 'That address can’t be used. Pick a different one.';
            slugInput.focus();
          }
          toast(e.message || OFFLINE_MESSAGE, { tone: 'danger', title: 'Not saved', timeout: 8000 });
        } finally {
          clearTimeout(slow);
          status.textContent = '';
          setBusy(saveBtn, false);
          update();
        }
      });

      body.replaceChildren(
        card({ title: 'Publishing', icon: 'globe' },
          h('div', { class: 'field field-inline' },
            h('div', { class: 'field-text' },
              h('span', { class: 'field-label', id: ids.toggle, text: 'Publish leaderboard page' }),
              h('p', { class: 'field-help', text: 'Anyone with the link can see the top 100 by level and coins, plus the server Wrapped. Nothing private is shown.' })),
            h('div', { class: 'field-control' }, sw.el)),
          h('div', { class: 'field' },
            h('div', { class: 'field-text' },
              h('label', { class: 'field-label', htmlFor: ids.slug, text: 'Page address' }),
              h('p', { class: 'field-help', id: ids.help, text: '3 to 32 lowercase letters, numbers or dashes.' })),
            h('div', { class: 'field-control' },
              h('div', { class: 'input-shell has-prefix' }, h('span', { class: 'input-prefix', text: '/p/' }), slugInput),
              errEl,
              h('p', { class: 'url-preview' }, icon('link', { size: 14 }), h('span', { text: `${window.location.host}/p/` }), urlPreview))),
          h('div', { class: 'card-footer' }, status, saveBtn)),
        card({ title: 'Share', icon: 'share' }, linkRow));
      ctx.setLeaveGuard?.({ isDirty: () => dirty() });
      update();
    },
  });
}

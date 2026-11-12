import { replace } from '../dom.js';
import { ApiError, isAbort, isPending } from '../api.js';
import { errorState, offlineState, pendingState } from '../ui.js';
import { getDetail, isFresh, setDetail } from '../state.js';

export function forbiddenError(message) {
  return new ApiError(message || "You need to be an admin of this server to manage it here.", { status: 403, code: 'forbidden' });
}

export async function loadServer(ctx, { force = false, onPending, signal = ctx.signal } = {}) {
  const { api, params } = ctx;
  const sid = params.sid;
  const cached = getDetail(sid);
  if (cached && !force && isFresh(cached)) return cached;
  const path = `/api/servers/${encodeURIComponent(sid)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await api.get(path, { signal });
    if (!isPending(data)) return setDetail(sid, data);
    onPending?.(data.job);
    const result = await api.job(data.job, { signal });
    if (result && result.grant === false) throw forbiddenError(typeof result.error === 'string' ? result.error : '');
  }
  throw new ApiError("YapOS confirmed your access but the server data hasn't arrived yet. Try again in a moment.", { code: 'timeout' });
}

export function errorView(err, onRetry, { compact = false } = {}) {
  if (err instanceof ApiError) {
    if (err.code === 'timeout') return offlineState({ onRetry, compact });
    if (err.code === 'forbidden' || err.status === 403) {
      return errorState({ title: 'No access to this server', body: err.message, compact, iconName: 'lock' });
    }
    if (err.status === 404) return errorState({ title: 'Not found', body: err.message, onRetry, compact });
    if (err.code === 'unauthorized') return errorState({ title: 'Signed out', body: 'Taking you to the login page…', compact, iconName: 'user' });
    return errorState({ title: 'Something went wrong', body: err.message, onRetry, compact });
  }
  return errorState({ title: 'Something went wrong', body: 'An unexpected error happened. Please try again.', onRetry, compact });
}

export function childSignal(parent) {
  const ctrl = new AbortController();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl;
}

export function mountAsync(container, { skeleton, load, render, signal, compact = false }) {
  let pending = null;
  let token = 0;
  let ctrl = null;
  const run = async () => {
    token += 1;
    const mine = token;
    ctrl?.abort();
    ctrl = childSignal(signal);
    const sub = ctrl.signal;
    pending?.stop();
    pending = null;
    replace(container, skeleton());
    try {
      const data = await load({
        signal: sub,
        onPending: () => {
          if (sub.aborted || pending || mine !== token) return;
          pending = pendingState({ onRetry: run, compact });
          replace(container, pending.el);
        },
      });
      if (sub.aborted || mine !== token) return;
      pending?.stop();
      pending = null;
      replace(container);
      render(data, run);
    } catch (err) {
      if (mine !== token) return;
      pending?.stop();
      pending = null;
      if (isAbort(err) || sub.aborted) return;
      replace(container, errorView(err, run, { compact }));
    }
  };
  run();
  return run;
}

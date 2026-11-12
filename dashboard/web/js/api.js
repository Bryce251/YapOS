export const SLOW_AFTER_MS = 20000;
export const OFFLINE_MESSAGE = "YapOS hasn't answered yet. It may be offline or restarting.";

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', data = null, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
    this.retryAfter = retryAfter;
  }
}

export function isAbort(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.code === 'aborted');
}

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  err.code = 'aborted';
  return err;
}

export function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortError());
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function pollDelay(attempt) {
  const steps = [700, 1000, 1500, 2000, 2000, 2500, 3000];
  return attempt < steps.length ? steps[attempt] : 4000;
}

const STATUS_MESSAGES = {
  400: 'That request was not accepted.',
  401: 'Your session has ended. Please log in again.',
  403: "You don't have permission to do that.",
  404: "We couldn't find that.",
  409: 'That conflicts with something that already exists.',
  413: 'That is too large to save.',
  429: "You're going a little fast. Give it a few seconds.",
  500: 'Something went wrong on our side. Please try again.',
  502: 'The dashboard is having trouble right now. Please try again.',
  503: 'The dashboard is having trouble right now. Please try again.',
};

export function errorMessage(status, data) {
  if (data && typeof data === 'object') {
    if (typeof data.message === 'string' && data.message) return data.message;
    if (typeof data.error === 'string' && data.error && !/^[a-z_]+$/.test(data.error)) return data.error;
  }
  return STATUS_MESSAGES[status] || (status >= 500 ? STATUS_MESSAGES[500] : 'Something went wrong. Please try again.');
}

export function jobErrorMessage(error) {
  const text = typeof error === 'string' ? error : (error && typeof error === 'object' && typeof error.message === 'string' ? error.message : '');
  if (!text || /^timeout$/i.test(text) || /^expired$/i.test(text)) return OFFLINE_MESSAGE;
  return text;
}

export function isPending(data) {
  return Boolean(data) && typeof data === 'object' && data.pending === true && data.job !== undefined && data.job !== null;
}

export function createApi({ fetchImpl, onUnauthorized = () => {}, sleep = defaultSleep, maxJobMs = 150000, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));

  async function request(method, path, opts = {}) {
    try {
      return await send(method, path, opts);
    } catch (err) {
      const jobId = needsRegrant(err);
      if (!jobId || opts.regranted) throw err;
      opts.onPending?.(jobId);
      const result = await job(jobId, { signal: opts.signal });
      if (result && result.grant === false) {
        const message = typeof result.error === 'string' && result.error ? result.error : 'You need to be an admin of this server.';
        throw new ApiError(message, { status: 403, code: 'forbidden', data: result });
      }
      return send(method, path, { ...opts, regranted: true });
    }
  }

  function needsRegrant(err) {
    if (!(err instanceof ApiError) || err.status !== 403) return null;
    const data = err.data;
    if (!data || data.error !== 'grant_required') return null;
    return typeof data.job === 'string' && data.job ? data.job : null;
  }

  async function send(method, path, { body, signal, allow401 = false } = {}) {
    const headers = { Accept: 'application/json' };
    const init = { method, headers, credentials: 'same-origin', cache: 'no-store', signal };
    if (method !== 'GET' && method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
      headers['X-YapOS'] = '1';
      init.body = JSON.stringify(body ?? {});
    }
    let res;
    try {
      res = await doFetch(path, init);
    } catch (err) {
      if (isAbort(err) || signal?.aborted) throw abortError();
      throw new ApiError("Can't reach the dashboard. Check your connection and try again.", { code: 'network' });
    }
    let data = null;
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (res.status === 401) {
      if (!allow401) onUnauthorized();
      throw new ApiError(errorMessage(401, data), { status: 401, code: 'unauthorized', data });
    }
    if (!res.ok) {
      const retryAfter = Number(res.headers?.get?.('Retry-After')) || 0;
      const code = res.status === 429 ? 'rate_limited' : res.status === 404 ? 'not_found' : `http_${res.status}`;
      throw new ApiError(errorMessage(res.status, data), { status: res.status, code, data, retryAfter });
    }
    return data;
  }

  async function job(id, { signal, onAttempt } = {}) {
    const started = now();
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw abortError();
      let data;
      try {
        data = await send('GET', `/api/jobs/${encodeURIComponent(id)}`, { signal });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'rate_limited') {
          await sleep(Math.max(3000, err.retryAfter * 1000), signal);
          continue;
        }
        if (err instanceof ApiError && err.code === 'network' && now() - started < maxJobMs) {
          await sleep(3000, signal);
          continue;
        }
        throw err;
      }
      const status = data && typeof data === 'object' ? data.status : '';
      if (status === 'done') return data.result ?? null;
      if (status === 'error') {
        const message = jobErrorMessage(data.error === 'timeout' ? 'timeout' : (data.message || data.error));
        if (data.result && data.result.grant === false) throw new ApiError(message, { status: 403, code: 'forbidden', data });
        throw new ApiError(message, { code: message === OFFLINE_MESSAGE ? 'timeout' : 'job_error', data });
      }
      if (now() - started > maxJobMs) throw new ApiError(OFFLINE_MESSAGE, { code: 'timeout' });
      onAttempt?.(attempt);
      await sleep(pollDelay(attempt), signal);
      attempt += 1;
    }
  }

  async function settle(data, opts = {}) {
    if (!isPending(data)) return { data, fromJob: false };
    opts.onPending?.(data.job);
    const result = await job(data.job, opts);
    return { data: result, fromJob: true };
  }

  return {
    request,
    job,
    settle,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { ...opts, body }),
    patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
    async run(method, path, body, opts = {}) {
      const data = await request(method, path, { ...opts, body });
      return settle(data, opts);
    },
  };
}

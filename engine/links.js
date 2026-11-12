const FILE_HOST = 'https://files.yapper.website/attachments/';
const APP_HOST = 'https://www.yapper.website/';
const PICTURE = /\.(png|jpe?g|gif|webp)$/i;

export function fileUrl(path) {
  if (typeof path !== 'string') return null;
  const p = path.trim();
  if (!p || p.length > 500 || /[\\\s?#\u0000-\u001F\u007F]/.test(p)) return null;
  if (/^https:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      return ['files.yapper.website', 'www.yapin.gg'].includes(u.hostname) ? u.href : null;
    } catch { return null; }
  }
  if (p.startsWith('//') || p.split('/').some((part) => part === '..' || part === '.')) return null;
  if (p.startsWith('/')) return `https://www.yapin.gg${p}`;
  return FILE_HOST + p.split('/').map(encodeURIComponent).join('/');
}

const AVATAR_HOST = 'https://files.yapper.website/avatars/';
const SITE_HOST = 'https://www.yapin.gg';

export function avatarUrl(path) {
  if (typeof path !== 'string' || !path.trim()) return null;
  const p = path.trim();
  if (/\s|\\/.test(p)) return null;
  if (/^https:\/\//i.test(p)) return [AVATAR_HOST, `${SITE_HOST}/`].some((host) => p.toLowerCase().startsWith(host)) ? p : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//') || /[?#]/.test(p) || p.split('/').includes('..')) return null;
  if (p.startsWith('/')) return SITE_HOST + p;
  return AVATAR_HOST + p;
}

export const isPicture =(nameOrPath) => PICTURE.test(String(nameOrPath ?? '').split('?')[0]);

export function messageLink(serverId, channelId, messageId) {
  if (!channelId || !messageId) return null;
  const q = new URLSearchParams();
  if (serverId) q.set('server', serverId);
  q.set('channel', channelId);
  q.set('msg', messageId);
  return `${APP_HOST}?${q.toString()}`;
}

export function messageFiles(m) {
  const out = [];
  const seen = new Set();
  const add = (path, name) => {
    const url = fileUrl(path);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, name: name || String(path).split('/').pop() });
  };
  for (const a of Array.isArray(m?.attachments) ? m.attachments : []) {
    if (typeof a === 'string') add(a);
    else if (a) add(a.path || a.url, a.name);
  }
  if (m?.attachment_path) add(m.attachment_path, m.attachment_name);
  if (typeof m?.attachment === 'string') add(m.attachment);
  return out;
}

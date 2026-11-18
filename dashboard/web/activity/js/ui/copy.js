export const COPY_BOX_CLASS = 'signin-copy-box';

export function legacyCopy(doc, value, host = null) {
  if (!doc || typeof doc.execCommand !== 'function' || typeof doc.createElement !== 'function') return false;
  const box = doc.createElement('textarea');
  box.value = value;
  box.setAttribute('readonly', '');
  box.setAttribute('aria-hidden', 'true');
  box.className = COPY_BOX_CLASS;
  const parent = host || doc.body;
  const back = doc.activeElement;
  try {
    parent.appendChild(box);
    if (typeof box.select === 'function') box.select();
    if (typeof box.setSelectionRange === 'function') box.setSelectionRange(0, box.value.length);
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    box.remove();
    if (back && typeof back.focus === 'function') back.focus();
  }
}

export async function copyText({ win, doc, value, host = null }) {
  if (typeof value !== 'string' || !value) return false;
  if (legacyCopy(doc, value, host)) return true;
  try {
    const clip = win && win.navigator && win.navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      await clip.writeText(value);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

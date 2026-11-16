import assert from 'node:assert/strict';

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    if (c.localName) {
      out.push(c);
      walk(c, out);
    }
  }
  return out;
}

function insideButton(node, root) {
  let up = node.parentNode;
  while (up && up !== root) {
    if (up.localName === 'button') return true;
    up = up.parentNode;
  }
  return false;
}

export function checkProfileFaces(root, min = 1) {
  const nodes = walk(root);
  const faces = nodes.filter((n) => n.getAttribute && n.getAttribute('data-profile-id') && n.getAttribute('role') === 'button');
  assert.ok(faces.length >= min, `expected at least ${min} profile avatars, got ${faces.length}`);
  for (const f of faces) {
    assert.ok(f.classList.contains('avatar-btn'), 'profile avatars use the shared avatar look');
    assert.equal(f.getAttribute('tabindex'), '0');
    assert.match(f.getAttribute('aria-label'), /^View (your|.+'s) profile$/);
    assert.equal(insideButton(f, root), false, 'a profile avatar never sits inside another button');
  }
  for (const n of nodes) {
    if (!n.classList || !n.classList.contains('avatar') || !n.getAttribute('data-profile-id')) continue;
    const up = n.parentNode;
    assert.ok(up && up.classList && up.classList.contains('avatar-btn'), 'every player avatar is wrapped in a profile button');
  }
  return faces;
}

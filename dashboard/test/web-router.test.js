import test from 'node:test';
import assert from 'node:assert/strict';
import { isInternalHref, loginUrl, matchRoute, normalizePath, publicPath, safeNext, sectionFor, serverPath } from '../web/js/router.js';

const SID = '33333333-3333-4333-8333-333333333333';

test('matches every page in the contract', () => {
  assert.equal(matchRoute('/').name, 'landing');
  assert.equal(matchRoute('/servers').name, 'servers');
  assert.deepEqual(matchRoute(`/servers/${SID}`).params, { sid: SID });
  assert.equal(matchRoute(`/servers/${SID}`).name, 'overview');
  assert.equal(matchRoute(`/servers/${SID}/apps`).name, 'apps');
  const app = matchRoute(`/servers/${SID}/apps/levels`);
  assert.equal(app.name, 'app');
  assert.deepEqual(app.params, { sid: SID, app: 'levels' });
  assert.equal(matchRoute(`/servers/${SID}/cases`).name, 'cases');
  assert.equal(matchRoute(`/servers/${SID}/members`).name, 'members');
  assert.deepEqual(matchRoute(`/servers/${SID}/members`).params, { sid: SID });
  assert.equal(matchRoute(`/servers/${SID}/mod`).name, 'mod');
  assert.equal(matchRoute(`/servers/${SID}/tickets`).name, 'tickets');
  assert.equal(matchRoute(`/servers/${SID}/tickets`).private, true);
  assert.equal(matchRoute(`/servers/${SID}/members/u1`).name, 'not-found');
  assert.equal(sectionFor('members'), 'members');
  assert.equal(sectionFor('mod'), 'mod');
  assert.equal(sectionFor('tickets'), 'tickets');
  assert.equal(matchRoute(`/servers/${SID}/public`).name, 'public-settings');
  const pub = matchRoute('/p/My-Server');
  assert.equal(pub.name, 'public');
  assert.equal(pub.params.slug, 'my-server');
});

test('private flags', () => {
  assert.equal(matchRoute('/').private, false);
  assert.equal(matchRoute('/p/abc').private, false);
  assert.equal(matchRoute('/servers').private, true);
  assert.equal(matchRoute(`/servers/${SID}/cases`).private, true);
});

test('normalizes trailing and repeated slashes', () => {
  assert.equal(normalizePath('/servers/'), '/servers');
  assert.equal(normalizePath('//servers'), '/servers');
  assert.equal(normalizePath(''), '/');
  assert.equal(matchRoute('/servers/').name, 'servers');
});

test('unknown and malformed paths are not found', () => {
  assert.equal(matchRoute('/nope').name, 'not-found');
  assert.equal(matchRoute('/servers/a b').name, 'not-found');
  assert.equal(matchRoute(`/servers/${SID}/apps/Bad.App`).name, 'not-found');
  assert.equal(matchRoute('/p/a%2Fb').name, 'not-found');
  assert.equal(matchRoute('/servers/%E0%A4%A').name, 'not-found');
});

test('safeNext only allows same-site paths', () => {
  assert.equal(safeNext('/servers/x?y=1'), '/servers/x?y=1');
  assert.equal(safeNext('//evil.example'), '/servers');
  assert.equal(safeNext('/\\evil.example'), '/servers');
  assert.equal(safeNext('https://evil.example'), '/servers');
  assert.equal(safeNext('javascript:alert(1)'), '/servers');
  assert.equal(safeNext('/a\nb'), '/servers');
  assert.equal(safeNext(''), '/servers');
  assert.equal(safeNext(null, '/'), '/');
});

test('login url encodes next', () => {
  assert.equal(loginUrl('/servers/a?b=c&d=e'), '/auth/login?next=%2Fservers%2Fa%3Fb%3Dc%26d%3De');
  assert.equal(loginUrl('//evil'), '/auth/login?next=%2Fservers');
});

test('path builders', () => {
  assert.equal(serverPath(SID), `/servers/${SID}`);
  assert.equal(serverPath(SID, 'apps/levels'), `/servers/${SID}/apps/levels`);
  assert.equal(publicPath('my-server'), '/p/my-server');
});

test('internal href detection skips api, auth and other origins', () => {
  const origin = 'https://dash.example.test';
  assert.equal(isInternalHref('/servers', origin), true);
  assert.equal(isInternalHref('https://dash.example.test/p/x', origin), true);
  assert.equal(isInternalHref('/auth/login?next=/', origin), false);
  assert.equal(isInternalHref('/api/me', origin), false);
  assert.equal(isInternalHref('https://other.example/servers', origin), false);
  assert.equal(isInternalHref('', origin), false);
});

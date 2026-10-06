import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, validateConfig, createPolicy, logUrl } from '../src/config.js';
import { stateForOrigin } from '../src/auth.js';
const config = extra => validateConfig({ startUrl: 'https://example.com/', ...extra });
test('conservative identity retains query order, encoding, path case, slash and SPA fragments', () => {
  for (const path of ['/a?a=1&b=2', '/a?b=2&a=1', '/a?x=1&x=2', '/a?x=%61', '/a?x=a', '/A/', '/A', '/#/account', '/#heading']) assert.equal(canonicalUrl(`https://example.com${path}`), `https://example.com${path}`);
  assert.equal(canonicalUrl('https://EXAMPLE.com:443/a'), 'https://example.com/a');
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
  assert.equal(canonicalUrl('https://user:password@example.com'), null);
});
test('cross-domain default; path and URL globs; domain denies include subdomains and win', () => {
  assert.equal(createPolicy(config())('https://elsewhere.test/a'), null);
  const policy = createPolicy(config({ include: ['/docs/**', 'https://other.test/**'], exclude: ['/docs/private/**'], denyDomains: ['blocked.test'] }));
  assert.equal(policy('https://example.com/docs/page?foo=1'), null);
  assert.equal(policy('https://example.com/docs/private/a'), 'excluded');
  assert.equal(policy('https://other.test/a'), null);
  assert.equal(policy('https://sub.BLOCKED.test.:8443/docs/x'), 'denied-domain');
  assert.equal(policy('https://notblocked.test/docs/x'), null);
  assert.equal(policy('https://example.com/home'), 'not-included');
});
test('schema rejects typos, unsafe values and multiple sites', () => {
  for (const bad of [{ startUrls: [] }, { maxConcurrency: 0 }, { maxRetries: 11 }, { denyDomains: ['*.example.com'] }, { auth: { origins: ['https://example.com/'] } }]) assert.throws(() => config(bad));
  assert.equal(config({ maxRetries: 0 }).maxRetries, 0);
});
test('logs redact likely secrets without changing stored identity', () => {
  assert.match(logUrl('https://example.com/?token=secret&x=1'), /redacted/);
  assert.ok(!logUrl('https://example.com/#access_token=secret').includes('secret'));
  assert.ok(!logUrl('https://example.com/?token=secret&x=1').includes('secret'));
});
test('auth preserves cookie host semantics and narrows domain cookies', () => {
  const state = { cookies: [{ name: 'parent', value: 'x', domain: '.example.com', secure: true }, { name: 'host', value: 'y', domain: 'example.com', secure: true }, { name: 'other', value: 'z', domain: 'else.test', secure: false }], origins: [{ origin: 'https://a.example.com', localStorage: [] }, { origin: 'https://else.test', localStorage: [] }] };
  const scoped = stateForOrigin(state, 'https://a.example.com');
  assert.deepEqual(scoped.cookies.map(x => [x.name, x.domain]), [['parent', 'a.example.com']]);
  assert.equal(scoped.origins.length, 1);
  assert.equal(stateForOrigin(state, 'http://a.example.com').cookies.length, 0);
});

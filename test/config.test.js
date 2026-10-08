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
test('default scope is the canonical start URL prefix, with omitted or empty include', () => {
  for (const extra of [{}, { include: [] }]) {
    const policy = createPolicy(config({ startUrl: 'https://example.com/docs/', ...extra }));
    for (const url of ['https://example.com/docs/', 'https://example.com/docs/a', 'https://example.com/docs/?x=1', 'https://example.com/docs/#intro']) assert.equal(policy(url), null);
    for (const url of ['https://example.com/', 'https://example.com/docs', 'https://example.com/docs-other', 'https://example.com/elsewhere', 'https://other.test/docs/', 'https://example.com.evil.test/docs/', 'http://example.com/docs/', 'https://example.com:8443/docs/']) assert.equal(policy(url), 'not-included', url);
  }
});
test('prefix semantics are literal, including trailing slash, query and fragment', () => {
  const noSlash = createPolicy(config({ startUrl: 'https://example.com/docs' }));
  assert.equal(noSlash('https://example.com/docs-other'), null);
  assert.equal(noSlash('https://example.com/docs?x=1'), null);
  const query = createPolicy(config({ startUrl: 'https://example.com/docs?x=1' }));
  assert.equal(query('https://example.com/docs?x=12&y=2'), null);
  assert.equal(query('https://example.com/docs?y=2&x=1'), 'not-included');
  const fragment = createPolicy(config({ startUrl: 'https://example.com/#/docs' }));
  assert.equal(fragment('https://example.com/#/docs/child'), null);
  assert.equal(fragment('https://example.com/#/other'), 'not-included');
});
test('prefix uses normal URL serialization without merging distinct paths or encodings', () => {
  const policy = createPolicy(config({ startUrl: 'HTTPS://EXAMPLE.COM:443/old/../Docs/%61/' }));
  assert.equal(policy('https://example.com/Docs/%61/page'), null);
  assert.equal(policy('https://EXAMPLE.com:443/Docs/%61/page'), null);
  assert.equal(policy('https://example.com/Docs/a/page'), 'not-included');
  assert.equal(policy('https://example.com/docs/%61/page'), 'not-included');
  assert.equal(policy('https://example.com/Docs/%61/../../outside'), 'not-included');
});
test('explicit path and URL globs expand the prefix while all deny rules still win', () => {
  const policy = createPolicy(config({ startUrl: 'https://example.com/docs/', include: ['/guides/**', 'https://other.test/**'], exclude: ['/docs/private/**', '/guides/private/**'], denyDomains: ['blocked.test'] }));
  assert.equal(policy('https://example.com/docs/page?foo=1'), null);
  assert.equal(policy('https://example.com/docs/private/a'), 'excluded');
  assert.equal(policy('https://other.test/a'), null);
  assert.equal(policy('https://example.com/guides/a'), null);
  assert.equal(policy('https://elsewhere.test/guides/a'), null);
  assert.equal(policy('https://elsewhere.test/guides/private/a'), 'excluded');
  assert.equal(policy('https://sub.BLOCKED.test.:8443/guides/x'), 'denied-domain');
  assert.equal(policy('https://example.com/home'), 'not-included');
  assert.equal(createPolicy(config({ denyDomains: ['example.com'] }))('https://example.com/'), 'denied-domain');
});
test('an explicit all-URL include can opt into the former broad scope', () => {
  assert.equal(createPolicy(config({ include: ['**'] }))('https://elsewhere.test/a'), null);
  assert.equal(createPolicy(config({ include: ['**'], denyDomains: ['elsewhere.test'] }))('https://elsewhere.test/a'), 'denied-domain');
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

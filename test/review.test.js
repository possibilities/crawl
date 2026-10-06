import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { validateConfig } from '../src/config.js';
import { crawl } from '../src/crawler.js';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'crawl-review-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return { instance, origin: `http://127.0.0.1:${instance.address().port}` };
}

const executablePath = process.env.CRAWL_CHROMIUM_EXECUTABLE;
const browserOptions = { timeout: 30000 };

async function run(t, startUrl, extraConfig = {}, extraOptions = {}) {
  const cwd = await directory(t);
  const config = validateConfig({ startUrl, maxConcurrency: 1, maxRetries: 0, maxPagesPerRun: 5, ...extraConfig });
  const store = await Store.open(cwd, config.startUrl);
  try {
    await crawl(config, store, { launchOptions: { executablePath }, logger() {}, ...extraOptions });
    return [...store.rows()];
  } finally { store.close(); }
}

function cookieState() {
  return { cookies: [{ name: 'session', value: 'review-secret', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] };
}

test('review: refuses symlinked output directories without deleting target files', async t => {
  const cwd = await directory(t);
  const victim = join(cwd, 'unrelated');
  await mkdir(join(victim, 'pages'), { recursive: true });
  await writeFile(join(victim, 'pages', 'keep.txt'), 'keep me');
  await symlink(victim, join(cwd, 'crawl-output'), 'dir');
  await assert.rejects(async () => {
    const store = await Store.open(cwd, 'https://example.test/');
    store.close();
  });
  assert.equal(await readFile(join(victim, 'pages', 'keep.txt'), 'utf8'), 'keep me');
});

test('review: refuses nonempty unmanaged output without deleting existing files', async t => {
  const cwd = await directory(t);
  const pages = join(cwd, 'crawl-output', 'pages');
  await mkdir(pages, { recursive: true });
  await writeFile(join(pages, 'keep.txt'), 'keep me');
  await assert.rejects(async () => {
    const store = await Store.open(cwd, 'https://example.test/');
    store.close();
  });
  assert.equal(await readFile(join(pages, 'keep.txt'), 'utf8'), 'keep me');
});

test('review: an excluded redirect target never receives a request', browserOptions, async t => {
  let deniedHits = 0;
  const source = await server(t, (req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: '/denied' }); res.end(); }
    else { if (req.url === '/denied') deniedHits++; res.setHeader('content-type', 'text/html'); res.end('<title>denied</title>'); }
  });
  const rows = await run(t, `${source.origin}/start`, { exclude: ['/denied'] });
  assert.equal(deniedHits, 0, 'deny rules must be applied before redirect network traffic');
  assert.equal(rows[0].status, 'skipped');
});

test('review: authenticated redirect never sends cookies to another port', browserOptions, async t => {
  const cookies = [];
  const target = await server(t, (req, res) => { cookies.push(req.headers.cookie ?? ''); res.setHeader('content-type', 'text/html'); res.end('<title>public target</title>'); });
  const source = await server(t, (req, res) => { res.writeHead(302, { Location: `${target.origin}/target` }); res.end(); });
  await run(t, `${source.origin}/start`, { auth: { origins: [source.origin] } }, { authState: cookieState() });
  assert.ok(cookies.every(cookie => !cookie.includes('review-secret')), `cross-origin redirect sent cookie: ${JSON.stringify(cookies)}`);
});

test('review: authenticated popup never sends cookies to another port', browserOptions, async t => {
  const cookies = [];
  const target = await server(t, (req, res) => { cookies.push(req.headers.cookie ?? ''); res.setHeader('content-type', 'text/html'); res.end('<title>popup</title>'); });
  const source = await server(t, (req, res) => {
    if (req.url === '/slow.js') { setTimeout(() => { res.setHeader('content-type', 'text/javascript'); res.end(''); }, 250); return; }
    res.setHeader('content-type', 'text/html');
    res.end(`<script>window.open(${JSON.stringify(`${target.origin}/popup`)})</script><script src="/slow.js"></script><title>source</title>`);
  });
  await run(t, `${source.origin}/start`, { auth: { origins: [source.origin] } }, { authState: cookieState() });
  assert.ok(cookies.every(cookie => !cookie.includes('review-secret')), `cross-origin popup sent cookie: ${JSON.stringify(cookies)}`);
});

test('review: authenticated websocket never sends cookies to another port', browserOptions, async t => {
  const cookies = [];
  const target = await server(t, (_req, res) => res.end());
  target.instance.on('upgrade', (req, socket) => { cookies.push(req.headers.cookie ?? ''); socket.destroy(); });
  const source = await server(t, (req, res) => {
    if (req.url === '/slow.js') { setTimeout(() => { res.setHeader('content-type', 'text/javascript'); res.end(''); }, 250); return; }
    res.setHeader('content-type', 'text/html');
    res.end(`<script>new WebSocket(${JSON.stringify(`${target.origin.replace('http:', 'ws:')}/ws`)})</script><script src="/slow.js"></script><title>source</title>`);
  });
  await run(t, `${source.origin}/start`, { auth: { origins: [source.origin] } }, { authState: cookieState() });
  assert.ok(cookies.every(cookie => !cookie.includes('review-secret')), `cross-origin websocket sent cookie: ${JSON.stringify(cookies)}`);
});

test('review: a same-origin subresource redirect cannot leak auth to another origin', browserOptions, async t => {
  const cookies = [];
  const target = await server(t, (req, res) => { cookies.push(req.headers.cookie ?? ''); res.setHeader('content-type', 'text/javascript'); res.end('window.leaked = true'); });
  let localAuthSeen = false;
  const source = await server(t, (req, res) => {
    localAuthSeen ||= (req.headers.cookie ?? '').includes('review-secret');
    if (req.url === '/redirect.js') { res.writeHead(302, { Location: `${target.origin}/script.js` }); res.end(); return; }
    res.setHeader('content-type', 'text/html');
    res.end('<script src="/redirect.js"></script><title>source</title>');
  });
  await run(t, `${source.origin}/start`, { auth: { origins: [source.origin] } }, { authState: cookieState() });
  assert.equal(localAuthSeen, true, 'the test must exercise an authenticated initial request');
  assert.deepEqual(cookies, [], 'off-origin resource redirect must be blocked before its first request');
});

test('review: a post-commit metadata error never refetches the committed page', browserOptions, async t => {
  let rootHits = 0;
  const source = await server(t, (req, res) => {
    if (req.url === '/start') rootHits++;
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/start' ? '<title>committed</title><a href="/child">child</a>' : '<title>child</title>');
  });
  const cwd = await directory(t);
  const config = validateConfig({ startUrl: `${source.origin}/start`, maxConcurrency: 1, maxRetries: 2, maxRequestsPerMinute: 60000 });
  let store = await Store.open(cwd, config.startUrl);
  const writeRecord = store.writeRecord.bind(store);
  let injected = false;
  store.writeRecord = async row => {
    if (!injected && row.url === config.startUrl && row.status === 'succeeded') {
      injected = true;
      throw new Error('simulated one-time derived metadata write failure');
    }
    return writeRecord(row);
  };
  try {
    await crawl(config, store, { launchOptions: { executablePath }, logger() {} });
    assert.equal(injected, true);
    assert.equal(store.get(config.startUrl).status, 'succeeded');
    assert.equal(rootHits, 1, 'Crawlee retries must not reload an already committed page');
  } finally { store.close(); }
  store = await Store.open(cwd, config.startUrl);
  try {
    await crawl(config, store, { launchOptions: { executablePath }, logger() {} });
    assert.equal(rootHits, 1, 'resume must retain the original committed snapshot');
    assert.equal(store.get(`${source.origin}/child`).status, 'succeeded', 'children committed with the page must still resume');
  } finally { store.close(); }
});

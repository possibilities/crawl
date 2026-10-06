import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, atomicWrite, urlId } from '../src/store.js';
const root = 'https://example.com/';
async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), 'crawl-store-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
test('dedupe, atomic page+children commit and repair stale derived output', async t => {
  const dir = await fixture(t); let store = await Store.open(dir, root);
  store.discover(root); store.discover(root); store.start(root);
  const original = store.writeRecord;
  store.writeRecord = async () => { throw new Error('simulated metadata disk failure'); };
  await assert.rejects(store.savePage(root, { loadedUrl: root, httpStatus: 200, title: 'Title' }, '<html>rendered</html>', [root + 'a', root + 'a']));
  assert.equal(store.get(root).status, 'succeeded');
  assert.equal(store.get(root + 'a').status, 'pending');
  store.writeRecord = original; store.close();
  store = await Store.open(dir, root); t.after(() => store.close());
  const records = (await readFile(join(dir, 'crawl-output', 'manifest.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2); assert.equal(records[0].status, 'succeeded');
  assert.equal(JSON.parse(await readFile(join(dir, 'crawl-output/records', `${urlId(root)}.json`), 'utf8')).title, 'Title');
});
test('interrupted visits become pending, uncommitted HTML and temp files are removed', async t => {
  const dir = await fixture(t); let store = await Store.open(dir, root); store.discover(root); store.start(root); store.close();
  await atomicWrite(join(dir, 'crawl-output/pages', `${urlId(root)}.html`), 'orphan');
  await writeFile(join(dir, 'crawl-output/pages/orphan.tmp'), 'partial');
  store = await Store.open(dir, root); t.after(() => store.close());
  assert.equal(store.get(root).status, 'pending');
  assert.deepEqual(await readdir(join(dir, 'crawl-output/pages')), []);
});
test('missing or corrupt committed HTML fails closed instead of silently recrawling', async t => {
  const dir = await fixture(t); const store = await Store.open(dir, root); store.discover(root);
  await store.savePage(root, { loadedUrl: root, httpStatus: 200, title: '' }, 'real', []); store.close();
  await writeFile(join(dir, 'crawl-output/pages', `${urlId(root)}.html`), 'corrupt');
  await assert.rejects(Store.open(dir, root), /corrupt/);
});
test('a directory is permanently bound to one start URL', async t => {
  const dir = await fixture(t); const store = await Store.open(dir, root); store.close();
  await assert.rejects(Store.open(dir, root + 'another'), /different startUrl/);
});

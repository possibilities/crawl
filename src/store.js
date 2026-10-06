import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, readdir, unlink, readFile, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

export const urlId = url => createHash('sha256').update(url).digest('hex');
export async function atomicWrite(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
  // Persist the rename, not just file contents, on local filesystems supporting fsync.
  const directory = await open(join(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function inspectDirectory(path) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed crawl paths must be real directories, never symlinks');
  for (const name of await readdir(path)) {
    const child = join(path, name), entry = await lstat(child);
    if (entry.isSymbolicLink()) throw new Error('Managed crawl paths must not contain symlinks');
    if (entry.isDirectory()) await inspectDirectory(child);
  }
  return true;
}
async function prepareDirectory(path, startUrl) {
  const exists = await inspectDirectory(path);
  if (exists && (await readdir(path)).length) {
    let marker;
    try { marker = JSON.parse(await readFile(join(path, '.crawl-owner.json'), 'utf8')); } catch { throw new Error('Refusing a nonempty unmanaged crawl directory'); }
    if (marker.version !== 1 || marker.startUrl !== startUrl) throw new Error('This directory already belongs to a different startUrl; use a new directory');
  }
}
export class Store {
  static async open(cwd, startUrl) {
    const state = join(cwd, '.crawl'), output = join(cwd, 'crawl-output');
    await prepareDirectory(state, startUrl); await prepareDirectory(output, startUrl);
    for (const path of [state, output, join(output, 'pages'), join(output, 'records')]) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
    for (const path of [state, output]) {
      await atomicWrite(join(path, '.crawl-owner.json'), JSON.stringify({ version: 1, startUrl }));
      await atomicWrite(join(path, '.gitignore'), '*\n');
    }
    const db = new DatabaseSync(join(state, 'crawl.sqlite'));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, status TEXT NOT NULL, discoveredAt TEXT NOT NULL,
        startedAt TEXT, finishedAt TEXT, attempts INTEGER NOT NULL DEFAULT 0, loadedUrl TEXT, httpStatus INTEGER, title TEXT,
        htmlPath TEXT, htmlSha256 TEXT, reason TEXT, links TEXT NOT NULL DEFAULT '[]');`);
    const saved = db.prepare("SELECT value FROM settings WHERE key='startUrl'").get();
    if (saved && saved.value !== startUrl) { db.close(); throw new Error('This directory already belongs to a different startUrl; use a new directory'); }
    db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('startUrl',?)").run(startUrl);
    const store = new Store(db, state, output);
    db.prepare("UPDATE jobs SET status='pending' WHERE status='visiting'").run();
    try { await store.repairOutput(); return store; } catch (error) { db.close(); throw error; }
  }
  constructor(db, state, output) { this.db = db; this.state = state; this.output = output; }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  discover(url) {
    this.db.prepare("INSERT OR IGNORE INTO jobs(id,url,status,discoveredAt) VALUES (?,?,'pending',?)").run(urlId(url), url, new Date().toISOString());
  }
  get(url) { return this.db.prepare('SELECT * FROM jobs WHERE url=?').get(url); }
  rows() { return this.db.prepare('SELECT * FROM jobs ORDER BY discoveredAt,id').iterate(); }
  unfinished() { return this.db.prepare("SELECT * FROM jobs WHERE status IN ('pending','skipped') ORDER BY discoveredAt,id").all(); }
  start(url) { this.db.prepare("UPDATE jobs SET status='visiting',startedAt=?,attempts=attempts+1,reason=NULL WHERE url=?").run(new Date().toISOString(), url); }
  reset(url) { this.db.prepare("UPDATE jobs SET status='pending',finishedAt=NULL,reason=NULL WHERE url=?").run(url); }
  finish(url, status, reason, extra = {}) {
    this.db.prepare('UPDATE jobs SET status=?,reason=?,finishedAt=?,loadedUrl=?,httpStatus=? WHERE url=?')
      .run(status, reason, new Date().toISOString(), extra.loadedUrl ?? null, extra.httpStatus ?? null, url);
  }
  async savePage(url, data, html, links) {
    const id = urlId(url), htmlPath = `pages/${id}.html`, htmlSha256 = createHash('sha256').update(html).digest('hex');
    await atomicWrite(join(this.output, htmlPath), html);
    this.transaction(() => {
      for (const link of links) this.discover(link);
      this.db.prepare("UPDATE jobs SET status='succeeded',finishedAt=?,loadedUrl=?,httpStatus=?,title=?,htmlPath=?,htmlSha256=?,reason=NULL,links=? WHERE url=?")
        .run(new Date().toISOString(), data.loadedUrl, data.httpStatus, data.title, htmlPath, htmlSha256, JSON.stringify(links), url);
    });
    await this.writeRecord(this.get(url));
  }
  metadata(row) { return { ...row, links: JSON.parse(row.links), recordPath: `records/${row.id}.json` }; }
  async writeRecord(row) { await atomicWrite(join(this.output, 'records', `${row.id}.json`), `${JSON.stringify(this.metadata(row), null, 2)}\n`); }
  async repairOutput() {
    // The DB commits after HTML is durable. Repair missing/stale derived records without refetching.
    const committed = new Set();
    for (const row of this.rows()) {
      if (row.status === 'succeeded') {
        let html;
        try { html = await readFile(join(this.output, row.htmlPath)); } catch { throw new Error(`Saved HTML is missing for record ${row.id}; restore output from backup`); }
        if (createHash('sha256').update(html).digest('hex') !== row.htmlSha256) throw new Error(`Saved HTML is corrupt for record ${row.id}; restore output from backup`);
        committed.add(`${row.id}.html`);
      }
      await this.writeRecord(row);
    }
    for (const file of await readdir(join(this.output, 'pages'))) if (/^(?:[a-f0-9]{64}\.html|.*\.tmp)$/.test(file) && !committed.has(file)) await unlink(join(this.output, 'pages', file));
    for (const folder of [this.output, join(this.output, 'records')]) for (const file of await readdir(folder)) if (file.endsWith('.tmp')) await unlink(join(folder, file));
    await this.exportManifest();
  }
  async exportManifest() {
    const target = join(this.output, 'manifest.jsonl'), temp = `${target}.${randomUUID()}.tmp`;
    const stream = createWriteStream(temp, { flags: 'wx', mode: 0o600 });
    const complete = once(stream, 'finish');
    for (const row of this.rows()) if (!stream.write(`${JSON.stringify(this.metadata(row))}\n`)) await once(stream, 'drain');
    stream.end(); await complete;
    const file = await open(temp, 'r'); try { await file.sync(); } finally { await file.close(); }
    await rename(temp, target);
    const directory = await open(this.output, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    await atomicWrite(join(this.output, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), index: 'manifest.jsonl', records: 'records/', pages: 'pages/', counts: this.counts(), note: 'JSONL is a startup/shutdown snapshot. Per-URL records are updated as work finishes; .crawl/crawl.sqlite is authoritative after a crash.' }, null, 2)}\n`);
  }
  counts() { return Object.fromEntries(this.db.prepare('SELECT status,count(*) AS n FROM jobs GROUP BY status').all().map(row => [row.status,row.n])); }
  close() { this.db.close(); }
}

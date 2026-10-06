#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { crawl } from '../src/crawler.js';
import { loadAuth, login } from '../src/auth.js';

const command = process.argv[2] ?? 'run';
if (['--help', '-h', 'help'].includes(command)) {
  console.log('crawl [run | login]\n\nReads ./site.yml. Writes private ./crawl-output and ./.crawl.\nrun: resume unfinished URLs (default); login: establish dedicated local browser state.\nNode.js 24+ and Playwright Chromium are required. See README for setup.');
} else if (!['run', 'login'].includes(command) || process.argv.length > 3) {
  console.error('Usage: crawl [run | login]'); process.exitCode = 1;
} else {
  const cwd = process.cwd();
  let release, store, stop, interrupted = false;
  try {
    const config = await loadConfig(cwd);
    await mkdir(join(cwd, '.crawl'), { recursive: true, mode: 0o700 });
    release = await lockfile.lock(join(cwd, '.crawl'), { realpath: false, stale: 10000, update: 2000, retries: 0 });
    store = await Store.open(cwd, config.startUrl);
    const launchOptions = process.env.CRAWL_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CRAWL_CHROMIUM_EXECUTABLE } : {};
    if (command === 'login') await login(cwd, config, launchOptions);
    else {
      const authState = await loadAuth(cwd, config);
      const counts = await crawl(config, store, { authState, launchOptions, onCrawler(crawler) {
        stop = () => { if (!interrupted) console.log('Stopping after active pages finish; run crawl again to resume'); interrupted = true; crawler.stop(); };
        process.on('SIGINT', stop); process.on('SIGTERM', stop);
      } });
      console.log(JSON.stringify({ event: 'summary', counts, manifest: 'crawl-output/manifest.jsonl' }));
      process.exitCode = interrupted ? 130 : (counts.failed ? 2 : 0);
    }
  } catch (error) {
    // Avoid raw browser errors, which may contain private URLs, response bodies or auth data.
    console.error(error.code === 'ELOCKED' ? 'Another crawl or login is using this directory. If it crashed, wait 10 seconds and retry.' : `crawl: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (stop) { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    store?.close();
    await release?.();
  }
}

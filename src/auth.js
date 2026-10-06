import { readFile, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { atomicWrite } from './store.js';

export function stateForOrigin(saved, origin) {
  const { hostname, protocol } = new URL(origin);
  return {
    cookies: (saved.cookies ?? []).filter(cookie => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      const matches = cookie.domain.startsWith('.') ? hostname === domain || hostname.endsWith(`.${domain}`) : hostname === domain;
      return matches && (!cookie.secure || protocol === 'https:');
    }).map(cookie => ({ ...cookie, domain: hostname })), // Narrow parent-domain cookies; never widen them.
    origins: (saved.origins ?? []).filter(item => item.origin === origin),
  };
}
export async function loadAuth(cwd, config) {
  if (!config.auth) return null;
  const file = join(cwd, '.crawl', 'auth.json');
  let raw;
  try {
    const info = await stat(file);
    if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Authentication file must be private: chmod 600 .crawl/auth.json');
    const contents = await readFile(file, 'utf8');
    try { raw = JSON.parse(contents); } catch { throw new Error('Invalid dedicated login state; run crawl login again'); }
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('No dedicated login state; run crawl login first');
    throw error;
  }
  if (raw.version !== 1 || !Array.isArray(raw.origins) || !raw.state) throw new Error('Invalid dedicated login state; run crawl login again');
  if (config.auth.origins.some(origin => !raw.origins.includes(origin))) throw new Error('auth.origins changed; run crawl login to authorize the new origin');
  return raw.state;
}
export async function login(cwd, config, launchOptions = {}) {
  if (!config.auth) throw new Error('Add auth.origins to site.yml before running crawl login');
  if (!process.stdin.isTTY) throw new Error('crawl login requires an interactive terminal and a local display');
  const browser = await chromium.launch({ ...launchOptions, headless: false });
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(config.startUrl);
    console.log('Sign in yourself in this dedicated browser. No existing Chrome profile is used.');
    await input.question('After login is complete, press Enter here to save the approved origins locally: ');
    const full = await context.storageState({ indexedDB: true });
    const scoped = config.auth.origins.map(origin => stateForOrigin(full, origin));
    const cookies = [...new Map(scoped.flatMap(state => state.cookies).map(cookie => [`${cookie.domain}\0${cookie.path}\0${cookie.name}`, cookie])).values()];
    const state = { cookies, origins: scoped.flatMap(item => item.origins) };
    const file = join(cwd, '.crawl', 'auth.json');
    await atomicWrite(file, `${JSON.stringify({ version: 1, origins: config.auth.origins, state })}\n`);
    await chmod(file, 0o600);
    console.log('Dedicated login state saved privately in .crawl/auth.json');
  } finally { input.close(); await browser.close(); }
}

import { Configuration, RequestQueue, PlaywrightCrawler, Log, LogLevel } from 'crawlee';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { createPolicy, canonicalUrl, logUrl } from './config.js';
import { stateForOrigin } from './auth.js';

export async function crawl(config, store, { authState = null, launchOptions = {}, onCrawler, logger = event => console.log(JSON.stringify(event)) } = {}) {
  const policy = createPolicy(config);
  // Durable authority is SQLite. Crawlee's in-memory queue handles only this run's scheduling.
  const runtime = new Configuration({ persistStorage: false, purgeOnStart: false });
  const queue = await RequestQueue.open(`run-${randomUUID()}`, { config: runtime });
  const add = async urls => {
    for (const url of urls) {
      const row = store.get(url);
      if (!row || !['pending', 'skipped'].includes(row.status)) continue;
      if (row.status === 'skipped' && !['denied-domain', 'excluded', 'not-included'].includes(row.reason)) continue;
      if (row.status === 'skipped' && row.loadedUrl && policy(row.loadedUrl)) continue;
      const reason = policy(url);
      if (reason) { store.finish(url, 'skipped', reason); await store.writeRecord(store.get(url)); continue; }
      if (row.status === 'skipped') store.reset(url);
      await queue.addRequest({ url, uniqueKey: url, keepUrlFragment: true });
    }
  };
  store.discover(config.startUrl);
  await add(store.unfinished().map(row => row.url));
  const blocked = new Map();
  const crawler = new PlaywrightCrawler({
    requestQueue: queue,
    maxConcurrency: config.maxConcurrency,
    maxRequestRetries: config.maxRetries,
    maxRequestsPerCrawl: config.maxPagesPerRun,
    maxRequestsPerMinute: config.maxRequestsPerMinute,
    useSessionPool: false,
    persistCookiesPerSession: false,
    retryOnBlocked: false,
    log: new Log({ level: LogLevel.OFF }),
    launchContext: { launcher: chromium, useIncognitoPages: true, launchOptions: { headless: true, ...launchOptions } },
    browserPoolOptions: { useFingerprints: false, prePageCreateHooks: [(_id, _controller, options) => {
      options.serviceWorkers = 'block';
      options.acceptDownloads = false;
    }] },
    preNavigationHooks: [async ({ request, page }) => {
      if (store.get(request.url)?.status === 'succeeded') { request.noRetry = true; throw new Error('Page already committed'); }
      const reason = policy(request.url);
      if (reason) { blocked.set(request.url, { reason }); request.noRetry = true; throw new Error('URL is excluded by current policy'); }
      store.start(request.url);
      logger({ event: 'visit', url: logUrl(request.url), attempt: store.get(request.url).attempts });
      const origin = new URL(request.url).origin;
      const authenticated = authState && config.auth?.origins.includes(origin);
      if (authenticated) await page.context().setStorageState(stateForOrigin(authState, origin));
      await page.context().routeWebSocket('**/*', socket => {
        const url = new URL(socket.url());
        url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
        if ((authenticated && url.origin !== origin) || config.denyDomains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) socket.close();
        else socket.connectToServer();
      });
      await page.context().route('**/*', async route => {
        const outgoing = route.request();
        const url = canonicalUrl(outgoing.url());
        const isDocument = outgoing.isNavigationRequest() && outgoing.frame() === page.mainFrame();
        const isPopup = outgoing.isNavigationRequest() && outgoing.frame().page() !== page;
        if (isPopup) { await route.abort('blockedbyclient'); return; }
        let block = !url ? 'unsupported-url' : null;
        if (url && config.denyDomains.some(domain => {
          const host = new URL(url).hostname.replace(/\.$/, '').toLowerCase();
          return host === domain || host.endsWith(`.${domain}`);
        })) block = 'denied-domain';
        if (url && isDocument) block ??= policy(url);
        // Cookies cannot safely be stripped with route.continue. Keep saved-state contexts exact-origin.
        if (url && authenticated && new URL(url).origin !== origin) block ??= 'auth-cross-origin';
        if (block) {
          if (isDocument) {
            blocked.set(request.url, { reason: block, loadedUrl: url });
            request.noRetry = true;
            if (url && block === 'auth-cross-origin' && !policy(url)) { store.discover(url); await add([url]); }
          }
          await route.abort('blockedbyclient');
        } else {
          // Playwright routes do not intercept subsequent HTTP redirect hops.
          // Fetch just one hop and never allow the browser to follow it implicitly.
          try {
            let response = await route.fetch({ maxRedirects: 0 });
            let resourceUrl = url;
            for (let hop = 0; ; hop++) {
              const location = response.headers().location;
              if (response.status() < 300 || response.status() > 399 || !location) break;
              const target = canonicalUrl(location, resourceUrl);
              if (isDocument) {
                const rejection = target ? policy(target) : 'unsupported-url';
                blocked.set(request.url, { reason: rejection ?? 'redirect', loadedUrl: target, httpStatus: response.status(), status: rejection ? 'skipped' : 'redirected' });
                request.noRetry = true;
                if (target) { store.discover(target); await add([target]); }
                await response.dispose(); await route.abort('blockedbyclient'); return;
              }
              // Resource redirects stay on their original origin; document targets get fresh contexts.
              if (!target || new URL(target).origin !== new URL(url).origin || hop >= 9) { await response.dispose(); await route.abort('blockedbyclient'); return; }
              await response.dispose();
              resourceUrl = target;
              response = await route.fetch({ url: target, maxRedirects: 0 });
            }
            await route.fulfill({ response });
            await response.dispose();
          } catch { await route.abort('failed').catch(() => {}); }
        }
      });
    }],
    async requestHandler({ request, page, response }) {
      const loadedUrl = canonicalUrl(page.url());
      const reason = loadedUrl ? policy(loadedUrl) : 'unsupported-url';
      if (reason) { store.finish(request.url, 'skipped', reason, { loadedUrl }); await store.writeRecord(store.get(request.url)); return; }
      const httpStatus = response?.status() ?? null;
      const contentType = (await response?.headerValue('content-type')) ?? '';
      if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(contentType)) {
        store.finish(request.url, 'skipped', 'non-html', { loadedUrl, httpStatus });
        await store.writeRecord(store.get(request.url)); return;
      }
      const html = await page.content();
      const links = [...new Set((await page.locator('a[href], area[href]').evaluateAll(elements => elements.map(element => element.href))).map(value => canonicalUrl(value)).filter(Boolean))];
      await store.savePage(request.url, { loadedUrl, httpStatus, title: await page.title() }, html, links);
      await add(links);
      logger({ event: 'saved', url: logUrl(request.url), path: store.get(request.url).htmlPath, httpStatus });
    },
    async failedRequestHandler({ request }) {
      if (store.get(request.url)?.status === 'succeeded') { await store.writeRecord(store.get(request.url)); return; }
      const rejection = blocked.get(request.url);
      store.finish(request.url, rejection?.status ?? (rejection ? 'skipped' : 'failed'), rejection?.reason ?? 'navigation-or-handler-failed', { loadedUrl: rejection?.loadedUrl, httpStatus: rejection?.httpStatus });
      await store.writeRecord(store.get(request.url));
      logger({ event: rejection ? 'skipped' : 'failed', url: logUrl(request.url), reason: rejection?.reason ?? 'navigation-or-handler-failed' });
    },
  }, runtime);
  onCrawler?.(crawler);
  try { await crawler.run(); } finally { await store.exportManifest(); await queue.drop(); }
  return store.counts();
}

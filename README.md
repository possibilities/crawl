# crawl

A small, resumable CLI that saves rendered HTML for a content-rewrite project. It uses [Crawlee's PlaywrightCrawler](https://crawlee.dev/js/docs/examples/playwright-crawler) and Playwright Chromium. Run it from any working directory containing **one `site.yml` and one start URL**.

No extraction schema, multi-site configuration, scheduler, refresh mode, screenshots, or asset archive. Crawl only content you are authorized to access. Links cross domains by default, so set boundaries before starting a large run.

## Install

Supports macOS/Linux with Node.js **24+** (built-in SQLite) and Chromium's system dependencies.

```sh
git clone https://github.com/possibilities/crawl.git
cd crawl
npm ci
npx playwright install chromium   # Linux: add --with-deps if needed
npm link
```

Then create a separate working directory:

```sh
mkdir ~/my-content-crawl
cd ~/my-content-crawl
# Create site.yml using the example below
crawl
```

The executable is also available as `node /path/to/crawl/bin/crawl.js`; no npm publication is needed. `CRAWL_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium` optionally selects an already installed Chromium.

## Configuration

```yaml
startUrl: https://example.com/
include: []
exclude:
  - /logout
  - /signout
denyDomains:
  - blocked.example
maxConcurrency: 3
maxRetries: 2
maxPagesPerRun: 1000
maxRequestsPerMinute: 120
```

- Empty `include` follows every discovered HTTP(S) anchor/area link, across domains
- Globs beginning with `/` match the case-sensitive pathname only. Other globs match the entire URL, including query and fragment. [Picomatch](https://github.com/micromatch/picomatch) syntax applies; quote patterns in YAML
- For example, `include: ['https://example.com/**', 'https://docs.example.com/**']` limits the crawl to two origins; `exclude: ['/admin/**']` rejects those paths on every origin
- `denyDomains` accepts bare hostnames. Each denies itself and all subdomains, regardless of scheme/port. Domain deny and exclude rules always beat include rules
- Domain denies apply to browser resources as well as pages. Path/include rules select top-level pages, not their scripts or styles
- `maxPagesPerRun` bounds requests handled in one invocation; concurrent work may slightly overshoot. Run `crawl` again to continue the queue. `maxRetries` is additional retries per request; exhausted failures remain recorded and are not silently retried on the next run
- Unknown keys and duplicate YAML keys are errors. One working directory is permanently bound to its canonical start URL; use a fresh directory for another crawl

## Output and resume

```text
site.yml
.crawl/
  crawl.sqlite             durable URL queue and authoritative metadata
  auth.json                optional private dedicated login state
crawl-output/
  manifest.json            schema, counts, snapshot timestamp and paths
  manifest.jsonl           one JSON object per discovered URL
  records/<url-sha256>.json
  pages/<url-sha256>.html
```

Each record includes original URL, final/redirect URL, status, discovery/start/finish timestamps, attempt count, HTTP status when available, page title, HTML path/hash, and discovered links. Follow a record's `htmlPath` for content, or its `links` and `loadedUrl` to continue traversing. Non-HTML responses have metadata only.

`manifest.jsonl` is an atomic startup/shutdown snapshot. Individual records update during a run, so agents can inspect finished pages without waiting for the run to end. The SQLite database is the source of truth; an abrupt crash can leave derived JSON temporarily stale until the next startup repairs it. A manifest snapshot never pretends to be a complete live index.

`Ctrl-C` or `SIGTERM` stops after active pages finish and exports the manifest. Restart with the same command. A hard crash may require 10 seconds for the stale directory lock to expire. Interrupted requests return to the durable queue; committed pages are never fetched again. Every pending/excluded URL is checked against the new configuration on resume. A previously excluded URL can become eligible after widening your rules; saved successes, non-HTML skips, and exhausted failures are terminal. There is deliberately no refresh/recrawl command.

HTML is written and fsynced via atomic rename **before** the SQLite transaction commits its page metadata and discovered children. SQLite uses WAL + `synchronous=FULL`; retries are guarded against already committed pages. Restart repairs JSON records and removes uncommitted HTML/temp files. Missing/corrupt committed HTML fails closed and requires restoring a backup, rather than fetching silently. These guarantees assume a reliable local filesystem; do not place the working directory on a shared/network filesystem or run multiple machines against it. Back up `.crawl` and `crawl-output` together while stopped.

The CLI refuses symlinked managed paths and nonempty directories it does not own. It uses a per-directory lock to prevent overlapping runs/login sessions. Generated state/output directories are private on POSIX and contain their own `.gitignore`. Git ignore is a guardrail, not encryption: never publish a working directory, auth file, manifest, private URL, or captured company content without reviewing it.

## URL and redirect semantics

- URL identity uses the browser's standard WHATWG URL serialization: host case/default ports and navigational dot segments normalize naturally
- Query order, repeated parameters, tracking parameters, percent encoding, path case, trailing slash, and **fragments are retained**. This preserves hash-routed applications; different ordinary `#anchors` may therefore produce separate snapshots of the same document
- Embedded username/password URLs and non-HTTP(S) links are rejected. Files are named by full SHA-256 of that identity, with one durable row per identity
- HTTP redirects are recorded as `redirected` with their target in `loadedUrl`; permitted targets become independent queued requests. This avoids duplicate snapshots for aliases and ensures **every redirect target gets a fresh policy/auth check before network access**. Denied redirect targets remain skipped
- JavaScript navigation is checked before loading. Popups are blocked. Resource redirects can follow up to 10 same-origin hops; cross-origin resource redirects are blocked

Crawlee uses its normal navigation/readiness behavior, as in the official example. There is **no custom body wait, network-idle wait, scroll, click, or settle delay**. HTML comes from `page.content()` in the request handler. JavaScript that finishes after normal navigation readiness may not be represented. Scripts/styles/images may load as needed to render a page; only DOM HTML and metadata are saved.

For policy enforcement, request interception fetches one HTTP hop at a time and prevents implicit redirects. Service workers are blocked so they cannot bypass those checks. This affects caching, buffers response bodies, and can affect sites relying on service workers or cross-origin resource redirects. It does not add a new page-ready heuristic.

## Optional local login

Use only a **dedicated browser state you establish yourself**. The tool never reads your existing Chrome profile or imports its cookies.

```yaml
startUrl: https://company.example/
auth:
  origins:
    - https://company.example
```

On your own machine with a display:

```sh
crawl login
# Sign in yourself in the new browser window, then press Enter in the terminal
crawl
```

`crawl login` uses a fresh browser context. It saves cookies and origin storage (including IndexedDB where supported) only for your explicitly listed origins in `.crawl/auth.json`, with private file permissions. No password prompt exists in the CLI. Browser state stays local and is never printed or uploaded. Session storage is not persisted; some sites may require a new login. Rerun `crawl login` to replace expired state.

Each crawl page gets an isolated incognito context. Saved cookies are narrowed to the requested hostname, origin storage is exact-origin, and **authenticated contexts can request only their own exact origin, including scheme and port**. Cross-origin pages still enter the queue and receive their own context without another origin's credentials. Popups and off-origin WebSockets/resources are blocked. Sites requiring cross-origin authenticated APIs or CDN assets may render incompletely; this is a deliberate fail-closed boundary. Do not loosen it by exporting a general-purpose browser profile.

This is scoped browser-state reuse for trusted, authorized sites, not a malicious-page sandbox. Site code can place private values in HTML or links; review crawl boundaries and outputs.

Adding an `auth.origins` entry requires establishing login state again. Saved state is not expanded automatically. URL logs redact fragments and likely credential parameter names; arbitrary secrets can still appear in page URLs/content, so treat all outputs and logs as private.

## Development

```sh
npm ci
npx playwright install --with-deps chromium
npm run verify
npm pack --dry-run
```

Tests use owned local HTTP fixtures only. Coverage includes JS-rendered HTML, cross-domain traversal, URL identity, exclusion precedence, current-config resume, asset rejection, real process interruption, transaction/output recovery, scoped authentication, redirect/popup/WebSocket leakage, and filesystem ownership. CI runs the same checks on Node 24 with Playwright's matching Chromium. No company site is contacted by the test suite.

Exit codes: `0` finished/budget reached, `1` configuration/runtime problem, `2` one or more permanently failed records, `130` graceful interruption. Structured visit/save/failure logs go to stdout; errors go to stderr. A subsequent invocation does not reset historical failures.

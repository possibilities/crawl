import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { crawl } from '../src/crawler.js';
const launchOptions = process.env.CRAWL_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CRAWL_CHROMIUM_EXECUTABLE } : {};
async function fixture(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'crawl-browser-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { origin, dir };
}
const html = (res, body) => { res.setHeader('Content-Type', 'text/html'); res.end(body); };
const run = (config, store, extra = {}) => crawl(config, store, { launchOptions, logger() {}, ...extra });
test('renders JS, follows external links, keeps identities, rejects assets and resumes without refetch', async t => {
  const hits = [];
  const external = await fixture(t, (req,res) => { hits.push('external' + req.url); html(res, '<h1>external</h1>'); });
  const local = await fixture(t, (req,res) => {
    hits.push(req.url);
    if (req.url === '/') html(res, `<title>root</title><div id="app"></div><script>document.getElementById('app').innerHTML='<h1>Rendered JavaScript</h1>'</script><a href="/a?x=1&y=2">one</a><a href="/a?y=2&x=1">two</a><a href="/a?x=1&y=2">duplicate</a><a href="${external.origin}/cross">cross</a><a href="/asset.svg">asset</a><a href="/private/no">denied</a>`);
    else if (req.url === '/asset.svg') { res.setHeader('Content-Type','image/svg+xml'); res.end('<svg/>'); }
    else html(res, '<h1>child</h1>');
  });
  const config = validateConfig({ startUrl: local.origin + '/', exclude: ['/private/**'], maxRequestsPerMinute: 60000 });
  let store = await Store.open(local.dir, config.startUrl);
  const counts = await run(config, store);
  assert.equal(counts.succeeded, 4); assert.equal(counts.skipped, 2);
  const root = store.get(config.startUrl);
  assert.match(await readFile(join(local.dir,'crawl-output',root.htmlPath),'utf8'), /<h1>Rendered JavaScript<\/h1>/);
  assert.equal(hits.includes('/private/no'), false);
  assert.ok(hits.includes('external/cross'));
  const before = hits.length; store.close(); store = await Store.open(local.dir, config.startUrl);
  await run(config, store); assert.equal(hits.length, before);
  store.close();
});
test('current policy applies to durable pending jobs and blocked redirect destinations before network', async t => {
  let privateHits = 0;
  const { origin, dir } = await fixture(t, (req,res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/private' }); res.end(); }
    else { if (req.url === '/private') privateHits++; html(res, '<h1>ok</h1>'); }
  });
  const config = validateConfig({ startUrl: origin + '/', exclude: ['/private'], maxRequestsPerMinute: 60000 });
  const store = await Store.open(dir, config.startUrl);
  store.discover(origin + '/private'); store.discover(origin + '/redirect');
  await run(config, store);
  assert.equal(privateHits, 0); assert.equal(store.get(origin + '/private').status, 'skipped');
  assert.equal(store.get(origin + '/redirect').reason, 'excluded');
  await run(config, store); assert.equal(privateHits, 0);
  const widened = validateConfig({ startUrl: config.startUrl, maxRequestsPerMinute: 60000 });
  await run(widened, store); assert.equal(store.get(origin + '/private').status, 'succeeded'); store.close();
});
test('saved auth works only on an exact origin and cannot leak across ports or redirects', async t => {
  let foreignCookie = null, authSeen = false, crossRequests = 0;
  const foreign = await fixture(t, (req,res) => { foreignCookie = req.headers.cookie ?? ''; crossRequests++; html(res, 'foreign'); });
  const local = await fixture(t, (req,res) => {
    authSeen ||= req.headers.cookie?.includes('session=private') ?? false;
    if (req.url === '/') html(res, `<script src="${foreign.origin}/script.js"></script><a href="${foreign.origin}/page">cross</a><a href="/redirect">redirect</a>`);
    else { res.writeHead(302, { location: foreign.origin + '/redirect-target' }); res.end(); }
  });
  const config = validateConfig({ startUrl: local.origin + '/', auth: { origins: [local.origin] }, maxRequestsPerMinute: 60000 });
  const store = await Store.open(local.dir, config.startUrl);
  await run(config, store, { authState: { cookies: [{ name:'session', value:'private', domain:'127.0.0.1', path:'/', expires:-1, httpOnly:true, secure:false, sameSite:'Lax' }], origins:[] } });
  assert.equal(authSeen, true); assert.equal(foreignCookie, ''); assert.equal(crossRequests, 2);
  assert.equal(store.get(local.origin + '/redirect').status, 'redirected'); store.close();
});
test('real SIGKILL leaves a resumable queue without duplicate committed records', async t => {
  let slow = true, began;
  const started = new Promise(resolve => began = resolve);
  const { origin, dir } = await fixture(t, (req,res) => {
    if (req.url === '/') html(res, '<a href="/slow">next</a>');
    else if (slow) { began(); /* Leave navigation in flight. */ }
    else html(res, '<h1>finished</h1>');
  });
  await writeFile(join(dir,'site.yml'), `startUrl: ${origin}/\nmaxConcurrency: 1\nmaxRequestsPerMinute: 60000\n`);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/crawl.js', import.meta.url))], { cwd:dir, env:process.env, stdio:['ignore','pipe','pipe'] });
  let output=''; child.stdout.on('data',x=>output+=x); child.stderr.on('data',x=>output+=x);
  await Promise.race([started, new Promise((_,reject)=>setTimeout(()=>reject(new Error(output || 'child did not navigate')),20000).unref())]);
  child.kill('SIGKILL'); await once(child,'exit'); slow=false;
  // Store recovery is independent of the CLI's 10-second stale-lock wait.
  const config = validateConfig({ startUrl:origin+'/', maxRequestsPerMinute:60000 });
  const store = await Store.open(dir, config.startUrl);
  assert.equal(store.get(origin+'/').status,'succeeded');
  assert.equal(store.get(origin+'/slow').status,'pending');
  await run(config,store);
  assert.equal(store.counts().succeeded,2);
  const rows=(await readFile(join(dir,'crawl-output/manifest.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(new Set(rows.map(row=>row.id)).size,2); store.close();
});
test('fragment-specific include policy preserves a hash-routed start URL', async t => {
  const { origin, dir } = await fixture(t, (_req,res) => html(res, '<div id="route"></div><script>document.getElementById("route").textContent=location.hash</script>'));
  const startUrl = origin + '/#/account';
  const config = validateConfig({ startUrl, include: [origin + '/#/account'], maxRequestsPerMinute:60000 });
  const store = await Store.open(dir,startUrl);
  await run(config,store);
  assert.equal(store.get(startUrl).status,'succeeded');
  assert.match(await readFile(join(dir,'crawl-output',store.get(startUrl).htmlPath),'utf8'), /<div id="route">#\/account<\/div>/);
  store.close();
});
test('graceful SIGINT finishes active work, releases the lock, and resumes pending pages', async t => {
  let activeResponse, activeStarted;
  const started = new Promise(resolve => activeStarted = resolve);
  let rootHits = 0;
  const { origin, dir } = await fixture(t, (req,res) => {
    if (req.url === '/') { rootHits++; html(res, '<a href="/active">active</a><a href="/pending">pending</a>'); }
    else if (req.url === '/active') { activeResponse=res; activeStarted(); }
    else html(res, '<title>pending finished</title>');
  });
  await writeFile(join(dir,'site.yml'), `startUrl: ${origin}/\nmaxConcurrency: 1\nmaxRequestsPerMinute: 60000\n`);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/crawl.js', import.meta.url))], { cwd:dir, env:process.env, stdio:['ignore','pipe','pipe'] });
  let output='', sawStop;
  const stopping = new Promise(resolve => sawStop=resolve);
  child.stdout.on('data',x=>{ output+=x; if(output.includes('Stopping after')) sawStop(); });
  child.stderr.on('data',x=>output+=x);
  t.after(()=>child.kill('SIGKILL'));
  await Promise.race([started, new Promise((_,reject)=>setTimeout(()=>reject(new Error(output || 'child did not start active page')),20000).unref())]);
  child.kill('SIGINT');
  await Promise.race([stopping, new Promise((_,reject)=>setTimeout(()=>reject(new Error(output || 'child did not handle SIGINT')),5000).unref())]);
  const exited = once(child,'exit'); html(activeResponse,'<title>active finished</title>');
  const [code] = await exited;
  assert.equal(code,130,output);
  const second=spawn(process.execPath,[fileURLToPath(new URL('../bin/crawl.js', import.meta.url))],{cwd:dir,env:process.env,stdio:['ignore','pipe','pipe']});
  let secondOutput=''; second.stdout.on('data',x=>secondOutput+=x); second.stderr.on('data',x=>secondOutput+=x);
  const [resumedCode]=await once(second,'exit'); assert.equal(resumedCode,0,secondOutput);
  assert.equal(rootHits,1);
  const rows=(await readFile(join(dir,'crawl-output/manifest.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row=>row.status==='succeeded').length,3);
});
test('exhausted HTTP failures stay terminal on resume and respect retry bounds', async t => {
  let failures = 0;
  const {origin,dir}=await fixture(t,(_req,res)=>{ failures++; res.statusCode=503; html(res,'<h1>unavailable</h1>'); });
  const config=validateConfig({startUrl:origin+'/',maxRetries:1,maxRequestsPerMinute:60000});
  let store=await Store.open(dir,config.startUrl); await run(config,store);
  assert.equal(store.get(config.startUrl).status,'failed'); assert.equal(failures,2); store.close();
  store=await Store.open(dir,config.startUrl); await run(config,store); assert.equal(failures,2); store.close();
});

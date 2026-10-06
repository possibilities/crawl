import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import picomatch from 'picomatch';

export function canonicalUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // Keep query order, encoding, trailing slash, and fragments (including SPA routes).
    return url.href;
  } catch { return null; }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
}
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} option: ${key}`);
}
function strings(value, label) {
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !x)) throw new Error(`${label} must be an array of nonempty strings`);
  return value;
}
function integer(value, fallback, max, label) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${label} must be an integer from 1 to ${max}`);
  return n;
}
export function validateConfig(input) {
  keys(input, ['startUrl', 'include', 'exclude', 'denyDomains', 'maxConcurrency', 'maxRetries', 'maxPagesPerRun', 'maxRequestsPerMinute', 'auth'], 'site');
  const startUrl = typeof input.startUrl === 'string' && canonicalUrl(input.startUrl);
  if (!startUrl) throw new Error('startUrl must be one HTTP(S) URL without embedded credentials');
  const include = strings(input.include ?? [], 'include');
  const exclude = strings(input.exclude ?? [], 'exclude');
  const denyDomains = strings(input.denyDomains ?? [], 'denyDomains').map(domain => {
    if (/[/:?#@*\s]/.test(domain) || !domain || domain.startsWith('.')) throw new Error('denyDomains entries must be bare hostnames');
    const normalized = new URL(`https://${domain}`).hostname.toLowerCase().replace(/\.$/, '');
    if (!normalized) throw new Error('Invalid denyDomains entry');
    return normalized;
  });
  let auth = null;
  if (input.auth !== undefined) {
    keys(input.auth, ['origins'], 'auth');
    const origins = strings(input.auth.origins, 'auth.origins').map(origin => {
      const url = canonicalUrl(origin);
      if (!url || new URL(url).origin !== origin) throw new Error('auth.origins must contain exact origins, such as https://example.com (no trailing slash)');
      return origin;
    });
    if (!origins.length) throw new Error('auth.origins must not be empty');
    auth = { origins: [...new Set(origins)] };
  }
  if (input.maxRetries !== undefined && (!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 10)) throw new Error('maxRetries must be an integer from 0 to 10');
  return {
    startUrl, include, exclude, denyDomains, auth,
    maxConcurrency: integer(input.maxConcurrency, 3, 32, 'maxConcurrency'),
    maxRetries: input.maxRetries ?? 2,
    maxPagesPerRun: integer(input.maxPagesPerRun, 1000, 1000000, 'maxPagesPerRun'),
    maxRequestsPerMinute: integer(input.maxRequestsPerMinute, 120, 60000, 'maxRequestsPerMinute'),
  };
}
export async function loadConfig(cwd) {
  const raw = await readFile(resolve(cwd, 'site.yml'), 'utf8');
  const doc = parseDocument(raw, { uniqueKeys: true });
  if (doc.errors.length) throw new Error('site.yml contains invalid YAML or duplicate keys');
  return validateConfig(doc.toJS({ maxAliasCount: 20 }));
}
export function createPolicy(config) {
  const compile = patterns => patterns.map(pattern => ({ path: pattern.startsWith('/'), match: picomatch(pattern, { dot: true, nonegate: true }) }));
  const include = compile(config.include), exclude = compile(config.exclude);
  return input => {
    const canonical = canonicalUrl(input);
    if (!canonical) return 'unsupported-url';
    const url = new URL(canonical);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (config.denyDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) return 'denied-domain';
    const matches = rules => rules.some(rule => rule.match(rule.path ? url.pathname : canonical));
    if (matches(exclude)) return 'excluded';
    if (include.length && !matches(include)) return 'not-included';
    return null;
  };
}
export function logUrl(input) {
  const url = new URL(input);
  if (url.hash) url.hash = '[redacted]';
  // Logging never changes request identity. Treat saved output as private regardless.
  for (const key of url.searchParams.keys()) if (/token|secret|password|auth|key|code|session/i.test(key)) url.searchParams.set(key, '[redacted]');
  return url.href;
}

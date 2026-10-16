// Static demo mode (homebase.nevryk.com): the UI reads sample-data JSON exported by
// scripts/export-static-demo.mjs instead of talking to a backend. Production builds never set the flag.
export const STATIC_DEMO = import.meta.env?.VITE_STATIC_DEMO === '1';

/** File name for an API path; the exporter and the browser must agree. live=1 only marks interest, so it is dropped. */
export function staticKey(path) {
  const url = new URL(path, 'http://demo.invalid');
  url.searchParams.delete('live');
  const query = [...url.searchParams].sort().map(([k, v]) => `${k}-${v}`).join('_');
  return url.pathname.replace(/^\/api\//, '').replace(/[^a-zA-Z0-9.-]+/g, '_') + (query ? `__${query.replace(/[^a-zA-Z0-9._-]+/g, '_')}` : '') + '.json';
}

const DAY = 86_400_000;
/** Move every epoch-millisecond timestamp forward by the time since export, so the sample data always reads as fresh. */
export function shiftTimes(value, exportedAt, now = Date.now()) {
  const delta = now - exportedAt, lo = exportedAt - 400 * DAY, hi = exportedAt + DAY;
  const walk = v => typeof v === 'number' ? (v > lo && v < hi ? v + delta : v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(value);
}

let manifest;
async function load(path) {
  manifest ||= fetch('/demo-api/manifest.json').then(r => r.json());
  const { exportedAt } = await manifest;
  const response = await fetch(`/demo-api/${staticKey(path)}`);
  if (!response.ok) { const error = new Error('This view is not part of the live demo.'); error.status = response.status; throw error; }
  return shiftTimes(await response.json(), exportedAt);
}

/** Answers the same requests the backend would, from the exported files. Writes are accepted and ignored. */
export async function staticRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase(), pathname = new URL(path, 'http://demo.invalid').pathname;
  if (method !== 'GET') return pathname === '/api/refresh' ? load('/api/snapshot') : { ok: true };
  return load(path);
}

export async function staticRefresh(id) {
  const [snapshot, integrations, live] = await Promise.all([load('/api/snapshot'), id === 'proxy' ? load('/api/integrations') : null, id === 'compute' ? load('/api/compute') : null]);
  await new Promise(r => setTimeout(r, 900));
  return { source: id, status: 'updated', observedAt: Date.now(), snapshot, ...(integrations ? { integrations } : {}), ...(live ? { live } : {}) };
}

/** Link props for opening a private app. The live demo has no backend, so app links are inert there. */
export function appLink(id) {
  if (STATIC_DEMO) return { href: '#', onClick: e => e.preventDefault(), title: 'App links are off in the live demo', 'aria-disabled': 'true' };
  return { href: `/api/apps/${id}/open`, target: '_blank', rel: 'noopener noreferrer' };
}

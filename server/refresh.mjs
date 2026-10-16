// On-demand refresh. Only sources that already exist can be refreshed:
// server-side readers call their fixed code path, and collector scopes are
// handed to the authenticated bridge, which maps each scope to its own fixed
// collector. Nothing here accepts a command, host, path, or argument.
export const DEFAULT_MIN_INTERVAL_MS = 10_000;
export const COLLECTOR_WAIT_MS = 25_000;
export const LIVE = { compute: { intervalMs: 3000, ttlMs: 12_000 } };
const LISTENING_MS = 90_000;
// Provider usage APIs are polled for every account; keep those gentler.
const MIN_INTERVAL = { proxy: 30_000, quotas: 30_000 };
const PASSIVE = {
  'claude-statusline': 'Claude status-line readings arrive only when Claude Code renders its status line after a real response. They cannot be requested.',
};
export const SOURCE_ID = /^(?:[a-z][a-z-]{1,30}|guest:\d{1,9})$/;

export class RefreshCoordinator {
  constructor({ config, store, monitor, integrations, now = () => Date.now() }) {
    Object.assign(this, { config, store, monitor, integrations, now });
    this.last = new Map(); this.inflight = new Map(); this.pending = new Set();
    this.waiters = new Set(); this.watchers = new Set(); this.seen = new Map(); this.liveUntil = new Map();
  }
  collectorsFor(scope) { return Object.entries(this.config.collectors || {}).filter(([, c]) => Array.isArray(c.scopes) && c.scopes.includes(scope)).map(([name]) => name); }
  listening(scope) { return this.collectorsFor(scope).some(name => this.now() - (this.seen.get(name) || 0) < LISTENING_MS); }
  capability(id) {
    const base = { id, minIntervalMs: MIN_INTERVAL[id] || DEFAULT_MIN_INTERVAL_MS, lastRequestedAt: this.last.get(id) || null };
    const no = reason => ({ ...base, available: false, reason });
    if (PASSIVE[id]) return no(PASSIVE[id]);
    if (id === 'proxmox') return this.config.proxmox?.node ? { ...base, available: true, reason: 'Re-reads the Proxmox API now.' } : no('Proxmox monitoring is not configured.');
    if (id === 'proxy') return this.config.proxy && this.config.proxy.refresh !== false ? { ...base, available: true, reason: 'Asks CLI Proxy to poll each account’s usage now.' } : no('CLI Proxy is not configured.');
    if (!SOURCE_ID.test(id) || !this.collectorsFor(id).length) return no(id === 'nas' ? 'TrueNAS is not connected, so there is nothing to re-collect.' : 'This reading has no collector that can be asked for a new measurement.');
    if (!this.listening(id)) return no('The telemetry bridge sends this reading on its own schedule but is not accepting on-demand requests. Update the bridge to enable refresh.');
    return { ...base, available: true, reason: id === 'quotas' ? 'Re-reads Codex quota now. Claude status-line readings stay passive.' : 'Asks the telemetry bridge to collect this reading now.' };
  }
  capabilities() {
    const ids = new Set(['proxmox', 'proxy', 'nas', ...Object.keys(PASSIVE), ...Object.values(this.config.collectors || {}).flatMap(c => c.scopes || [])]);
    return Object.fromEntries([...ids].map(id => [id, this.capability(id)]));
  }
  request(id) {
    const cap = this.capability(id);
    if (!cap.available) return Promise.resolve({ source: id, status: 'unavailable', reason: cap.reason });
    if (this.inflight.has(id)) return this.inflight.get(id);
    const retry = (this.last.get(id) || -Infinity) + cap.minIntervalMs - this.now();
    if (retry > 0) return Promise.resolve({ source: id, status: 'throttled', retryAfterMs: retry, reason: `Refreshed moments ago. Try again in ${Math.ceil(retry / 1000)}s.` });
    this.last.set(id, this.now());
    const run = this.run(id).catch(() => ({ status: 'failed', reason: 'The source could not be refreshed. Last readings are retained.' }))
      .then(result => ({ source: id, ...result })).finally(() => this.inflight.delete(id));
    this.inflight.set(id, run);
    return run;
  }
  async run(id) {
    if (id === 'proxmox') {
      await this.monitor.poll({ force: true });
      const source = this.monitor.snapshot().sources.find(s => s.id === 'proxmox');
      return source?.status === 'connected' ? { status: 'updated', observedAt: source.observedAt } : { status: 'failed', reason: source?.message || 'Proxmox did not respond.' };
    }
    if (id === 'proxy') {
      const proxy = await this.integrations.refreshProxy();
      return proxy.status === 'connected' ? { status: 'updated', observedAt: proxy.observedAt } : { status: 'failed', reason: 'CLI Proxy could not refresh its usage readings. Last readings are retained.' };
    }
    const arrived = this.awaitIngest(id, COLLECTOR_WAIT_MS);
    this.pending.add(id); this.wake();
    const observedAt = await arrived;
    return observedAt ? { status: 'updated', observedAt } : { status: 'pending', reason: 'The bridge has not reported back yet. The reading will appear when it arrives.' };
  }
  awaitIngest(scope, timeout) {
    return new Promise(resolve => {
      const watcher = { scope, resolve: observed => { clearTimeout(watcher.timer); this.watchers.delete(watcher); resolve(observed); } };
      watcher.timer = setTimeout(() => watcher.resolve(null), timeout);
      this.watchers.add(watcher);
    });
  }
  ingested(scope, observedAt) { for (const w of [...this.watchers]) if (w.scope === scope) w.resolve(observedAt); }
  isLive(scope) { return (this.liveUntil.get(scope) || 0) > this.now(); }
  /** A visible live panel asks for faster collection; it expires on its own. */
  markLive(scope) {
    if (!LIVE[scope] || !this.collectorsFor(scope).length) return false;
    const was = this.isLive(scope);
    this.liveUntil.set(scope, this.now() + LIVE[scope].ttlMs);
    if (!was) { this.pending.add(scope); this.wake(); }
    return true;
  }
  wake() { for (const w of [...this.waiters]) w(); }
  /** Long-poll for an authenticated collector; returns only scopes it may collect. */
  async next(name, scopes, waitMs = COLLECTOR_WAIT_MS) {
    this.seen.set(name, this.now());
    const take = () => { const list = [...this.pending].filter(s => scopes.includes(s)); for (const s of list) this.pending.delete(s); return list; };
    let refresh = take();
    if (!refresh.length) {
      const limit = Math.max(0, Math.min(waitMs, COLLECTOR_WAIT_MS, scopes.some(s => this.isLive(s)) ? 5000 : Infinity));
      await new Promise(resolve => {
        let timer;
        const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
        timer = setTimeout(done, limit); this.waiters.add(done);
      });
      refresh = take();
    }
    this.seen.set(name, this.now());
    return { refresh, live: Object.fromEntries(scopes.filter(s => LIVE[s] && this.isLive(s)).map(s => [s, LIVE[s]])) };
  }
  close() { this.wake(); for (const w of [...this.watchers]) w.resolve(null); }
}

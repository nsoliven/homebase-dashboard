import { summarize } from './statistics.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS feeds(id TEXT PRIMARY KEY, observed INTEGER NOT NULL, received INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(ts INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, expires INTEGER NOT NULL, user TEXT NOT NULL, csrf TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logins(id TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS acknowledgements(id TEXT PRIMARY KEY, signature TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metric_ids(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS metric_raw(metric INTEGER NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY(metric, ts)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS metric_buckets(metric INTEGER NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL, sum REAL NOT NULL,
        min REAL NOT NULL, max REAL NOT NULL, min_ts INTEGER NOT NULL, max_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, samples TEXT NOT NULL,
        PRIMARY KEY(metric, bucket)) WITHOUT ROWID;`);
    this.metricIds = new Map(this.db.prepare('SELECT id,name FROM metric_ids').all().map(r => [r.name, r.id]));
    this.metricsPrunedAt = 0;
  }
  metricId(name, create = false) {
    if (!this.metricIds.has(name) && create) this.metricIds.set(name, Number(this.db.prepare('INSERT INTO metric_ids(name) VALUES(?)').run(name).lastInsertRowid));
    return this.metricIds.get(name) ?? null;
  }
  hasMetric(name) { return this.metricIds.has(name); }
  /** 30-second samples go to the raw tier and are folded into 5-minute buckets.
   * A timestamp is recorded once per metric, so buckets never double-count. */
  recordMetrics(values, ts = Date.now()) {
    const raw = this.db.prepare('INSERT OR IGNORE INTO metric_raw VALUES(?,?,?)');
    const bucket = this.db.prepare(`INSERT INTO metric_buckets VALUES(?,?,1,?,?,?,?,?,?,?) ON CONFLICT(metric,bucket) DO UPDATE SET
      count=count+1, sum=sum+excluded.sum, min_ts=CASE WHEN excluded.min<min THEN excluded.min_ts ELSE min_ts END,
      max_ts=CASE WHEN excluded.max>max THEN excluded.max_ts ELSE max_ts END, min=MIN(min,excluded.min), max=MAX(max,excluded.max),
      last_ts=MAX(last_ts,excluded.last_ts), samples=samples||','||excluded.samples`);
    this.db.exec('BEGIN');
    try {
      for (const [name, value] of Object.entries(values)) {
        if (!Number.isFinite(value)) continue;
        const id = this.metricId(name, true), v = Math.round(value * 1000) / 1000;
        if (ts >= Date.now() - 25 * 3600_000 && !raw.run(id, ts, v).changes) continue;
        bucket.run(id, Math.floor(ts / 300_000) * 300_000, v, v, v, ts, ts, ts, String(v));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  metricRaw(name, from, to) {
    const id = this.metricId(name);
    return id === null ? [] : this.db.prepare('SELECT ts,value FROM metric_raw WHERE metric=? AND ts>? AND ts<=? ORDER BY ts').all(id, from, to);
  }
  metricBuckets(name, from, to) {
    const id = this.metricId(name);
    return id === null ? [] : this.db.prepare('SELECT bucket,count,sum,min,max,min_ts,max_ts,last_ts,samples FROM metric_buckets WHERE metric=? AND bucket>=? AND bucket<=? ORDER BY bucket').all(id, from, to)
      .map(b => ({ bucket: b.bucket, count: b.count, sum: b.sum, min: b.min, max: b.max, minTs: b.min_ts, maxTs: b.max_ts, lastTs: b.last_ts, samples: b.samples.split(',').map(Number) }));
  }
  pruneMetrics(now = Date.now(), force = false) {
    if (!force && now - this.metricsPrunedAt < 600_000) return;
    this.metricsPrunedAt = now;
    this.db.prepare('DELETE FROM metric_raw WHERE ts<?').run(now - 25 * 3600_000);
    this.db.prepare('DELETE FROM metric_buckets WHERE bucket<?').run(now - 8 * 86400_000);
  }
  /** One-time import of matching keys already in `history` (real 30-second samples). */
  backfillMetrics(map, now = Date.now()) {
    if (this.db.prepare("SELECT 1 FROM meta WHERE key='metrics.backfill'").get()) return 0;
    let rows = 0;
    for (const row of this.recent(now - 7 * 86400_000)) {
      const values = {};
      for (const [id, keys] of Object.entries(map)) { const key = keys.find(k => Number.isFinite(row.values[k])); if (key) values[id] = row.values[key]; }
      if (Object.keys(values).length) { this.recordMetrics(values, row.ts); rows++; }
    }
    this.db.prepare("INSERT OR REPLACE INTO meta VALUES('metrics.backfill',?)").run(String(now));
    return rows;
  }
  feed(id, data, observed = Date.now()) {
    this.db.prepare('INSERT OR REPLACE INTO feeds VALUES(?,?,?,?)').run(id, observed, Date.now(), JSON.stringify(data));
  }
  getFeed(id, ttl = 120_000) {
    const row = this.db.prepare('SELECT * FROM feeds WHERE id=?').get(id);
    return row ? { ...row, data: JSON.parse(row.data), stale: Date.now() - row.observed > ttl } : null;
  }
  history(data, now = Date.now()) {
    this.db.prepare('INSERT OR REPLACE INTO history VALUES(?,?)').run(now, JSON.stringify(data));
  }
  series(range = '24h', now = Date.now()) {
    const duration = { '1h': 3600_000, '24h': 86400_000, '7d': 604800_000 }[range];
    if (!duration) throw new Error('Invalid range');
    const rows = this.db.prepare('SELECT ts,data FROM history WHERE ts>? ORDER BY ts').all(now - duration);
    const buckets = new Map(), samples = new Map(), bounds = new Map(), step = duration / 240;
    for (const row of rows) {
      const bucket = Math.floor((row.ts - (now - duration)) / step);
      if (!buckets.has(bucket)) buckets.set(bucket, { ts: row.ts, totals: {}, counts: {} });
      const b = buckets.get(bucket);
      for (const [key, value] of Object.entries(JSON.parse(row.data))) {
        if (Number.isFinite(value)) { if (!samples.has(key)) samples.set(key, []); samples.get(key).push(value); bounds.set(key,{from:bounds.get(key)?.from??row.ts,to:row.ts}); b.totals[key] = (b.totals[key] || 0) + value; b.counts[key] = (b.counts[key] || 0) + 1; }
      }
    }
    const keys = new Set(rows.flatMap(r => Object.keys(JSON.parse(r.data))));
    const points = [];
    let previous;
    for (const b of buckets.values()) {
      if (previous && b.ts - previous > Math.max(step * 2, 120_000)) points.push({ ts: previous + step, values: Object.fromEntries([...keys].map(k => [k, null])) });
      points.push({ ts: b.ts, values: Object.fromEntries([...keys].map(k => [k, b.counts[k] ? b.totals[k] / b.counts[k] : null])) });
      previous = b.ts;
    }
    return { range, from: now - duration, to: now, points, statistics: Object.fromEntries([...samples].map(([key,values])=>[key,{...summarize(values),...bounds.get(key)}])) };
  }
  recent(since) {
    return this.db.prepare('SELECT ts,data FROM history WHERE ts>? ORDER BY ts').all(since).map(r => ({ ts: r.ts, values: JSON.parse(r.data) }));
  }
  session(user) {
    const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token), Date.now() + 12 * 3600_000, JSON.stringify(user), csrf);
    return { token, csrf, user };
  }
  getSession(token) {
    if (!token || token.length > 100) return null;
    const r = this.db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(token), Date.now());
    return r ? { ...r, user: JSON.parse(r.user) } : null;
  }
  logout(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE id=?').run(hash(token)); }
  login(id, data) { this.db.prepare('INSERT INTO logins VALUES(?,?,?)').run(hash(id), Date.now() + 600_000, JSON.stringify(data)); }
  consumeLogin(id) {
    const r = this.db.prepare('SELECT * FROM logins WHERE id=? AND expires>?').get(hash(id), Date.now());
    this.db.prepare('DELETE FROM logins WHERE id=?').run(hash(id));
    return r ? JSON.parse(r.data) : null;
  }
  acknowledge(id, signature) { this.db.prepare('INSERT OR REPLACE INTO acknowledgements VALUES(?,?,?)').run(id, signature, Date.now()); }
  acknowledged(id, signature) { return Boolean(this.db.prepare('SELECT 1 FROM acknowledgements WHERE id=? AND signature=?').get(id, signature)); }
  prune() {
    const now = Date.now();
    this.db.prepare('DELETE FROM history WHERE ts<?').run(now - 7 * 86400_000);
    this.pruneMetrics(now);
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
    this.db.prepare('DELETE FROM logins WHERE expires<?').run(now);
    this.db.prepare('DELETE FROM acknowledgements WHERE created<?').run(now - 30 * 86400_000);
  }
  close() { this.db.close(); }
}

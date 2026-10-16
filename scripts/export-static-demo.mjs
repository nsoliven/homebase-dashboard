// Builds the public live demo (homebase.nevryk.com): the UI in static mode plus sample-data
// responses captured from the loopback demo server. Only synthetic data from scripts/demo-preview.mjs
// is exported; never point this at a production backend.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticKey } from '../src/static-demo.js';
import { STATIC_METRICS } from '../server/metrics.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = resolve(root, 'dist-demo'), api = resolve(out, 'demo-api');
const DEMO = 'http://127.0.0.1:4320', RANGES = ['1h', '24h', '7d'];

execFileSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit' });   // dist/ for the demo server's own pages
rmSync(out, { recursive: true, force: true });
execFileSync('npx', ['vite', 'build', '--outDir', 'dist-demo'], { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_STATIC_DEMO: '1' } });

const server = spawn(process.execPath, ['scripts/demo-preview.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, DEMO_REFRESH_MS: '0' } });
await new Promise((ok, fail) => { server.stdout.on('data', d => String(d).includes('4320') && ok()); server.on('exit', fail); });
try {
  const saved = new Set();
  const save = async path => {
    const r = await fetch(DEMO + path);
    if (!r.ok) return null;
    const data = await r.json();
    const file = resolve(api, staticKey(path)); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data)); saved.add(path); return data;
  };
  const snapshot = await save('/api/snapshot'); await save('/api/session');
  const integrations = await save('/api/integrations'), live = await save('/api/compute');
  for (const range of RANGES) {
    await save(`/api/history?range=${range}`);
    for (const vm of snapshot.vms || []) await save(`/api/history?range=${range}&guest=${vm.id}`);
  }
  const view = live?.compute || {}, ids = new Set(Object.keys(STATIC_METRICS));
  for (const c of view.board?.ccds || []) ids.add(`cpu.ccd.${c.id}`), ids.add(`cpu.ccd.${c.id}.load`), ids.add(`cpu.ccd.${c.id}.clock`);
  for (const t of view.cpu?.threads || []) ids.add(`cpu.thread.${t.cpu}`);
  for (const f of view.board?.fans || []) ids.add(`board.fan.${f.id}`);
  for (const t of view.board?.temperatures || []) ids.add(`board.temp.${t.id}`);
  for (const p of view.processes || []) if (Number.isInteger(p.container)) ids.add(`gpu.vram.ct.${p.container}`);
  const groups = ['gpu.power', 'gpu.core', 'gpu.memory', 'gpu.cooling', 'gpu.video', 'gpu.state', 'gpu.processes', 'cpu.package', 'cpu.utilization', 'cpu.clocks', 'cpu.board',
    ...(view.board?.ccds || []).map(c => `cpu.ccd.${c.id}`), ...(view.board?.fans || []).map(f => `board.fan.${f.id}`)];
  for (const range of RANGES) {
    for (const id of ids) await save(`/api/metrics/${id}?range=${range}`);
    for (const id of groups) await save(`/api/compute/groups/${id}?range=${range}`);
  }
  // App and branding icons are plain SVGs at their original paths.
  const icons = new Set(JSON.stringify(integrations).match(/\/api\/(?:apps|branding)\/[a-z0-9-]+\/icon/g) || []);
  for (const path of icons) { const r = await fetch(DEMO + path); if (r.ok) { const file = resolve(out, '.' + path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(await r.arrayBuffer())); } }
  writeFileSync(resolve(api, 'manifest.json'), JSON.stringify({ exportedAt: Date.now(), responses: saved.size }));
  writeFileSync(resolve(out, '_headers'), [
    '/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: same-origin', '  X-Frame-Options: SAMEORIGIN',
    "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
    '/api/apps/:id/icon', '  Content-Type: image/svg+xml', '/api/branding/:id/icon', '  Content-Type: image/svg+xml',   // only the exported icons are images; any other /api path falls back to the app '/demo-api/*', '  Cache-Control: no-cache', ''].join('\n'));
  const index = resolve(out, 'index.html');
  writeFileSync(index, readFileSync(index, 'utf8').replace('</body>', '<a href="https://github.com/nsoliven/homebase-dashboard" style="position:fixed;bottom:8px;right:14px;padding:5px 9px;border:1px solid #2a303d;border-radius:6px;background:#11141b;color:#a3a9b8;font:11px system-ui;z-index:9999;text-decoration:none">Live demo · sample data</a></body>'));
  console.log(`Exported ${saved.size} sample responses and ${icons.size} icons to dist-demo/.`);
} finally { server.kill(); }

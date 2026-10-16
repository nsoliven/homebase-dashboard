import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/index.mjs';

test('only the case view may be framed, and only by Homebase itself', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'homebase-case-'));
  mkdirSync(join(dist, 'case'));
  writeFileSync(join(dist, 'index.html'), '<p>app</p>');
  writeFileSync(join(dist, 'case', 'index.html'), '<p>case</p>');
  const store = new Store(':memory:'); const app = createApp({ publicUrl: 'https://dashboard.example', dist }, store, { snapshot: () => ({}) }, {});
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base + '/case/?embed');
    assert.equal(await page.text(), '<p>case</p>');
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    const root = await fetch(base + '/');
    assert.equal(root.headers.get('x-frame-options'), 'DENY');
    assert.match(root.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(base + '/casefile')).headers.get('x-frame-options'), 'DENY');
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dist, { recursive: true, force: true }); }
});

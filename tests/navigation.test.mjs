import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pagePaths, pageFromPath, dashboardReturnTo, shouldHandleNavigation } from '../src/navigation.js';
import { createApp } from '../server/index.mjs';
import { Store } from '../server/store.mjs';

test('every sidebar destination resolves on direct entry, including trailing slashes', () => {
  for (const [page, path] of Object.entries(pagePaths)) {
    assert.equal(pageFromPath(path), page);
    assert.equal(pageFromPath(path + '/'), page);
    assert.equal(dashboardReturnTo(path), path);
  }
  assert.equal(pageFromPath('/missing'), 'overview');
});

test('sign-in accepts dashboard destinations and rejects arbitrary redirects', () => {
  assert.equal(dashboardReturnTo('/compute/#compute/gpu/power'), '/compute#compute/gpu/power');
  assert.equal(dashboardReturnTo('/claude-pace?range=24h'), '/claude-pace?range=24h');
  for (const path of [null, '//evil.example/compute', '/\\evil.example/compute', 'https://evil.example/compute', '/auth/login', '/api/snapshot', '/missing']) {
    assert.equal(dashboardReturnTo(path), '/');
  }
});

test('only plain left clicks are handled; browser new-tab and modified clicks remain native', () => {
  assert.equal(shouldHandleNavigation({button: 0}), true);
  for (const event of [{button: 1}, {button: 0, metaKey: true}, {button: 0, ctrlKey: true}, {button: 0, shiftKey: true}, {button: 0, altKey: true}, {button: 0, defaultPrevented: true}]) {
    assert.equal(shouldHandleNavigation(event), false);
  }
});

test('dashboard paths serve the app and sign-in carries the destination through callback', async () => {
  const store = new Store(':memory:');
  let destination;
  const auth = {
    begin: async value => { destination = dashboardReturnTo(value); return {url: 'https://auth.example/', browser: 'test'}; },
    complete: async () => ({token: 'test', returnTo: destination}),
  };
  const server = http.createServer(createApp({publicUrl: 'https://dashboard.example'}, store, {snapshot: () => ({})}, auth));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of Object.values(pagePaths)) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<div id="root"><\/div>/);
    }
    await fetch(base + '/auth/login?returnTo=%2Fclaude-pace', {redirect: 'manual'});
    const callback = await fetch(base + '/auth/callback', {redirect: 'manual'});
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/claude-pace');
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/index.mjs';
import { validFanRequest } from '../server/fans.mjs';

test('fan changes are validated before they leave the dashboard', () => {
  assert.deepEqual(validFanRequest({ group: 'rad', curve: [[50, 20.4], [80, 45], [95, 60]] }), { group: 'rad', curve: [[50, 20], [80, 45], [95, 60]] });
  assert.deepEqual(validFanRequest({ mode: 'bios' }), { mode: 'bios' });
  assert.deepEqual(validFanRequest({ mode: 'direct' }), { mode: 'direct' });
  assert.deepEqual(validFanRequest({ direct: { 6: 80.4, 3: null } }), { direct: { 3: null, 6: 80 } });
  for (const bad of [{ direct: { 2: 50 } }, { direct: { 9: 50 } }, { direct: {} }, { direct: { 6: 120 } }, { direct: { 6: '50' } }, { direct: [50] }])
    assert.equal(validFanRequest(bad), null, JSON.stringify(bad));
  assert.deepEqual(validFanRequest({ pulse: 'top' }), { pulse: 'top' });
  assert.deepEqual(validFanRequest({ hold: 'top', duty: 25, seconds: 60 }), { hold: 'top', duty: 25, seconds: 60, othersOff: true });
  assert.deepEqual(validFanRequest({ hold: 'rad', duty: 0, seconds: null, othersOff: false }), { hold: 'rad', duty: 0, seconds: null, othersOff: false });
  assert.deepEqual(validFanRequest({ hold: 'floor', duty: 100, seconds: 900 }), { hold: 'floor', duty: 100, seconds: 900, othersOff: true });
  assert.deepEqual(validFanRequest({ release: 'rear' }), { release: 'rear' });
  for (const bad of [{ hold: 'top', duty: 80, seconds: 60, othersOff: 'yes' }, { hold: 'pump', duty: 50, seconds: 10 }, { hold: 'top', duty: 120, seconds: 10 }, { hold: 'top', duty: 50, seconds: 0 }, { hold: 'top', duty: 50 }, { release: 'pump' }])
    assert.equal(validFanRequest(bad), null, JSON.stringify(bad));
  for (const bad of [null, [], { group: 'pump', curve: [[30, 100], [60, 100]] }, { group: 'gpu', curve: [[30, 0], [60, 50]] }, { group: 'rad', curve: [[50, 20]] },
    { group: 'rad', curve: [[80, 20], [50, 40]] }, { group: 'rad', curve: [[10, 20], [50, 40]] }, { group: 'rad', curve: [[50, 20], [60, 140]] }, { group: 'rad', curve: [[50, '20'], [60, 30]] },
    { mode: 'off' }, { pulse: 'pump' }, { group: 'rad', curve: Array.from({ length: 9 }, (_, i) => [30 + i, 40]) }])
    assert.equal(validFanRequest(bad), null, JSON.stringify(bad));
});

test('fan control needs a session and same-origin CSRF, and reports when it is not configured', async () => {
  const store = new Store(':memory:'); const app = createApp({ publicUrl: 'https://dashboard.example' }, store, { snapshot: () => ({}) }, {});
  const server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/fans')).status, 401);
    const session = store.session({ id: 'test', name: 'Test user' }), Cookie = `__Host-homebase=${session.token}`;
    assert.equal((await fetch(base + '/api/fans', { method: 'POST', headers: { Cookie }, body: '{"mode":"bios"}' })).status, 403);
    assert.equal((await fetch(base + '/api/fans', { headers: { Cookie } })).status, 404);
  } finally { await new Promise(r => server.close(r)); store.close(); }
});

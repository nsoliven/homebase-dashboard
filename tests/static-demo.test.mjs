import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftTimes, staticKey } from '../src/static-demo.js';

test('static demo file names are stable and ignore the live flag', () => {
  assert.equal(staticKey('/api/snapshot'), 'snapshot.json');
  assert.equal(staticKey('/api/compute?live=1'), 'compute.json');
  assert.equal(staticKey('/api/history?range=24h&guest=200'), staticKey('/api/history?guest=200&range=24h'));
  assert.equal(staticKey('/api/metrics/gpu.power?range=1h'), 'metrics_gpu.power__range-1h.json');
});

test('only epoch timestamps move forward with the clock', () => {
  const at = Date.UTC(2026, 9, 15), later = at + 3_600_000;
  const out = shiftTimes({ observedAt: at - 60_000, points: [{ t: at - 7 * 86_400_000, v: 42 }], rpm: 1118 }, at, later);
  assert.deepEqual(out, { observedAt: later - 60_000, points: [{ t: later - 7 * 86_400_000, v: 42 }], rpm: 1118 });
});

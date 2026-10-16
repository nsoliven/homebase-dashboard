// NVML clock event ("throttle") reason bits, as reported by
// nvidia-smi --query-gpu=clocks_throttle_reasons.active. Plain-language labels.
export const THROTTLE_REASONS = [
  { bit: 0x1, key: 'idle', label: 'Idle', detail: 'Clocks are lowered because nothing is running.' },
  { bit: 0x2, key: 'appClocks', label: 'Application clock limit', detail: 'An application clock setting caps the clocks.' },
  { bit: 0x4, key: 'powerCap', label: 'Power cap', detail: 'Clocks are held back to stay within the board power limit.' },
  { bit: 0x8, key: 'hwSlowdown', label: 'Hardware slowdown', detail: 'The board forced a slowdown (temperature or power brake).' },
  { bit: 0x10, key: 'syncBoost', label: 'Sync boost', detail: 'Clocks are matched to another GPU in a sync-boost group.' },
  { bit: 0x20, key: 'swThermal', label: 'Thermal limit (driver)', detail: 'The driver lowered clocks to keep temperature in range.' },
  { bit: 0x40, key: 'hwThermal', label: 'Thermal limit (hardware)', detail: 'The GPU hit its hardware temperature limit.' },
  { bit: 0x80, key: 'powerBrake', label: 'Power brake', detail: 'An external power-brake signal slowed the GPU.' },
  { bit: 0x100, key: 'displayClocks', label: 'Display clock setting', detail: 'A display clock setting caps the clocks.' },
];

/** Decodes a reason bitmask. 0 means nothing is limiting clocks; null means not reported. */
export function decodeThrottle(mask) {
  if (!Number.isSafeInteger(mask) || mask < 0) return null;
  const reasons = THROTTLE_REASONS.filter(r => (mask & r.bit) !== 0).map(({ key, label, detail }) => ({ key, label, detail }));
  const known = THROTTLE_REASONS.reduce((a, r) => a | r.bit, 0);
  if (mask & ~known) reasons.push({ key: 'other', label: 'Other reason', detail: 'The driver reported a reason this dashboard does not name.' });
  return reasons;
}
export const throttleSummary = mask => { const r = decodeThrottle(mask); return r === null ? 'Not reported' : r.length ? r.map(x => x.label).join(' · ') : 'Nothing is limiting clocks'; };

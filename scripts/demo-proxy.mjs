// Synthetic CLI Proxy responses for the isolated demo, run through the production
// sanitizer so the preview shows exactly what the live page would. No real accounts.
import { proxyReport } from '../server/proxy.mjs';

const HOUR = 3600_000, STEP = HOUR / 2;
const iso = t => new Date(t).toISOString();

export function demoProxy(now = Date.now()) {
  const start = now - 72 * HOUR, end = now + 96 * HOUR;
  const resetWork = now + 30 * HOUR, resetSpare = now + 70 * HOUR;
  // Daily rhythm: heavier use in the day, flat overnight, one refill two days ago.
  const past = [];
  for (let t = start, left = 1.6; t <= now; t += STEP) {
    const hour = new Date(t).getHours();
    left -= hour >= 9 && hour < 23 ? 0.016 : 0.002;
    if (Math.abs(t - (now - 40 * HOUR)) < STEP / 2) left += 1;
    past.push({ at: iso(t), left: Math.max(0.05, Math.round(left * 1000) / 1000) });
  }
  const forecast = rate => {
    const points = [];
    for (let t = now, left = past.at(-1).left; t <= end; t += STEP) {
      const hour = new Date(t).getHours();
      if (Math.abs(t - resetWork) < STEP / 2 || Math.abs(t - resetSpare) < STEP / 2) left += 1;
      left = Math.max(0, left - (hour >= 9 && hour < 23 ? rate : rate / 8));
      points.push(Math.round(left * 1000) / 1000);
    }
    return points;
  };
  const raw = {
    generated_at: iso(now), stale: false, state: 'on_pace', lines: ['On pace · low point 34% of an account'], low: 0.34, until: iso(resetSpare), run_out: null,
    accounts: [
      { name: 'Personal account', left: 0.42, used_5h: 0.18, kappa: 1, resets: iso(now + 110 * HOUR), resets_5h: iso(now + 2 * HOUR), status: 'DRAINING', reason: 'drains first: its week ends soonest after the refills', last_sample_at: iso(now - 90_000), last_source: 'header', cooling: false },
      { name: 'Work account', left: 0, used_5h: 0, kappa: 1, resets: iso(resetWork), status: 'COOLING', reason: 'cooling after a rate limit', last_sample_at: iso(now - 4 * 60_000), last_source: 'usage', cooling: true },
      { name: 'Spare account', left: 0.88, used_5h: 0.02, kappa: 1, resets: iso(resetSpare), resets_5h: iso(now + 4 * HOUR), status: 'NEXT', reason: 'kept for later; 10% held as reserve', last_sample_at: iso(now - 2 * 60_000), last_source: 'usage', cooling: false },
    ],
    banks: [
      { account: 'Personal account', label: 'One full limit reset', clears: ['five_hour', 'seven_day', 'seven_day_overage_included'], resets_left: 1, resets_total: 1, expires: iso(now + 26 * 24 * HOUR), usable_now: true },
      { account: 'Work account', label: 'One full limit reset', clears: ['five_hour', 'seven_day'], resets_left: 0, resets_total: 1, expires: iso(now + 26 * 24 * HOUR), usable_now: false },
      { account: 'Work account', label: 'Model launch reset', clears: ['seven_day_overage_included'], resets_left: 1, resets_total: 1, expires: iso(now + 31 * 24 * HOUR), usable_now: true },
    ],
    queued_resets: [
      { account: 'Personal account', label: 'One full limit reset', state: 'queued', queued_at: iso(now - 5 * HOUR) },
      { account: 'Work account', label: 'One full limit reset', state: 'fired', queued_at: iso(now - 20 * HOUR), fired_at: iso(now - 9 * HOUR), result: 'reset' },
    ],
    router: { auto_route: true, changes_24h: 6 },
    metrics: { failovers_429_by_day: Object.fromEntries([3, 0, 1, 2, 5].map((n, i) => [iso(now - (4 - i) * 24 * HOUR).slice(0, 10), n])) },
    curve: { usual_next_7d: 3.1 },
    timeline: {
      now: iso(now), end: iso(end), step_minutes: 30, past,
      pace_now: { multiple_6h: 0.8, target_multiple: 1 },
      scenarios: [
        { key: 'plan', points: forecast(0.012), run_out: null, dry_hours: 0, wasted: 0 },
        { key: 'normal', points: forecast(0.015), run_out: null, dry_hours: 0, wasted: 0 },
        { key: 'recent', points: forecast(0.006), run_out: null, dry_hours: 0, wasted: 0.21 },
      ],
      events: [
        { at: iso(resetWork), kind: 'reset', account: 'Work account' },
        { at: iso(resetSpare), kind: 'reset', account: 'Spare account' },
      ],
    },
  };
  const reserve = { enabled: true, reserve_release_h: 6, reserve: { 'spare account': 0.1 } };
  const credentials = { files: [
    { email: 'Personal account', provider: 'claude', status: 'active', last_renewal_verified_at: iso(now - 2 * HOUR) },
    { email: 'Work account', provider: 'claude', status: 'error', unavailable: true, quota_blocked: true, last_renewal_verified_at: iso(now - 3 * HOUR) },
    { email: 'Spare account', provider: 'claude', status: 'active', last_renewal_verified_at: iso(now - 40 * 60_000) },
    { email: 'Coding account', provider: 'codex', status: 'active', renewal_state: 'awaiting_first_renewal' },
  ] };
  return proxyReport(raw, { reserve, credentials });
}

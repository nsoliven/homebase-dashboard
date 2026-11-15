// Turns CLI Proxy management responses into the small shape the dashboard shows.
// Everything is allowlisted: tokens, file paths, credential IDs and anything the
// proxy adds later never reach the browser unless a field is named here.
const ms = value => { const n = Date.parse(value); return Number.isFinite(n) ? n : null; };
const seconds = value => { const n = ms(value); return n === null ? null : n / 1000; };
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value, max = 120) => typeof value === 'string' ? value.slice(0, max) : '';
const list = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];
const key = value => text(value, 200).toLowerCase();
// The proxy reports quota in account-weeks: 1 is one account's full week.
const percent = value => { const n = finite(value); return n === null ? null : Math.round(n * 100 * 1e4) / 1e4; };
// CLI Proxy's recovered quota endpoint uses fractions, not percentages.
const fractionPercent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? Math.round(value * 100 * 1e6) / 1e6 : null;
function weeklyUsed(account) {
  const capacity = account.kappa === undefined ? 1 : account.kappa;
  if (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0) return null;
  const left = fractionPercent(typeof account.left === 'number' ? account.left / capacity : null);
  return left === null ? null : 100 - left;
}

// The provider's `type: full` also covers model-only grants, so the windows a
// credit clears decide what it is (same rule as the CLI Proxy panel).
export function creditKind(credit) {
  const clears = Array.isArray(credit?.clears) ? credit.clears : [];
  if (clears.includes('seven_day')) return clears.includes('seven_day_overage_included') ? 'full' : 'weekly';
  if (clears.includes('seven_day_overage_included')) return 'model';
  if (clears.includes('five_hour')) return 'session';
  return credit?.gives_back_weekly === true ? 'model' : 'unknown';
}

const QUEUE_STATES = ['queued', 'claiming', 'fired', 'failed', 'unknown'];
const SCENARIOS = ['plan', 'normal', 'recent'];
const EVENTS = ['reset', 'bonus_expiry', 'run_out'];

function reserveConfig(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.enabled !== 'boolean') return null;
  const accounts = Object.fromEntries(Object.entries(raw.reserve && typeof raw.reserve === 'object' ? raw.reserve : {}).slice(0, 50)
    .flatMap(([name, fraction]) => fractionPercent(fraction) === null ? [] : [[key(name), fractionPercent(fraction)]]));
  return { enabled: raw.enabled, releaseHours: finite(raw.reserve_release_h), accounts };
}

// A quota-blocked account is still signed in: it says "error" only because the
// provider rate-limited it, so it reads as "limited", never as a broken sign-in.
export function credentialHealth(raw) {
  return list(raw?.files, 100).map((f, i) => {
    const status = text(f.status, 30) || 'unknown';
    const health = f.disabled === true ? 'disabled' : f.requires_sign_in === true ? 'signed-out'
      : f.quota_blocked === true ? 'limited' : f.unavailable === true || status !== 'active' ? 'error' : 'ok';
    return {
      id: `credential-${i + 1}`, name: text(f.email || f.account || f.label, 120) || `Credential ${i + 1}`,
      provider: text(f.provider || f.type, 30) || 'unknown', health,
      renewedAt: ms(f.last_renewal_verified_at), awaitingRenewal: f.renewal_state === 'awaiting_first_renewal',
      message: health === 'error' ? text(f.status_message, 160) : '',
    };
  });
}

function timeline(raw) {
  const t = raw?.timeline;
  if (!t || typeof t !== 'object') return null;
  const now = ms(t.now), end = ms(t.end), step = finite(t.step_minutes);
  if (now === null || end === null || !step || step <= 0) return null;
  return {
    now, end, stepMs: step * 60_000,
    past: list(t.past, 2000).flatMap(p => { const at = ms(p?.at), left = percent(p?.left); return at === null || left === null ? [] : [[at, left]]; }),
    scenarios: list(t.scenarios, 10).filter(s => SCENARIOS.includes(s?.key)).map(s => ({
      key: s.key, points: list(s.points, 2000).map(percent),
      runOut: ms(s.run_out), dryHours: finite(s.dry_hours) ?? 0, wasted: percent(s.wasted) ?? 0,
    })),
    events: list(t.events, 50).filter(e => EVENTS.includes(e?.kind) && ms(e?.at) !== null).map(e => ({ at: ms(e.at), kind: e.kind, account: text(e.account) })),
  };
}

export function proxyReport(raw, { reserve, credentials } = {}) {
  const reserveState = reserveConfig(reserve);
  const accounts = list(raw.accounts, 50).map((a, i) => {
    const name = text(a.name) || `Account ${i + 1}`;
    const configured = reserveState ? reserveState.accounts[name.toLowerCase()] : fractionPercent(a.configured_reserve);
    return {
      id: `account-${i + 1}`, name, status: text(a.status, 30) || 'unknown',
      reason: text(a.reason, 160), projection: text(a.projection, 80), cooling: a.cooling === true,
      observedAt: ms(a.last_sample_at), reportStale: raw.stale === true,
      source: ['header', 'usage'].includes(a.last_source) ? a.last_source : null,
      reservePercent: configured ?? 0,
      windows: [
        { id: 'five-hour', label: '5-hour window', usedPercent: fractionPercent(a.used_5h), resetsAt: seconds(a.resets_5h), durationMins: 300 },
        { id: 'weekly', label: 'Weekly window', usedPercent: weeklyUsed(a), resetsAt: seconds(a.resets), durationMins: 10080 },
      ].filter(w => w.usedPercent !== null),
    };
  });
  const pace = raw.timeline || raw.headline ? {
    state: text(raw.state, 30), headline: text(list(raw.lines, 1)[0] || raw.headline, 200),
    low: percent(raw.low), until: ms(raw.until), runOut: ms(raw.run_out),
    paceMultiple: finite(raw.timeline?.pace_now?.multiple_6h), targetMultiple: finite(raw.timeline?.pace_now?.target_multiple),
    usualNextWeek: percent(raw.curve?.usual_next_7d), timeline: timeline(raw),
  } : null;
  return {
    status: raw.stale ? 'stale' : 'connected', observedAt: ms(raw.generated_at), accounts, pace,
    credits: list(raw.banks, 100).map(b => ({
      account: text(b.account), label: text(b.label), kind: creditKind(b),
      left: finite(b.resets_left) ?? 0, total: finite(b.resets_total) ?? 0, expiresAt: ms(b.expires), usableNow: b.usable_now === true,
    })),
    queued: list(raw.queued_resets, 50).filter(q => QUEUE_STATES.includes(q?.state)).map(q => ({
      account: text(q.account), label: text(q.label), state: q.state, queuedAt: ms(q.queued_at), firedAt: ms(q.fired_at),
      endsAt: ms(q.ends_at), result: text(q.result, 40),
    })),
    reserve: reserveState && { enabled: reserveState.enabled, releaseHours: reserveState.releaseHours },
    router: raw.router && typeof raw.router === 'object' ? { autoRoute: raw.router.auto_route === true, changes24h: finite(raw.router.changes_24h) } : null,
    failovers: Object.entries(raw.metrics?.failovers_429_by_day || {}).filter(([day, n]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && finite(n) !== null).sort().slice(-7).map(([day, count]) => ({ day, count })),
    credentials: credentials ? credentialHealth(credentials) : null,
  };
}

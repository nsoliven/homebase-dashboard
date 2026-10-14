export const QUOTA_FRESH_MS = 10 * 60_000;

// Report generation time is not the account's provider-observation time.
export function quotaReading(account, window, now = Date.now()) {
  const used = window?.usedPercent;
  const remaining = typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100 ? 100-used : null;
  const observed = account?.observedAt, reset = window?.resetsAt * 1000;
  if (remaining === null || !Number.isFinite(observed) || observed <= 0 || observed > now+60_000)
    return {remaining, currentRemaining:null, state:'unavailable'};
  if (!Number.isFinite(reset) || reset <= 0)
    return {remaining, currentRemaining:null, state:'unknown-reset'};
  const duration = window?.durationMins * 60_000;
  // The pacing endpoint can roll a lapsed window forward. That projection is
  // not a new provider observation and must never masquerade as a reset reading.
  if (reset <= now || Number.isFinite(duration) && duration > 0 && observed < reset-duration-60_000)
    return {remaining, currentRemaining:null, state:'expired'};
  if (account.reportStale || now-observed >= QUOTA_FRESH_MS)
    return {remaining, currentRemaining:null, state:'stale'};
  return {remaining,currentRemaining:remaining,state:'current'};
}

export function quotaSummary(accounts = [], now = Date.now()) {
  const current = accounts.filter(a=>a.windows?.some(w=>quotaReading(a,w,now).state==='current')).length;
  return {current, outdated:accounts.length-current};
}

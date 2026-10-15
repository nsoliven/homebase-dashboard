export async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'Your session has expired. Sign in again.' : 'The request could not complete. Please retry.');
    error.status = response.status;
    throw error;
  }
  return response.json();
}
/** Source refresh replies carry useful bodies for 202/409/429/502 too. */
export async function refreshSource(id, csrf) {
  const response = await fetch(`/api/refresh/${encodeURIComponent(id)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Homebase-CSRF': csrf } });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 401 || response.status === 403 || !body?.status) {
    const error = new Error(response.status === 401 ? 'Your session has expired. Sign in again.' : 'The refresh could not complete. Please retry.');
    error.status = response.status;
    throw error;
  }
  return body;
}
export const isNumber = n => typeof n === 'number' && Number.isFinite(n);
export const fmt = (n, digits = 1) => isNumber(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
export function bytes(n, digits = 1) {
  if (!isNumber(n)) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'], index = Math.min(5, Math.floor(Math.log(n) / Math.log(1024)));
  return `${fmt(n / 1024 ** index, digits)} ${units[index]}`;
}
export const percentage = (used, total) => isNumber(used) && total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : null;
export function age(ts) {
  if (!ts) return 'Never';
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
}
export function duration(seconds) {
  if (!isNumber(seconds)) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}
export function memory(vm) {
  if (vm.status !== 'running') return { used: null, total: vm.memoryTotal, percent: null, scope: 'Stopped' };
  const internal = vm.guest && isNumber(vm.guest.available) && isNumber(vm.guest.total);
  const total = internal ? vm.guest.total : vm.memoryTotal;
  const used = internal ? total - vm.guest.available : vm.memoryUsed;
  return { used, total, percent: percentage(used, total), scope: internal ? 'Guest · excludes reclaimable cache' : vm.type === 'lxc' ? 'Container-reported' : 'Proxmox-reported · includes cache' };
}

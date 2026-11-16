export const pagePaths = {
  overview: '/', compute: '/compute', cooling: '/cooling',
  vms: '/virtual-machines', agents: '/sessions', proxy: '/claude-pace',
  applications: '/applications', storage: '/storage', network: '/network',
  connections: '/connections',
};

export function pageFromPath(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  return Object.keys(pagePaths).find(page => pagePaths[page] === path) || 'overview';
}

// Only known dashboard paths may be used as sign-in destinations.
export function dashboardReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://homebase.invalid');
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (url.origin !== 'https://homebase.invalid' || !Object.values(pagePaths).includes(url.pathname)) return '/';
    return url.pathname + url.search + url.hash;
  } catch { return '/'; }
}

export function shouldHandleNavigation(event) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

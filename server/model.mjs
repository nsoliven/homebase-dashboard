import { thermalState } from './cooling.mjs';
import { HISTORY_KEYS, sample, sanitizeCompute } from './compute.mjs';
export const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export const percent = (used, total) => total > 0 && Number.isFinite(used) ? used / total * 100 : null;
const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
const number = (v, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
const psi = data => data && Object.fromEntries(['cpu', 'memory', 'io'].map(k => [k, data[k] ? { some: number(data[k].some, 100), full: number(data[k].full, 100) } : null]));

// Collector boundaries intentionally whitelist fields; raw commands, environments,
// transcript text, provider credentials, and arbitrary objects never enter the store.
export function sanitizeFeed(scope, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid feed');
  if (scope === 'host' || scope.startsWith('guest:')) return {
    name: text(payload.name), os: text(payload.os, 80), total: number(payload.total), available: number(payload.available),
    swapUsed: number(payload.swapUsed), swapTotal: number(payload.swapTotal), pressure: psi(payload.pressure),
    temperatures: Array.isArray(payload.temperatures) ? payload.temperatures.slice(0, 30).map(t => ({ id: text(t.id, 80), name: text(t.name, 100), group: text(t.group, 40), label: text(t.label, 80), value: number(t.value, 150) })) : [],
    fans: Array.isArray(payload.fans) ? payload.fans.slice(0, 32).map(f => ({id:text(f.id,80),name:text(f.name,100),label:text(f.label,100),rpm:number(f.rpm,20000)})).filter(f=>f.id && f.rpm !== null) : [],
    cpuTemperature: number(payload.cpuTemperature, 150), zfsHealth: text(payload.zfsHealth), diskReadBytes: number(payload.diskReadBytes), diskWriteBytes: number(payload.diskWriteBytes),
  };
  if (scope === 'router') return { model: text(payload.model, 80), firmware: text(payload.firmware, 100), uptime: number(payload.uptime), clients: number(payload.clients, 10000), wanRx: number(payload.wanRx), wanTx: number(payload.wanTx), interface: text(payload.interface, 40), latency: number(payload.latency, 60000), packetLoss: number(payload.packetLoss, 100) };
  if (scope === 'agents') return { agents: Array.isArray(payload.agents) ? payload.agents.slice(0, 200).map(a => ({
    id: text(a.id, 180), threadId: text(a.threadId, 180), name: text(a.name, 120), project: text(a.project, 120), provider: ['codex', 'claude'].includes(a.provider) ? a.provider : 'agent',
    status: ['working', 'input', 'review', 'idle', 'error'].includes(a.status) ? a.status : 'idle',
    branch: text(a.branch, 120), updatedAt: number(a.updatedAt), source: text(a.source, 80),
  })).filter(a => a.id) : [] };
  if (scope === 'quotas') return Object.fromEntries(['codex', 'claude'].map(provider => {
    const q = payload[provider];
    return [provider, q ? { observedAt: number(q.observedAt), windows: Array.isArray(q.windows) ? q.windows.slice(0, 16).map(w => ({
      id: text(w.id, 80), label: text(w.label, 80), usedPercent: number(w.usedPercent, 100), durationMins: number(w.durationMins), resetsAt: number(w.resetsAt),
    })).filter(w => w.usedPercent !== null && w.resetsAt !== null) : [] } : null];
  }));
  if (scope === 'nas') return {
    hostname: text(payload.hostname, 80), version: text(payload.version, 80), uptime: number(payload.uptime),
    memoryTotal: number(payload.memoryTotal), memoryAvailable: number(payload.memoryAvailable),
    netRx: number(payload.netRx), netTx: number(payload.netTx),
    pools: Array.isArray(payload.pools) ? payload.pools.slice(0, 30).map(p => ({
      name: text(p.name, 100), status: text(p.status, 40), used: number(p.used), total: number(p.total), free: number(p.free),
      readErrors: number(p.readErrors), writeErrors: number(p.writeErrors), checksumErrors: number(p.checksumErrors),
      readBytes: number(p.readBytes), writeBytes: number(p.writeBytes),
    })) : [],
    alerts: Array.isArray(payload.alerts) ? payload.alerts.slice(0, 50).map(a => ({ id: text(a.id), level: text(a.level, 30), title: text(a.title, 160) })) : [],
  };
  if (scope === 'compute') return sanitizeCompute(payload);
  throw new Error('Unsupported feed');
}

export function guestFromResource(r, feed) {
  const telemetry = feed && !feed.stale ? feed.data : null;
  return {
    id: r.vmid, name: r.name, node: r.node, type: r.type, status: r.status, uptime: r.uptime || 0,
    cpu: r.status === 'running' ? finite(r.cpu * 100) : null, cores: r.maxcpu, memoryUsed: finite(r.mem), memoryHost: finite(r.memhost), memoryTotal: finite(r.maxmem),
    diskTotal: finite(r.maxdisk), diskUsed: r.type === 'lxc' ? finite(r.disk) : null,
    netIn: finite(r.netin), netOut: finite(r.netout), os: telemetry?.os || null,
    guest: telemetry, guestUpdatedAt: feed?.observed || null, guestStale: feed?.stale ?? true,
    memoryScope: telemetry ? 'guest' : r.type === 'lxc' ? 'container' : 'proxmox',
  };
}

export function deriveAlerts(snapshot) {
  const alerts = [];
  const add = (id, title, detail, severity, target) => alerts.push({ id, title, detail, severity, target, signature: `${title}:${detail}` });
  if (snapshot.host && snapshot.sources.find(s => s.id === 'proxmox')?.status === 'connected') {
    if (snapshot.host.pressure?.memory?.some > 5) add('host:pressure', 'Host memory contention', `Memory PSI ${snapshot.host.pressure.memory.some.toFixed(1)}%.`, 'warning', 'compute');
    const thermal=thermalState(snapshot.host);
    if (thermal.alert) add('host:temperature', thermal.label, `${snapshot.host.cpuTemperature.toFixed(1)}°C package${Number.isFinite(snapshot.host.cpu)?` · ${snapshot.host.cpu.toFixed(0)}% CPU`:''}${thermal.limit ? ` · ${thermal.limit}°C rated limit` : ''}.`, 'warning', 'compute');
    for (const s of snapshot.host.storage || []) if (percent(s.used, s.total) >= 85) add(`host:storage:${s.name}`, `${s.name} is nearing capacity`, `${percent(s.used, s.total).toFixed(0)}% used.`, 'warning', 'storage');
  }
  for (const vm of snapshot.vms) {
    if (vm.status === 'running' && vm.guest?.pressure?.memory?.some > 5) add(`guest:${vm.id}:pressure`, `${vm.name} is waiting on memory`, `Memory PSI ${vm.guest.pressure.memory.some.toFixed(1)}%.`, 'warning', 'vms');
  }
  if (snapshot.nas) for (const pool of snapshot.nas.pools) {
    if (pool.status !== 'ONLINE') add(`nas:${pool.name}:health`, `${pool.name}: ${pool.status}`, 'TrueNAS reports a pool health issue.', 'error', 'storage');
    if (pool.checksumErrors > 0 || pool.readErrors > 0 || pool.writeErrors > 0) add(`nas:${pool.name}:errors`, `${pool.name} has recorded errors`, `Read ${pool.readErrors ?? '—'} · write ${pool.writeErrors ?? '—'} · checksum ${pool.checksumErrors ?? '—'}.`, 'error', 'storage');
    if (percent(pool.used, pool.total) >= 85) add(`nas:${pool.name}:capacity`, `${pool.name} is nearing capacity`, `${percent(pool.used, pool.total).toFixed(0)}% used.`, 'warning', 'storage');
  }
  for (const source of snapshot.sources) if (['stale', 'error'].includes(source.status)) add(`source:${source.id}`, `${source.label} needs a connection check`, source.message, 'warning', 'connections');
  return alerts;
}

export function chartValues(snapshot) {
  const hostFresh = snapshot.sources.find(s => s.id === 'proxmox')?.status === 'connected';
  const data = { 'host.cpu': hostFresh ? snapshot.host?.cpu : null, 'host.memory': hostFresh ? percent(snapshot.host?.memoryUsed, snapshot.host?.memoryTotal) : null,
    'host.diskRead': hostFresh ? snapshot.host?.diskReadRate : null, 'host.diskWrite': hostFresh ? snapshot.host?.diskWriteRate : null,
    'host.temperature': snapshot.host?.cpuTemperature ?? null,
    ...Object.fromEntries((snapshot.host?.temperatures || []).filter(t=>t.id).map(t=>[`temperature.${t.id}`,t.value])),
    ...Object.fromEntries((snapshot.host?.cooling?.fans || []).filter(f=>f.id).map(f=>[`fan.${f.id}`,f.rpm])),
    'router.latency': snapshot.router?.latency ?? null, 'router.packetLoss': snapshot.router?.packetLoss ?? null,
    'router.down': snapshot.router?.downMbps ?? null, 'router.up': snapshot.router?.upMbps ?? null,
    'nas.read': snapshot.nas?.readRate ?? null, 'nas.write': snapshot.nas?.writeRate ?? null,
  };
  const compute = snapshot.compute && !snapshot.compute.stale ? sample(snapshot.compute) : {};
  for (const [key, history] of Object.entries(HISTORY_KEYS)) data[history] = compute[key] ?? null;
  for (const vm of snapshot.vms) {
    data[`vm.${vm.id}.cpu`] = hostFresh ? vm.cpu : null;
    data[`vm.${vm.id}.memory`] = hostFresh && vm.status === 'running' ? vm.guest ? percent(vm.guest.total - vm.guest.available, vm.guest.total) : percent(vm.memoryUsed, vm.memoryTotal) : null;
    data[`vm.${vm.id}.pressure`] = vm.status === 'running' ? vm.guest?.pressure?.memory?.some ?? null : null;
  }
  return data;
}

import https from 'node:https';
import { readFileSync } from 'node:fs';
import { chartValues, deriveAlerts, guestFromResource, percent } from './model.mjs';

export function requestProxmox(config, path) {
  if (!config) return Promise.reject(new Error('not_configured'));
  return new Promise((resolve, reject) => {
    const request = https.get({ hostname: config.host, port: config.port || 8006, path: `/api2/json${path}`,
      servername: config.servername, ca: readFileSync(config.caFile),
      headers: { Authorization: `PVEAPIToken=${config.tokenId}=${config.token}` }, timeout: 8000,
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 2_000_000) request.destroy(new Error('response_too_large')); });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`upstream_${response.statusCode}`));
        try { resolve(JSON.parse(body).data); } catch { reject(new Error('invalid_response')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => reject(new Error('connection_failed')));
  });
}

export class Monitor {
  constructor(config, store, api = requestProxmox) { this.config = config; this.store = store; this.api = path => api(config.proxmox, path); this.busy = false; this.lastError = null; this.rates = new Map(); this.cache = new Map(); }
  rate(key, value, observed) {
    if (!Number.isFinite(value)) return null;
    const previous = this.rates.get(key);
    this.rates.set(key, { value, observed });
    if (!previous || observed <= previous.observed || value < previous.value || observed - previous.observed > 120_000) return null;
    return (value - previous.value) / ((observed - previous.observed) / 1000);
  }
  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const node = this.config.proxmox?.node;
      if (node) {
        const [resources, status, tasks] = await Promise.all([this.api('/cluster/resources'), this.api(`/nodes/${node}/status`), this.api(`/nodes/${node}/tasks?limit=50`).catch(() => [])]);
        const raw = { resources, status, backup: tasks.filter(t => t.type === 'vzdump' && t.status === 'OK' && t.endtime).sort((a, b) => b.endtime - a.endtime)[0]?.endtime * 1000 || null };
        this.store.feed('proxmox', raw);
        this.lastError = null;
      }
      const router = this.store.getFeed('router');
      if (router && !router.stale && this.routerObserved !== router.observed) {
        const rx = this.rate('router.rx', router.data.wanRx, router.observed), tx = this.rate('router.tx', router.data.wanTx, router.observed);
        this.routerRates = { downMbps: rx === null ? null : rx * 8 / 1e6, upMbps: tx === null ? null : tx * 8 / 1e6 };
        this.routerObserved = router.observed;
      }
      const nas = this.store.getFeed('nas');
      if (nas && !nas.stale && this.nasObserved !== nas.observed) {
        const reads = nas.data.pools.map(p => p.readBytes), writes = nas.data.pools.map(p => p.writeBytes);
        this.nasRates = { readRate: reads.every(Number.isFinite) ? this.rate('nas.read', reads.reduce((a,b)=>a+b,0), nas.observed) : null, writeRate: writes.every(Number.isFinite) ? this.rate('nas.write', writes.reduce((a,b)=>a+b,0), nas.observed) : null };
        this.nasObserved = nas.observed;
      }
      const hostFeed = this.store.getFeed('host');
      if (hostFeed && !hostFeed.stale && this.hostObserved !== hostFeed.observed) {
        this.hostRates = { diskReadRate: this.rate('host.read', hostFeed.data.diskReadBytes, hostFeed.observed), diskWriteRate: this.rate('host.write', hostFeed.data.diskWriteBytes, hostFeed.observed) };
        this.hostObserved = hostFeed.observed;
      }
      this.store.history(chartValues(this.snapshot()));
      this.store.prune();
    } catch { this.lastError = 'Could not reach the Proxmox API. Last readings are retained.'; }
    finally { this.busy = false; }
  }
  snapshot() {
    const pve = this.store.getFeed('proxmox'), hostFeed = this.store.getFeed('host'), router = this.store.getFeed('router'), nas = this.store.getFeed('nas'), agentFeed = this.store.getFeed('agents'), quotas = this.store.getFeed('quotas', 180_000);
    const source = (id, label, feed, missing) => ({ id, label, status: !feed ? 'unavailable' : feed.stale ? 'stale' : 'connected', observedAt: feed?.observed || null, message: !feed ? missing : feed.stale ? 'No fresh measurements have arrived in the last two minutes.' : 'Receiving live measurements.' });
    const sources = [source('proxmox', 'Proxmox', pve, 'Proxmox monitoring is not connected.'), source('host', 'Host telemetry', hostFeed, 'Host temperatures and PSI are not connected.'), source('nas', 'TrueNAS', nas, 'NAS access is needed to connect pool health and capacity.'), source('router', 'Router', router, 'Router telemetry is not connected.'), source('agents', 'T3 sessions', agentFeed, 'The T3 session bridge is not connected.'), source('quotas', 'AI usage', quotas, 'No provider quota readings have arrived.')];
    if (this.lastError) Object.assign(sources[0], { status: 'error', message: this.lastError });
    let host = null;
    if (pve) {
      const { resources, status, backup } = pve.data;
      const node = resources.find(r => r.type === 'node' && r.node === this.config.proxmox.node);
      host = { name: node?.node || this.config.proxmox.node, cpu: (node?.cpu ?? status.cpu) * 100, cpuModel: status.cpuinfo?.model, cores: status.cpuinfo?.cores, threads: status.cpuinfo?.cpus,
        memoryUsed: status.memory?.used, memoryTotal: status.memory?.total, memoryAvailable: status.memory?.available,
        swapUsed: status.swap?.used, swapTotal: status.swap?.total, uptime: status.uptime, load: status.loadavg?.map(Number), version: status.pveversion,
        pressure: hostFeed && !hostFeed.stale ? hostFeed.data.pressure : null, cpuTemperature: hostFeed && !hostFeed.stale ? hostFeed.data.cpuTemperature : null,
        temperatures: hostFeed && !hostFeed.stale ? hostFeed.data.temperatures : [], zfsHealth: hostFeed && !hostFeed.stale ? hostFeed.data.zfsHealth : null,
        ...(hostFeed && !hostFeed.stale ? this.hostRates : {}), backupAt: backup, storage: resources.filter(r => r.type === 'storage').map(r => ({ name: r.storage, type: r.plugintype, status: r.status, used: r.disk, total: r.maxdisk, content: r.content })),
      };
    }
    const guests = (pve?.data.resources || []).filter(r => ['qemu', 'lxc'].includes(r.type) && !r.template);
    const vms = guests.map(r => guestFromResource(r, this.store.getFeed(`guest:${r.vmid}`))).sort((a, b) => a.id - b.id);
    const result = { observedAt: pve?.observed || null, generatedAt: Date.now(), sources, host, vms,
      router: router && !router.stale ? { ...router.data, ...this.routerRates } : null,
      nas: nas && !nas.stale ? { ...nas.data, ...this.nasRates } : null,
      agents: agentFeed && !agentFeed.stale ? agentFeed.data.agents.map(a => ({ ...a, acknowledged: this.store.acknowledged(`agent:${a.id}`, `${a.status}:${a.updatedAt}`) })) : [],
      quotas: quotas && !quotas.stale ? quotas.data : { codex: null, claude: null },
    };
    result.alerts = deriveAlerts(result).map(a => ({ ...a, acknowledged: this.store.acknowledged(a.id, a.signature) }));
    return result;
  }
  async history(range, guest) {
    const timeframe = { '1h': 'hour', '24h': 'day', '7d': 'week' }[range];
    if (!timeframe) throw new Error('Invalid range');
    const local = this.store.series(range), node = this.config.proxmox?.node;
    if (!node) return local;
    const snapshot = this.snapshot(), vm = guest ? snapshot.vms.find(v => String(v.id) === guest) : null;
    if (guest && !vm) throw new Error('Guest not found');
    const key = `${range}:${guest || 'host'}`;
    let rrd = this.cache.get(key);
    if (!rrd || Date.now() - rrd.time > 60_000) {
      const path = vm ? `/nodes/${node}/${vm.type}/${vm.id}/rrddata?timeframe=${timeframe}&cf=AVERAGE` : `/nodes/${node}/rrddata?timeframe=${timeframe}&cf=AVERAGE`;
      try { rrd = { time: Date.now(), data: await this.api(path) }; this.cache.set(key, rrd); } catch { rrd = rrd || { data: [] }; }
    }
    const values = new Map(), step = ({ '1h': 15_000, '24h': 300_000, '7d': 1800_000 })[range];
    for (const row of rrd.data) {
      if (!Number.isFinite(row.time)) continue;
      const ts = row.time * 1000; if (ts < local.from || ts > local.to) continue; const bucket = Math.floor(ts / step), p = vm ? `vm.${vm.id}` : 'host';
      values.set(bucket, { ts, rrdOnly: true, values: { [`${p}.cpu`]: Number.isFinite(row.cpu) ? row.cpu * 100 : null, [`${p}.memory`]: percent(row.memused ?? row.mem, row.memtotal ?? row.maxmem), ...(vm ? {} : { 'host.diskRead': row.diskread ?? null, 'host.diskWrite': row.diskwrite ?? null }) } });
    }
    for (const point of local.points) {
      const bucket = Math.floor(point.ts / step), previous = values.get(bucket);
      values.set(bucket, { ts: point.ts, rrdOnly: false, values: { ...previous?.values, ...Object.fromEntries(Object.entries(point.values).filter(([k, v]) => v !== null || !previous?.values?.[k])) } });
    }
    return { ...local, points: [...values.values()].sort((a, b) => a.ts - b.ts), memorySource: vm ? 'Proxmox / guest telemetry where available' : 'Proxmox' };
  }
}

import { spawn } from 'node:child_process';

// Fan control on the hypervisor. Requests go over one SSH key whose authorized_keys entry
// forces `fanctl.py`, so this side can only ask for `status` or `set` a validated change.
export const FAN_GROUPS = ['rad', 'top', 'floor', 'rear'];

/** Same rules the host enforces: 2-8 points, rising temperatures 20-100 °C, duty 0-100%. */
export function validFanRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if ('mode' in body) return ['curves', 'bios'].includes(body.mode) ? { mode: body.mode } : null;
  if ('pulse' in body) return FAN_GROUPS.includes(body.pulse) ? { pulse: body.pulse } : null;
  if ('release' in body) return FAN_GROUPS.includes(body.release) ? { release: body.release } : null;
  if ('hold' in body) {
    const { hold, duty, seconds } = body, num = v => typeof v === 'number' && Number.isFinite(v);
    if (!FAN_GROUPS.includes(hold) || !num(duty) || duty < 0 || duty > 100) return null;
    if (seconds !== null && (!num(seconds) || seconds < 1 || seconds > 86400)) return null;
    const othersOff = body.othersOff ?? true;
    if (typeof othersOff !== 'boolean') return null;
    return { hold, duty: Math.round(duty), seconds: seconds === null ? null : Math.round(seconds), othersOff };
  }
  const { group, curve } = body;
  if (!FAN_GROUPS.includes(group) || !Array.isArray(curve) || curve.length < 2 || curve.length > 8) return null;
  const num = v => typeof v === 'number' && Number.isFinite(v);
  if (!curve.every(p => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]) && p[0] >= 20 && p[0] <= 100 && p[1] >= 0 && p[1] <= 100)) return null;
  if (!curve.every((p, i) => i === 0 || curve[i - 1][0] < p[0])) return null;
  return { group, curve: curve.map(([t, d]) => [Math.round(t), Math.round(d)]) };
}

export class Fans {
  constructor(config) { this.config = config; this.cache = null; this.cachedAt = 0; this.queue = Promise.resolve(); }
  get configured() { return Boolean(this.config?.host && this.config?.keyFile && this.config?.knownHostsFile); }
  run(command, input) {
    const { host, user = 'root', keyFile, knownHostsFile } = this.config;
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', ['-i', keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${knownHostsFile}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', `${user}@${host}`, command], { stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, 10_000);
      child.stdout.on('data', d => { out += d; if (out.length > 65536) child.kill('SIGKILL'); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(out)); } catch { reject(new Error('unreadable reply')); } });
      child.stdin.end(input ?? '');
    });
  }
  async status() {
    if (Date.now() - this.cachedAt < 2000 && this.cache) return this.cache;
    const result = await this.run('status');
    this.cache = result; this.cachedAt = Date.now();
    return result;
  }
  /** One change at a time, in the order they arrive. */
  set(request) {
    const next = this.queue.then(() => this.run('set', JSON.stringify(request)));
    this.queue = next.catch(() => {});
    return next.then(result => { if (!result.error) { this.cache = result; this.cachedAt = Date.now(); } return result; });
  }
}

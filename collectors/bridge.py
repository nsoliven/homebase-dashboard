#!/usr/bin/env python3
"""Local bridge: read-only SSH probes and sanitized agent/provider status."""
import concurrent.futures
import json
import os
import queue
import re
import selectors
import signal
import ssl
import subprocess
import threading
import time
import urllib.request
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

spec = spec_from_file_location('linux_metrics', Path(__file__).with_name('read-linux.py'))
metrics = module_from_spec(spec)
spec.loader.exec_module(metrics)
CONFIG_PATH = Path(os.environ.get('HOMEBASE_BRIDGE_CONFIG', Path.home() / '.config/homebase/bridge.json'))
stopping = False


def run(args, timeout=12, input_data=None):
    """Run one probe. A probe that outlives its timeout is killed and abandoned, never waited on.

    subprocess.run() waits for the killed child after a timeout. A child stuck in uninterruptible
    sleep (on Synapse: a guest page fault the hypervisor never answered) or one that left a
    grandchild holding its pipes open makes that wait endless, and with it the whole collector.
    """
    process = subprocess.Popen(args, stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        stdout, _ = process.communicate(input_data, timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        threading.Thread(target=process.wait, daemon=True).start()   # reap it whenever it finally exits
        raise RuntimeError('Probe timed out') from None
    if process.returncode:
        raise RuntimeError('Probe failed')
    return stdout


def ssh(host, command, input_data=None):
    return run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', host, command], input_data=input_data)


def host_metrics(config):
    data = json.loads(ssh(config['hostTarget'], 'python3 /usr/local/lib/homebase/read-linux.py'))
    # Only the health summary; zpool status paths and file names are never exported.
    health = ssh(config['hostTarget'], 'zpool list -H -o name,health').strip().splitlines()
    data['zfsHealth'] = 'ONLINE' if health and all(line.split()[-1] == 'ONLINE' for line in health) else 'CHECK'
    return data


def router_metrics(config):
    script = "printf 'MODEL '; nvram get productid; printf 'FIRMWARE '; nvram get firmver; printf 'UPTIME '; cut -d' ' -f1 /proc/uptime; printf 'INTERFACE '; nvram get wan0_ifname; printf 'CLIENTS '; wc -l < /var/lib/misc/dnsmasq.leases; cat /proc/net/dev; ping -c 3 -W 2 1.1.1.1 | tail -2"
    raw = ssh(config['routerTarget'], script)
    result = {}
    keys = {'MODEL': 'model', 'FIRMWARE': 'firmware', 'UPTIME': 'uptime', 'INTERFACE': 'interface', 'CLIENTS': 'clients'}
    for line in raw.splitlines():
        key, _, value = line.partition(' ')
        if key in keys:
            result[keys[key]] = float(value) if key in ['UPTIME', 'CLIENTS'] else value.strip()
    for line in raw.splitlines():
        if line.strip().startswith(result.get('interface', '?') + ':'):
            fields = line.split(':', 1)[1].split()
            result.update(wanRx=int(fields[0]), wanTx=int(fields[8]))
    loss = re.search(r'(\d+(?:\.\d+)?)% packet loss', raw)
    latency = re.search(r'(?:round-trip|rtt).*?=\s*[\d.]+/([\d.]+)/', raw)
    result['packetLoss'] = float(loss.group(1)) if loss else None
    result['latency'] = float(latency.group(1)) if latency else None
    return result


def codex_quota():
    process = subprocess.Popen(['codex', 'app-server', '--stdio'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    process.stdin.write(json.dumps({'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'homebase-usage', 'version': '1.0.0'}}}) + '\n')
    process.stdin.flush()
    deadline = time.monotonic() + 18
    try:
        while time.monotonic() < deadline:
            if not selector.select(1):
                continue
            line = process.stdout.readline()
            if not line:
                break
            message = json.loads(line)
            if message.get('id') == 1:
                process.stdin.write(json.dumps({'method': 'initialized'}) + '\n' + json.dumps({'id': 2, 'method': 'account/rateLimits/read'}) + '\n')
                process.stdin.flush()
            if message.get('id') == 2:
                result = message.get('result', {})
                limits = result.get('rateLimitsByLimitId') or {'codex': result.get('rateLimits', {})}
                windows = []
                for limit_id, limit in limits.items():
                    for name in ['primary', 'secondary']:
                        window = limit.get(name)
                        if not window:
                            continue
                        duration = window.get('windowDurationMins')
                        label = 'Weekly window' if duration == 10080 else '5-hour window' if duration == 300 else f'{duration}-minute window' if duration else 'Usage window'
                        windows.append({'id': f'{limit_id}:{name}', 'label': label, 'durationMins': duration, 'usedPercent': window.get('usedPercent'), 'resetsAt': window.get('resetsAt')})
                return {'observedAt': int(time.time() * 1000), 'windows': windows}
        raise RuntimeError('Codex quota unavailable')
    finally:
        selector.close()
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()


COMPUTE_PROBE = Path(__file__).with_name('read-compute.py')


def compute_metrics(config):
    """GPU/CPU telemetry: pipes the fixed read-only probe to the hypervisor."""
    return json.loads(ssh(config['hostTarget'], 'python3 -', COMPUTE_PROBE.read_text()))


class Delivery:
    """Authenticated transport to the dashboard's collector endpoints."""

    def __init__(self, config):
        self.endpoint = config['endpoint']
        self.key = config['key']
        self.context = ssl.create_default_context(cafile=config['caFile']) if config.get('caFile') else None
        self.requests_url = self.endpoint.rstrip('/') + '/requests'

    def push(self, scope, data):
        body = json.dumps({'scope': scope, 'observedAt': int(time.time() * 1000), 'data': data}).encode()
        request = urllib.request.Request(self.endpoint, data=body, method='POST', headers={'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, context=self.context, timeout=8) as response:
            if response.status != 200:
                raise RuntimeError('Collector delivery failed')

    def requests(self, wait):
        """Long-poll for refresh requests. The reply only ever names scopes."""
        request = urllib.request.Request(f'{self.requests_url}?wait={int(wait)}', headers={'Authorization': 'Bearer ' + self.key})
        with urllib.request.urlopen(request, context=self.context, timeout=wait + 10) as response:
            reply = json.loads(response.read(65536))
        refresh = [s for s in reply.get('refresh', []) if isinstance(s, str)]
        live = {s: v for s, v in (reply.get('live') or {}).items() if isinstance(s, str) and isinstance(v, dict)}
        return refresh, live


class Source:
    """A fixed collector: `collect(forced)` returns data for one scope."""

    def __init__(self, collect, interval=30, live_floor=2):
        self.collect, self.interval, self.live_floor = collect, interval, live_floor


class Scheduler:
    """Runs each scope on its own interval and immediately on dashboard request.

    A request can only name a scope already in `sources`; unknown names are
    ignored, so the dashboard can never choose what runs or with what input.
    `live` lets a visible panel shorten one scope's interval until it expires.
    """

    def __init__(self, sources, delivery, log=lambda message: print(message, flush=True), clock=time.monotonic):
        self.sources, self.delivery, self.log, self.clock = sources, delivery, log, clock
        self.events = queue.Queue()

    def listen(self, stop):
        backoff = 5
        while not stop.is_set():
            try:
                self.events.put(('requests',) + self.delivery.requests(20))
                backoff = 5
            except Exception:
                # Older dashboards without the endpoint: keep the timed schedule only.
                stop.wait(backoff)
                backoff = min(backoff * 2, 300)

    def run(self, stop, workers=None):
        due = {scope: 0.0 for scope in self.sources}
        running, again, live_until, live_interval = set(), set(), {}, {}

        def job(scope, forced):
            try:
                self.delivery.push(scope, self.sources[scope].collect(forced))
            except Exception:
                self.log(f'Homebase {scope} unavailable; next poll will retry.')
            finally:
                self.events.put(('done', scope))

        def interval(scope, now):
            source = self.sources[scope]
            if live_until.get(scope, 0) > now:
                return max(source.live_floor, min(source.interval, live_interval[scope]))
            return source.interval

        threading.Thread(target=self.listen, args=(stop,), daemon=True).start()
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers or len(self.sources) + 1) as pool:
            def start(scope, forced):
                running.add(scope)
                pool.submit(job, scope, forced)

            while not stop.is_set():
                now = self.clock()
                for scope in self.sources:
                    if scope not in running and due[scope] <= now:
                        start(scope, False)
                idle = [max(0.05, due[s] - now) for s in self.sources if s not in running]
                try:
                    event = self.events.get(timeout=min(idle + [1.0]))
                except queue.Empty:
                    continue
                now = self.clock()
                if event[0] == 'done':
                    scope = event[1]
                    running.discard(scope)
                    due[scope] = now + interval(scope, now)
                    if scope in again:
                        again.discard(scope)
                        start(scope, True)
                    continue
                _, refresh, live = event
                for scope, spec in live.items():
                    if scope not in self.sources:
                        continue
                    try:
                        live_interval[scope] = float(spec.get('intervalMs', 3000)) / 1000
                        live_until[scope] = now + float(spec.get('ttlMs', 12000)) / 1000
                    except (TypeError, ValueError):
                        continue
                    if scope not in running:
                        due[scope] = min(due[scope], now + interval(scope, now))
                for scope in refresh:
                    if scope not in self.sources:
                        continue
                    if scope in running:
                        again.add(scope)
                    else:
                        start(scope, True)

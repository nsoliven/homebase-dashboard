#!/usr/bin/env python3
"""Local bridge: read-only SSH probes and sanitized agent/provider status."""
import concurrent.futures
import json
import os
import re
import selectors
import signal
import ssl
import subprocess
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
    result = subprocess.run(args, input=input_data, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Probe failed')
    return result.stdout


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

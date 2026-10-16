#!/usr/bin/env python3
"""Read-only GPU and CPU probe for the Homebase compute panel.

The bridge pipes this file to the hypervisor as `python3 -`. It accepts no
arguments or input, runs only the fixed nvidia-smi queries in COMMANDS (argv
lists, never a shell), and reads numeric /proc and /sys files. It never reads
process arguments, environments, or serial numbers. GPU process names are
reduced to the executable's basename.
"""
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

GPU_FIELDS = [
    ('name', 'name'), ('driver_version', 'driver'), ('pstate', 'pstate'),
    ('temperature.gpu', 'temperature'), ('temperature.memory', 'memoryTemperature'),
    ('utilization.gpu', 'utilization'), ('utilization.memory', 'memoryUtilization'),
    ('utilization.encoder', 'encoder'), ('utilization.decoder', 'decoder'),
    ('memory.used', 'memoryUsed'), ('memory.total', 'memoryTotal'),
    ('power.draw', 'powerDraw'), ('power.limit', 'powerLimit'),
    ('clocks.gr', 'coreClock'), ('clocks.mem', 'memoryClock'), ('fan.speed', 'fan'),
]
# Static limits are a separate best-effort query: an unsupported field there
# must not hide the live readings above.
LIMIT_FIELDS = [
    ('clocks.max.gr', 'coreClockMax'), ('clocks.max.mem', 'memoryClockMax'),
    ('power.max_limit', 'powerMaxLimit'), ('pcie.link.gen.current', 'pcieGen'),
    ('pcie.link.width.current', 'pcieWidth'), ('clocks_throttle_reasons.active', 'throttle'),
    ('pcie.link.gen.max', 'pcieGenMax'), ('pcie.link.width.max', 'pcieWidthMax'),
    ('encoder.stats.sessionCount', 'encoderSessions'), ('encoder.stats.averageFps', 'encoderFps'),
    ('encoder.stats.averageLatency', 'encoderLatency'), ('vbios_version', 'vbios'),
]
# vbios_version is a firmware release string shared by every card of the model,
# not a per-device identifier. Serials, UUIDs and PCI bus IDs are never queried.
TEXT_FIELDS = {'name', 'driver', 'pstate', 'vbios'}
COMMANDS = {
    'gpu': ['nvidia-smi', '--query-gpu=' + ','.join(f for f, _ in GPU_FIELDS), '--format=csv,noheader,nounits'],
    'limits': ['nvidia-smi', '--query-gpu=' + ','.join(f for f, _ in LIMIT_FIELDS), '--format=csv,noheader,nounits'],
    'apps': ['nvidia-smi', '--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'],
}
MISSING = {'', 'N/A', '[N/A]', 'Not Supported', '[Not Supported]', 'Unknown', '[Unknown Error]'}


def read(path):
    try:
        return Path(path).read_text().strip()
    except (OSError, ValueError):
        return ''


def run(name):
    result = subprocess.run(COMMANDS[name], capture_output=True, text=True, timeout=6)
    if result.returncode:
        raise RuntimeError('query failed')
    return result.stdout


def value(raw, key=''):
    raw = raw.strip()
    if raw in MISSING:
        return None
    if key in TEXT_FIELDS:
        return raw
    if key == 'throttle':
        try:
            return int(raw, 16)
        except ValueError:
            return None
    try:
        return float(raw)
    except ValueError:
        return None


def parse_gpu(text, fields=GPU_FIELDS):
    line = next((l for l in text.splitlines() if l.strip()), '')
    parts = [p.strip() for p in line.split(',')]
    if len(parts) != len(fields):
        return None
    return {key: value(raw, key) for (_, key), raw in zip(fields, parts)}


def container_of(pid):
    # Proxmox places container processes under /lxc/<vmid>/ in their cgroup path.
    match = re.search(r'(?:^|/)lxc(?:\.payload)?[/.](\d{1,9})(?:/|$)', read(f'/proc/{pid}/cgroup'), re.M)
    return int(match.group(1)) if match else None


def parse_apps(text):
    apps = []
    for line in text.splitlines()[:32]:
        parts = [p.strip() for p in line.split(',')]
        if len(parts) < 3 or not parts[0].isdigit():
            continue
        pid, name, memory = int(parts[0]), ','.join(parts[1:-1]), value(parts[-1])
        apps.append({'pid': pid, 'name': os.path.basename(name)[:60], 'memory': memory, 'container': container_of(pid)})
    return apps


def parse_stat(text):
    total, per_cpu = None, {}
    for line in text.splitlines():
        fields = line.split()
        if not fields or not fields[0].startswith('cpu'):
            continue
        counters = [int(x) for x in fields[1:9]]
        if fields[0] == 'cpu':
            total = counters
        else:
            per_cpu[int(fields[0][3:])] = counters
    return total, per_cpu


def cpu_metrics():
    total, per_cpu = parse_stat(read('/proc/stat'))
    mhz, model, current = {}, None, None
    for line in read('/proc/cpuinfo').splitlines():
        key, _, raw = line.partition(':')
        key = key.strip()
        if key == 'processor':
            current = int(raw)
        elif key == 'model name' and model is None:
            model = raw.strip()
        elif key == 'cpu MHz' and current is not None:
            mhz[current] = float(raw)
    threads = []
    for cpu in sorted(per_cpu):
        base = f'/sys/devices/system/cpu/cpu{cpu}'
        core, ccd = read(f'{base}/topology/core_id'), read(f'{base}/cache/index3/id')
        threads.append({'cpu': cpu, 'core': int(core) if core.isdigit() else None,
                        'ccd': int(ccd) if ccd.isdigit() else None, 'mhz': mhz.get(cpu), 'stat': per_cpu[cpu]})
    load = read('/proc/loadavg').split()
    energy = read('/sys/class/powercap/intel-rapl:0/energy_uj')
    energy_range = read('/sys/class/powercap/intel-rapl:0/max_energy_range_uj')
    return {'model': model, 'stat': total, 'threads': threads,
            'load': [float(x) for x in load[:3]] if len(load) >= 3 else None,
            'energy': int(energy) if energy.isdigit() else None,
            'energyRange': int(energy_range) if energy_range.isdigit() else None}


def board_sensors():
    """k10temp and nct6687 readings with the same identities read-linux.py uses,
    so configured cooling names, roles, and reference speeds apply."""
    fans, temperatures, tctl, ccds, vcore = [], [], None, [], None
    for hw in sorted(Path('/sys/class/hwmon').glob('hwmon*')):
        name = read(hw / 'name')
        if name not in ('k10temp', 'nct6687'):
            continue
        device = str((hw / 'device').resolve() if (hw / 'device').exists() else hw.resolve().parent.parent)
        identity = lambda file: hashlib.sha256(f'{name}:{device}:{file}'.encode()).hexdigest()[:16]
        for path in sorted(hw.glob('temp*_input'), key=lambda p: int(re.search(r'\d+', p.name).group())):
            raw = read(path)
            if not raw.lstrip('-').isdigit():
                continue
            reading = int(raw) / 1000
            label = read(path.with_name(path.name.replace('_input', '_label'))) or path.stem
            if name == 'k10temp':
                if label == 'Tctl':
                    tctl = reading
                elif label.startswith('Tccd') and label[4:].isdigit():
                    ccds.append({'id': int(label[4:]), 'temperature': reading})
            elif 0 < reading < 150:
                temperatures.append({'id': identity(path.name), 'name': label, 'value': reading})
        if name == 'nct6687':
            for path in sorted(hw.glob('fan*_input'), key=lambda p: int(re.search(r'\d+', p.name).group())):
                raw = read(path)
                if not raw.isdigit():
                    continue
                channel = re.search(r'\d+', path.name).group()
                label = read(path.with_name(path.name.replace('_input', '_label')))
                fans.append({'id': identity(path.name), 'name': label or f'Fan channel {channel}',
                             'label': f'{name} / fan{channel}', 'rpm': int(raw)})
            for path in hw.glob('in*_input'):
                if read(path.with_name(path.name.replace('_input', '_label'))) == 'CPU Vcore':
                    raw = read(path)
                    vcore = int(raw) / 1000 if raw.isdigit() else None
    return {'fans': fans, 'temperatures': temperatures, 'tctl': tctl, 'ccds': ccds, 'vcore': vcore,
            'name': ' '.join(x for x in [read('/sys/class/dmi/id/board_vendor'), read('/sys/class/dmi/id/board_name')] if x)}


def collect():
    result = {'gpu': None, 'gpuError': None, 'processes': [], 'cpu': None, 'board': None}
    try:
        result['gpu'] = parse_gpu(run('gpu'))
        if result['gpu'] is None:
            result['gpuError'] = 'unreadable'
    except (OSError, RuntimeError, subprocess.SubprocessError):
        result['gpuError'] = 'unavailable'
    if result['gpu']:
        try:
            result['gpu'].update(parse_gpu(run('limits'), LIMIT_FIELDS) or {})
        except (OSError, RuntimeError, subprocess.SubprocessError):
            pass
        try:
            result['processes'] = parse_apps(run('apps'))
        except (OSError, RuntimeError, subprocess.SubprocessError):
            pass
    result['cpu'] = cpu_metrics()
    result['board'] = board_sensors()
    return result


if __name__ == '__main__':
    print(json.dumps(collect()))

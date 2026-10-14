#!/usr/bin/env python3
"""Read only numeric Linux telemetry; never inspect environments or process args."""
import hashlib
import json
import re
import socket
from pathlib import Path


def read(path):
    try:
        return Path(path).read_text().strip()
    except (OSError, ValueError):
        return ""


def collect():
    memory = {}
    for line in read('/proc/meminfo').splitlines():
        key, value = line.split(':', 1)
        memory[key] = int(value.strip().split()[0]) * 1024
    container = bool(read('/run/systemd/container'))
    pressure = {}
    for kind in ['cpu', 'memory', 'io']:
        path = f'/sys/fs/cgroup/{kind}.pressure' if container else f'/proc/pressure/{kind}'
        values = {}
        for line in read(path).splitlines():
            fields = line.split()
            if fields and fields[0] in ['some', 'full']:
                metrics = dict(x.split('=') for x in fields[1:])
                values[fields[0]] = float(metrics.get('avg60', 0))
        pressure[kind] = values or None
    temperatures = []
    fans = []
    package = None
    for hw in Path('/sys/class/hwmon').glob('hwmon*'):
        name = read(hw / 'name')
        device = str((hw / 'device').resolve() if (hw / 'device').exists() else hw.resolve().parent.parent)
        for path in sorted(hw.glob('fan*_input'), key=lambda p: int(re.search(r'fan(\d+)', p.name)[1])):
            raw = read(path)
            try:
                rpm = int(raw)
            except ValueError:
                continue
            if not 0 <= rpm <= 20000:
                continue
            channel = int(re.search(r'fan(\d+)', path.name)[1])
            label = read(path.with_name(path.name.replace('_input', '_label')))
            identity = hashlib.sha256(f'{name}:{device}:{path.name}'.encode()).hexdigest()[:16]
            fans.append({'id': identity, 'name': label or f'Fan channel {channel}',
                         'label': f'{name} / fan{channel}', 'rpm': rpm})
        for path in hw.glob('temp*_input'):
            value = read(path)
            if not value:
                continue
            value = float(value) / 1000
            if not 0 < value < 150:
                continue
            label = read(path.with_name(path.name.replace('_input', '_label'))) or path.stem.replace('_input', '')
            device=str((hw/'device').resolve() if (hw/'device').exists() else hw.resolve().parent.parent); identity=hashlib.sha256(f'{name}:{device}:{path.name}'.encode()).hexdigest()[:16]
            group={'k10temp':'CPU','coretemp':'CPU','spd5118':'Memory','nvme':'Storage','amdgpu':'GPU'}.get(name,'Network' if name.startswith(('r8169','igc','iwlwifi')) else 'Other')
            friendly={'Tctl':'CPU package','Tdie':'CPU die','edge':'GPU edge','Composite':'Drive composite'}.get(label,label)
            if group=='Memory':friendly='Memory module'
            elif group=='Network':friendly='Network controller'
            elif name=='nvme' and label.startswith('Sensor '):friendly='Drive '+label.lower()
            elif label.startswith('Tccd'):friendly='CPU chiplet '+label[4:]
            temperatures.append({'id':identity,'name':friendly,'group':group,'label':f'{name} / {label}','value':value})
            if name == 'k10temp' and label in ['Tctl', 'Tdie'] or name == 'coretemp' and label.startswith('Package'):
                package = max(package or 0, value)
    disk_read = disk_write = 0
    for line in read('/proc/diskstats').splitlines():
        f = line.split()
        if len(f) > 9 and re.fullmatch(r'(nvme\d+n\d+|sd[a-z]+)', f[2]):
            disk_read += int(f[5]) * 512
            disk_write += int(f[9]) * 512
    os_name = next((line.split('=', 1)[1].strip('"') for line in read('/etc/os-release').splitlines() if line.startswith('PRETTY_NAME=')), 'Linux')
    return {
        'name': socket.gethostname(), 'os': os_name,
        'total': memory.get('MemTotal'), 'available': memory.get('MemAvailable'),
        'swapTotal': memory.get('SwapTotal'), 'swapUsed': memory.get('SwapTotal', 0) - memory.get('SwapFree', 0),
        'pressure': pressure, 'temperatures': temperatures, 'fans': fans, 'cpuTemperature': package,
        'diskReadBytes': disk_read, 'diskWriteBytes': disk_write,
    }


if __name__ == '__main__':
    print(json.dumps(collect()))

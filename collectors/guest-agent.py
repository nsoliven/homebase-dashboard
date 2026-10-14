#!/usr/bin/env python3
"""Push guest measurements over pinned HTTPS; accepts no inbound commands."""
import json
import os
import ssl
import time
import urllib.request
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec

spec = spec_from_file_location('linux_metrics', Path(__file__).with_name('read-linux.py'))
metrics = module_from_spec(spec)
spec.loader.exec_module(metrics)


def main():
    config = json.loads(Path(os.environ.get('HOMEBASE_COLLECTOR_CONFIG', '/etc/homebase-collector/config.json')).read_text())
    context = ssl.create_default_context(cafile=config['caFile'])
    payload = {'scope': f"guest:{config['guestId']}", 'observedAt': int(time.time() * 1000), 'data': metrics.collect()}
    request = urllib.request.Request(config['endpoint'], data=json.dumps(payload).encode(), headers={'Authorization': f"Bearer {config['key']}", 'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, context=context, timeout=8) as response:
        if response.status != 200:
            raise RuntimeError('Collector not accepted')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Homebase telemetry delivery failed; retrying on the next timer run.')
        raise SystemExit(1)

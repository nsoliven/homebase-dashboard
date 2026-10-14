#!/usr/bin/env python3
"""Preserve the user's status line and cache only reported quota numbers."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

config_path = Path(os.environ.get('HOMEBASE_BRIDGE_CONFIG', Path.home() / '.config/homebase/bridge.json'))
config = json.loads(config_path.read_text())
raw = sys.stdin.read(1_000_000)
try:
    payload = json.loads(raw)
    rates = payload.get('rate_limits') or {}
    windows = []
    for key, label, duration in [('five_hour', '5-hour window', 300), ('seven_day', 'Weekly window', 10080)]:
        value = rates.get(key) or {}
        used, reset = value.get('used_percentage'), value.get('resets_at')
        if isinstance(used, (int, float)) and isinstance(reset, (int, float)):
            windows.append({'id': key, 'label': label, 'durationMins': duration, 'usedPercent': used, 'resetsAt': reset})
    if windows:
        path = config_path.with_name('claude-usage.json')
        tmp = path.with_suffix('.tmp')
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump({'observedAt': int(time.time() * 1000), 'windows': windows}, output)
        tmp.replace(path)
except Exception:
    pass
original = config.get('originalStatusLine')
if original:
    try:
        result = subprocess.run(original, shell=True, input=raw, text=True, capture_output=True, timeout=8)
        sys.stdout.write(result.stdout)
    except Exception:
        pass

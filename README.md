# Homebase

A private infrastructure dashboard with sampled metric history, thermal detail,
T3 session navigation, account usage, and an application launcher.

This is the standalone application repository. Infrastructure provisioning,
operator deployment tooling, and production configuration are maintained separately.
Node.js 24 is required for the backend's built-in SQLite support.

```sh
npm ci
npm run build
npm test
```

To explore the interface without infrastructure or credentials, build first and
run `npm run demo`, then open `http://127.0.0.1:4320`. This separate loopback-only
server uses synthetic data, disables outgoing application links, and never loads
production configuration. It is not the production backend.

For production, set `HOMEBASE_CONFIG` to your protected external configuration
file and run `npm start`. Preserve the authenticated HTTPS deployment; the demo
server must never replace it.

## Screenshots

These captures show the real interface with **sample data**. Names, accounts,
measurements, and application entries are illustrative; no production catalogue
or credentials were used.

![Homebase overview with compute, account usage, guests, and T3 sessions](docs/screenshots/overview.png)

![Thermal detail with history, summary statistics, and grouped sensors](docs/screenshots/temperatures.png)

![Application launcher with synthetic catalogue entries](docs/screenshots/applications.png)

![Fan RPM history and a qualitative sound estimate using sample data](docs/screenshots/cooling.png)

![Correct quota percentages with current and historical sample account readings](docs/screenshots/quotas.png)

![GPU and CPU showcase at idle, sample data](docs/screenshots/compute-idle.png)

![GPU and CPU showcase under a simulated load, sample data](docs/screenshots/compute-load.png)

![A details modal while a forced refresh is running, sample data](docs/screenshots/refresh-modal.png)

## Force refresh

Every card and details modal has a refresh control. `POST /api/refresh/<source>`
(session + same-origin CSRF) accepts only known source IDs:

- `proxmox` re-reads the Proxmox API now.
- `proxy` calls CLI Proxy's fixed loopback `.../routing/quota/refresh` route,
  which polls each account's usage, then bypasses the 15-second cache.
- Collector scopes (`host`, `router`, `agents`, `quotas`, `compute`, `guest:<id>`)
  are handed to the authenticated bridge through a long-poll at
  `GET /api/ingest/requests`. The reply only names scopes the collector is
  already allowed to send; the bridge maps each one to its own fixed collector.
  The route waits up to 25 seconds for the new reading.

Each source can be refreshed once per 10 seconds (30 seconds for provider
quota sources). Passive sources (the Claude status line), unconnected sources,
and scopes whose bridge is not listening are shown disabled with the reason.

## GPU & CPU showcase

`collectors/read-compute.py` is piped to the hypervisor by the bridge as
`python3 -`. It runs only fixed `nvidia-smi --query-*` argv lists (no shell)
and reads numeric `/proc` and hwmon files; process names are reduced to the
executable basename. Board fan and temperature IDs match `read-linux.py`, so
`cooling.channels` roles and reference speeds apply. Per-thread load and
package power (RAPL) are differences between consecutive readings; the first
reading after a gap shows them as measuring. While the panel is visible the
browser polls `/api/compute?live=1`, which asks the bridge for 3-second
collection for 12 seconds at a time; otherwise the bridge collects every 30
seconds. Fan spin follows reported fan duty (GPU) or RPM (board), and glows
follow load and temperature. Reduced-motion users get a static illustration.

## Data boundaries

Runtime configuration is supplied by `HOMEBASE_CONFIG` outside this repository.
Optional local icon files are supplied through `iconsDirectory`, catalogue
`iconFile` entries, and a `branding` map. Real logos and mappings stay in private
storage. Authenticated icon routes expose configured IDs only, reject active
image formats and path escapes, and never fetch remote images in the browser.
Application catalogues, service names, private addresses, account identities,
and credentials must stay in private runtime files. Do not add a real catalogue
or credential example here. Tests use synthetic application and account names.

The authenticated `/api/integrations` endpoint exposes only selected account
quota fields and the operator's configured application catalogue. Management
credentials remain server-side. Application links use IDs resolved from that
catalogue; arbitrary redirect destinations are rejected.

The CLI Proxy pacing report uses fractional 5-hour utilization and normalized
account-week capacity (`left / kappa`). Homebase converts these to percentages;
it never treats `0.99` remaining as `0.99%`. Quota freshness uses each account's
provider-observation time, not the generated report timestamp. After ten minutes
a reading is historical. Passed reset times and rolled-forward pacing projections
wait for a new observation; they never imply a freshly replenished quota.

Metric averages, lows, peaks, and nearest-rank P99 are calculated from original
finite samples. Chart downsampling does not change those summaries. Per-sensor
history begins when that sensor starts reporting; missing prior measurements
are never generated. Summary sample counts and observation coverage are shown.

Cooling details show read-only fan tachometer RPM with the same historical
summaries. Zero RPM can indicate an unused header or a stopped fan; it is not
treated as proof of failure. Missing readings remain unavailable.

Optional `cooling.channels` in the external runtime configuration assigns sensor
IDs a name, a `fan` or `pump` role, a `maxRpm` reference, and a `confirmed` flag.
Unassigned channels and pumps are excluded from the airflow estimate. Real
sensor mappings and hardware profiles belong outside this repository.

Estimated sound is a qualitative heuristic based on fan RPM divided by its
configured reference speed: below 35% is quiet, below 55% light airflow, below
80% audible airflow, and otherwise strong airflow. It is not measured dBA and
does not account for case acoustics, room noise, listener distance, or pump tone.
Inferred channel assignments remain visibly marked.

The non-X3D Ryzen 7000 X models use a 95°C thermal-limit reference. Near-limit
temperature under load is shown as boost context; high temperature at light
load or readings more than 2°C above the reference request a check. The 2°C
margin is a dashboard alert heuristic, not a revised hardware safety limit.
See [AMD's thermal explanation](https://community.amd.com/t5/gaming/ryzen-7000-series-processors-let-s-talk-about-power-temperature/ba-p/554629).

# Grafana Alerts for Omarchy

Firing Grafana alerts in the Omarchy bar.

- The bell turns red when something critical fires and shows how many alerts need attention.
- Click it for the list of alerts with severity, duration, summary and labels.
- A desktop notification fires for every new alert.
- Silence an alert for an hour, or open it in Grafana, with one click or one key.
- **Demo mode** works without a Grafana instance and runs until you set a URL.

## Install

```bash
omarchy plugin add https://github.com/dDan4a/omarchy-grafana-alerts.git --enable --yes
```

The plugin starts in demo mode. Set it up to connect to your Grafana:

1. Create a **service account** in Grafana (Administration → Service accounts) with the Viewer role.
   To silence alerts from the bar, the account also needs `alert.silences:create`.
2. Put its token in a file that only you can read:
   ```bash
   mkdir -p ~/.config/grafana-alerts
   install -m 600 /dev/stdin ~/.config/grafana-alerts/token <<< 'glsa_...'
   ```
3. Set **Grafana URL** in the widget settings (bar settings → Grafana Alerts), for example `https://grafana.example.com`.

The token never goes into `shell.json`. The plugin reads it inside `sh` and passes it to `curl` on stdin,
so it doesn't appear in the process list either.

## Keys

With the panel open:

| Key | Action |
|---|---|
| `↑` / `↓` | Select an alert |
| `Enter` | Open the selected alert in Grafana |
| `s` | Silence the selected alert for 1 hour |
| `r` | Refresh now |

You can also drive it from the command line:

```bash
omarchy-shell shell toggle dan4a.grafana-alerts '{}'   # opens on the focused monitor, good for a keybinding
omarchy-shell dan4a.grafana-alerts refresh
```

## How it works

The plugin polls `GET /api/alertmanager/grafana/api/v2/alerts?active=true&inhibited=false`, which returns Grafana-managed alerts.
Severity comes from the `severity` label: `critical`/`high`, `warning`, and everything else counts as info.
A silence is created with `POST /api/alertmanager/grafana/api/v2/silences` and matches all labels of that one alert.

Polling, notifications and silences live in a single `service` (`AlertSource.qml`, `keepLoaded`). The bar widget on every
monitor reads that one instance through `bar.shell.serviceFor(...)`. With two monitors you therefore get one poll and one
notification per alert, not two.

## Development

```bash
node tests/alerts.test.js                 # pure logic: parsing, ordering, durations, silences, demo data
ln -s "$PWD" ~/.config/omarchy/plugins/dan4a.grafana-alerts
omarchy plugin enable dan4a.grafana-alerts
```

The shell does not hot-reload code reached through a symlink. Run `omarchy restart shell` after changes.

## Roadmap

- A sparkline for the alert's query with its threshold, drawn from `/api/ds/query`
- Grafana OnCall: who is on call, and your next shift

## License

MIT

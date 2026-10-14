# Grafana Alerts for Omarchy

Firing alerts from Grafana and Prometheus Alertmanager in the Omarchy bar.

- The bell turns red when something critical fires and shows how many alerts need attention, across all instances.
- Click it for the list of alerts with severity, duration, summary and labels, grouped by instance.
- **Several instances**: prod and staging Grafana, a plain Alertmanager. One that is down is marked in the panel; the others keep working.
- A desktop notification fires for every new alert.
- **Do not disturb** mutes those notifications for an hour or until you turn it off. It is local: nothing is created in
  Grafana or Alertmanager, alerts keep updating and counting in the badge, and the bell in the bar is crossed out.
- Silence an alert for an hour, or open its source, with one click or one key. Both go to the instance the alert came from.
- **Pending** alerts (the condition holds, but the rule's `for` has not run out yet) get their own section with how long they
  have been pending. They don't count in the badge and don't notify; once one fires it moves to the main list. Grafana only.
- Active silences are listed at the bottom of the panel: what they match, who set them, why, and how long they have left. Expire one early with one click or `u`.
- **Grafana OnCall / IRM**: who is on call now in each schedule and until when, and your next two shifts. While you are
  on call the bell in the bar turns the accent color. Off unless you turn it on for an instance.
- **Demo mode** works without any server and runs until you configure one.

## Install

```bash
omarchy plugin add https://github.com/dDan4a/omarchy-grafana-alerts.git --enable --yes
```

The plugin starts in demo mode with two fake instances. Set it up to connect to your Grafana:

1. Create a **service account** in Grafana (Administration → Service accounts) with the Viewer role.
   To silence alerts from the bar, the account also needs `alert.silences:create`; to expire silences, `alert.silences:write`.
   Listing silences needs only `alert.silences:read`, and pending alerts need `alert.rules:read` on the rule folders: Viewer has both.
2. Put its token in a file that only you can read:
   ```bash
   mkdir -p ~/.config/grafana-alerts
   install -m 600 /dev/stdin ~/.config/grafana-alerts/token <<< 'glsa_...'
   ```
3. Set **Grafana URL** in the widget settings (bar settings → Grafana Alerts), for example `https://grafana.example.com`.

That is enough for one Grafana. For several, or for Alertmanager, list them in an instances file.

### Several instances and Alertmanager

Create `~/.config/grafana-alerts/instances.json` (the path is the **Instances file** setting):

```json
[
  { "name": "prod", "type": "grafana", "url": "https://grafana.example.com", "tokenFile": "~/.config/grafana-alerts/prod.token" },
  { "name": "staging", "type": "grafana", "url": "https://grafana.staging.example.com", "tokenFile": "~/.config/grafana-alerts/staging.token" },
  { "name": "infra", "type": "alertmanager", "url": "http://alertmanager.internal:9093",
    "matchers": ["team=backend", "severity=~critical|warning"] }
]
```

| Field | |
|---|---|
| `name` | Shown in the panel and in notifications. Must be unique. |
| `type` | `grafana` (Grafana-managed alerts) or `alertmanager` (Prometheus Alertmanager). Default `grafana`. |
| `url` | Base URL. Grafana: `https://grafana.example.com`; Alertmanager: `http://host:9093`. |
| `tokenFile` | Optional for Alertmanager. A file with a bearer token; without it no `Authorization` header is sent. |
| `oncall` | Optional, Grafana only. `true`, or `{ "user": "you@example.com" }` to see your own shifts. See [On-call](#on-call). |
| `matchers` | Optional. Show only alerts whose labels match all of these, in Alertmanager syntax: `=`, `!=`, `=~`, `!~` (regexes are anchored). Values may be quoted: `env!="dev"`. |

When the file exists it wins and the Grafana URL setting is ignored. When it doesn't, a set Grafana URL counts as one
instance named `default`, so existing setups keep working. With neither, the plugin runs in demo mode.
The file is re-read on every refresh, so edits apply without restarting the shell. A malformed file shows its error in
the panel instead of falling back to demo mode.

Matchers are applied by the server, so silenced counts and notifications only cover what you see. The panel shows an
instance's filter next to its name. In demo mode staging is filtered by `queue=~emails|billing`, and prod has a few
pending alerts; "Payment latency p99" goes from pending to firing and back every 2 minutes.

Alertmanager has no pending alerts (they live in Prometheus, before they reach it), so `alertmanager` instances have no
Pending section. For Grafana the matchers are applied to pending alerts locally.

### On-call

Turn on Grafana OnCall (Grafana Cloud IRM, or OnCall OSS) for a Grafana instance:

```json
{ "name": "prod", "url": "https://example.grafana.net", "tokenFile": "~/.config/grafana-alerts/prod.token",
  "oncall": { "user": "you@example.com" } }
```

| `oncall` field | |
|---|---|
| `user` | Your OnCall email or username. Optional: without it the panel shows who is on call, but not your shifts, and the bar does not change color. A service account token has no user of its own, so the plugin cannot guess it. |
| `url` | Optional. The OnCall API URL (IRM → Settings → Admin & API). Found automatically from the plugin settings in Grafana, so set it only when that fails. |

The same service account token is used: the OnCall API accepts Grafana service account tokens. The account needs
`grafana-irm-app.schedules:read` (`grafana-oncall-app.schedules:read` for OnCall OSS), which the Viewer role has in IRM's
default roles, and read access to the IRM plugin's settings, which Viewer also has.

The panel gets an **On-call** section: every schedule with who is on call now, until when and how long is left, then
your next two shifts in the next 14 days. If OnCall cannot be loaded, the section says so and alerts are not affected.
Without `oncall` on any instance there is no section at all. In demo mode you are on call in prod's Primary schedule.

Alertmanager behind basic auth or mTLS is not supported yet.

The token never goes into `shell.json`. The plugin reads it inside `sh` and passes it to `curl` on stdin,
so it doesn't appear in the process list either.

## Keys

With the panel open:

| Key | Action |
|---|---|
| `↑` / `↓` | Select an alert |
| `Enter` | Open the selected alert's source (its `generatorURL`) |
| `s` | Silence the selected alert for 1 hour |
| `u` | Expire the selected silence |
| `d` | Do not disturb for 1 hour; turns it off when it is on |
| `D` | Do not disturb until turned off; turns it off when it is on |
| `r` | Refresh now |

You can also drive it from the command line:

```bash
omarchy-shell shell toggle dan4a.grafana-alerts '{}'   # opens on the focused monitor, good for a keybinding
omarchy-shell dan4a.grafana-alerts refresh
omarchy-shell dan4a.grafana-alerts dnd 60      # do not disturb for 60 minutes, 0 = until turned off; on when off, off when on
```

The panel shows how long do not disturb has left. Alerts that fire during it are not announced afterwards: they are
already in the list. The state is kept in `~/.local/state/dan4a.grafana-alerts/dnd` (the end time in ms, `-1` for
"until turned off"), so it survives `omarchy restart shell`.

## How it works

Grafana and Alertmanager speak the same Alertmanager API v2, under a different prefix: `/api/alertmanager/grafana/api/v2`
for Grafana, `/api/v2` for Alertmanager. Every instance is polled in parallel with
`GET <prefix>/alerts?active=true&inhibited=false`, plus one URL-encoded `filter=` per matcher; a slow or dead one does not hold up the others.
Severity comes from the `severity` label: `critical`/`high`, `warning`, and everything else counts as info.
A silence is created with `POST <prefix>/silences` on the alert's own instance and matches all labels of that one alert.
Silences are loaded with `GET <prefix>/silences` (only `active` ones are shown) and expired with `DELETE <prefix>/silence/{id}`.
A failed silences request is shown in the Silences header and leaves the alerts alone.
Pending alerts of a Grafana come from its Prometheus-compatible rules API,
`GET /api/prometheus/grafana/api/v1/rules?state=pending&state=firing` (older Grafana ignores `state=` and returns every rule):
every alert instance in state `Pending`, with its `activeAt`. A failed request is shown in the Pending header only.
On-call comes from the OnCall API, `GET <oncall>/api/v1/schedules/` and, for each schedule,
`GET <oncall>/api/v1/schedules/{id}/final_shifts?start_date=…&end_date=…` from yesterday to 14 days ahead, with
`Authorization: Bearer <token>` and `X-Grafana-URL: <instance url>`. The OnCall URL is `jsonData.onCallApiUrl` from
`GET /api/plugins/grafana-irm-app/settings` (then `grafana-oncall-app`). Back-to-back shifts of one person are merged,
so "until" is the end of the whole stretch. This needs `jq`, which Omarchy installs.
Alerts are told apart by instance and fingerprint, so the same alert in prod and staging notifies twice.

Polling, notifications and silences live in a single `service` (`AlertSource.qml`, `keepLoaded`). The bar widget on every
monitor reads that one instance through `bar.shell.serviceFor(...)`. With two monitors you therefore get one poll and one
notification per alert, not two.

## Development

```bash
node tests/alerts.test.js                 # pure logic: instances, matchers, parsing, ordering, grouping, silences, pending, on-call, demo data
ln -s "$PWD" ~/.config/omarchy/plugins/dan4a.grafana-alerts
omarchy plugin enable dan4a.grafana-alerts
```

The shell does not hot-reload code reached through a symlink. Run `omarchy restart shell` after changes.

## Roadmap

- A sparkline for the alert's query with its threshold, drawn from `/api/ds/query`

## License

MIT

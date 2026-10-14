.pragma library

// Pure helpers over Alertmanager API v2 alerts, served by Grafana (/api/alertmanager/grafana/api/v2)
// or by a Prometheus Alertmanager (/api/v2). No QML types here, so tests run under node.

var SEVERITY_RANK = { critical: 0, warning: 1, info: 2 }

function severityOf(labels) {
  var s = String((labels && labels.severity) || "").toLowerCase()
  if (s === "critical" || s === "high" || s === "page" || s === "p1") return "critical"
  if (s === "warning" || s === "warn" || s === "medium" || s === "p2") return "warning"
  return "info"
}

// Labels that identify where the alert fires; the rest are Grafana bookkeeping.
var HIDDEN_LABELS = ["alertname", "severity", "grafana_folder", "__alert_rule_uid__", "__name__"]

function displayLabels(labels) {
  var out = []
  for (var key in labels) {
    if (HIDDEN_LABELS.indexOf(key) === -1) out.push(key + "=" + labels[key])
  }
  out.sort()
  return out
}

// One Alertmanager label matcher: `team=backend`, `severity=~critical|warning`, `env!="dev"`.
// Returns { name, op, value }; throws on anything else, so a typo shows up as a config error
// instead of silently matching nothing.
var MATCHER_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*(.*?)\s*$/

function parseMatcher(text) {
  var m = MATCHER_RE.exec(String(text))
  if (!m) throw new Error("bad matcher " + JSON.stringify(text) + ", expected label=value, !=, =~ or !~")
  var value = m[3]
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    try { value = JSON.parse(value) } catch (e) { throw new Error("bad quoting in matcher " + text) }
  }
  if (m[2] === "=~" || m[2] === "!~") {
    try { new RegExp(value) } catch (e) { throw new Error("bad regex in matcher " + text) }
  }
  return { name: m[1], op: m[2], value: value }
}

// Canonical form with a quoted value, which every Alertmanager matcher parser accepts.
function matcherText(m) {
  return m.name + m.op + '"' + m.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

// Same semantics as Alertmanager: regexes are anchored, a missing label is "".
function matchesAll(labels, matchers) {
  for (var i = 0; i < (matchers || []).length; i++) {
    var m = matchers[i]
    var v = String((labels && labels[m.name]) || "")
    var hit = m.op === "=" || m.op === "!=" ? v === m.value : new RegExp("^(?:" + m.value + ")$").test(v)
    if (hit !== (m.op === "=" || m.op === "=~")) return false
  }
  return true
}

// Instances come from instances.json. Without that file a configured grafanaUrl is one instance
// named "default"; with neither, the result is empty and the service runs in demo mode.
// Throws on malformed JSON or entries, so the panel can say what is wrong with the file.
function parseInstances(text, legacyUrl, legacyTokenFile) {
  if (text === null || text === undefined) {
    var url = String(legacyUrl || "").trim()
    if (url === "") return []
    return [{ name: "default", type: "grafana", url: url.replace(/\/+$/, ""), tokenFile: String(legacyTokenFile || ""), matchers: [] }]
  }
  var list = JSON.parse(text)
  if (!Array.isArray(list)) throw new Error("expected a JSON array of instances")
  var out = [], seen = {}
  for (var i = 0; i < list.length; i++) {
    var e = list[i] || {}
    var name = String(e.name || "").trim()
    var type = String(e.type || "grafana")
    var base = String(e.url || "").trim().replace(/\/+$/, "")
    if (name === "" || base === "") throw new Error("instance " + (i + 1) + " needs a name and a url")
    if (type !== "grafana" && type !== "alertmanager") throw new Error(name + ": type must be grafana or alertmanager")
    if (seen[name]) throw new Error("duplicate instance name " + name)
    seen[name] = true
    if (e.matchers !== undefined && !Array.isArray(e.matchers)) throw new Error(name + ": matchers must be a list of strings")
    var matchers = []
    try {
      for (var k = 0; k < (e.matchers || []).length; k++) matchers.push(parseMatcher(e.matchers[k]))
    } catch (err) {
      throw new Error(name + ": " + err.message)
    }
    out.push({ name: name, type: type, url: base, tokenFile: String(e.tokenFile || ""), matchers: matchers })
  }
  return out
}

function apiBase(instance) {
  return instance.url + (instance.type === "alertmanager" ? "/api/v2" : "/api/alertmanager/grafana/api/v2")
}

// GET URL for the active alerts of an instance; each matcher becomes its own filter= parameter.
function alertsUrl(instance) {
  var url = apiBase(instance) + "/alerts?active=true&inhibited=false"
  var matchers = instance.matchers || []
  for (var i = 0; i < matchers.length; i++) url += "&filter=" + encodeURIComponent(matcherText(matchers[i]))
  return url
}

// Turns the raw API array of one instance into rows for the UI, most urgent and then oldest first.
// `key` is unique across instances: the same fingerprint can fire in prod and in staging.
function normalize(raw, instance) {
  if (!Array.isArray(raw)) return []
  var rows = []
  for (var i = 0; i < raw.length; i++) {
    var a = raw[i] || {}
    var labels = a.labels || {}
    var annotations = a.annotations || {}
    var state = (a.status && a.status.state) || "active"
    var fingerprint = String(a.fingerprint || labels.alertname + JSON.stringify(labels))
    rows.push({
      instance: String(instance || ""),
      key: String(instance || "") + "/" + fingerprint,
      fingerprint: fingerprint,
      name: String(labels.alertname || "Unnamed alert"),
      severity: severityOf(labels),
      summary: String(annotations.summary || annotations.description || ""),
      labels: labels,
      labelText: displayLabels(labels).join("  "),
      startsAt: String(a.startsAt || ""),
      url: String(a.generatorURL || ""),
      silenced: state === "suppressed"
    })
  }
  rows.sort(function(x, y) {
    if (x.silenced !== y.silenced) return x.silenced ? 1 : -1
    var r = SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]
    return r !== 0 ? r : (x.startsAt < y.startsAt ? -1 : x.startsAt > y.startsAt ? 1 : 0)
  })
  return rows
}

// Counts only alerts that need attention: silenced ones are already handled.
function summarize(rows) {
  var s = { critical: 0, warning: 0, info: 0, silenced: 0, total: 0 }
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].silenced) { s.silenced++; continue }
    s[rows[i].severity]++
    s.total++
  }
  return s
}

// Rows whose key was not in the previous poll. `known` is null on the first poll,
// so startup does not replay every already-firing alert as a notification.
function newAlerts(rows, known) {
  if (known === null || known === undefined) return []
  return rows.filter(function(r) { return !r.silenced && !known[r.key] })
}

function fingerprints(rows) {
  var set = {}
  for (var i = 0; i < rows.length; i++) set[rows[i].key] = true
  return set
}

// Do not disturb: `until` is 0 (off), DND_FOREVER (until turned off) or the end time in ms.
var DND_FOREVER = -1

function dndActive(until, nowMs) { return until === DND_FOREVER || until > nowMs }

// Any press while active turns it off; otherwise on for `minutes`, or until turned off when minutes is 0.
function dndToggle(until, nowMs, minutes) {
  if (dndActive(until, nowMs)) return 0
  return minutes > 0 ? nowMs + minutes * 60000 : DND_FOREVER
}

function dndText(until, nowMs) {
  if (!dndActive(until, nowMs)) return ""
  return until === DND_FOREVER ? "until turned off" : duration(new Date(nowMs).toISOString(), until) + " left"
}

// The saved file holds just the number; anything else counts as off.
function parseDnd(text) {
  var n = Number(String(text || "").trim())
  return isFinite(n) && (n === DND_FOREVER || n > 0) ? n : 0
}

// What to announce for this poll. DND drops the notifications but the caller still records `known`,
// so alerts that fired during DND are not replayed when it ends.
function toNotify(rows, known, notify, dndUntil, nowMs) {
  return notify && !dndActive(dndUntil, nowMs) ? newAlerts(rows, known) : []
}

// Pending alerts come from Grafana's Prometheus-compatible rules API; Alertmanager knows nothing about them.
// `state=` keeps rules with pending (or firing, which may also have pending instances) alerts; older Grafana ignores it.
function rulesUrl(instance) {
  return instance.type === "grafana" ? instance.url + "/api/prometheus/grafana/api/v1/rules?state=pending&state=firing" : ""
}

// Pending alert instances of one Grafana as panel rows, the ones pending longest first. The instance's matchers
// are applied here, since the rules API has no filter= like the alerts API. Rows look like normalize() rows,
// with `isPending` and `startsAt` = activeAt.
function normalizePending(raw, instance) {
  var groups = (raw && raw.data && raw.data.groups) || []
  var rows = []
  for (var g = 0; g < groups.length; g++) {
    var rules = (groups[g] && groups[g].rules) || []
    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r] || {}
      var alerts = rule.alerts || []
      for (var i = 0; i < alerts.length; i++) {
        var a = alerts[i] || {}
        var labels = a.labels || {}
        if (String(a.state || "").toLowerCase() !== "pending" || !matchesAll(labels, instance.matchers)) continue
        var annotations = a.annotations || rule.annotations || {}
        rows.push({
          isPending: true,
          instance: instance.name,
          key: "pending:" + instance.name + "/" + JSON.stringify(labels),
          name: String(labels.alertname || rule.name || "Unnamed alert"),
          severity: severityOf(labels),
          summary: String(annotations.summary || annotations.description || ""),
          labels: labels,
          labelText: displayLabels(labels).join("  "),
          // Go timestamps carry nanoseconds, which QML's Date.parse may reject.
          startsAt: String(a.activeAt || "").replace(/(\.\d{3})\d+/, "$1"),
          url: rule.uid ? instance.url + "/alerting/grafana/" + rule.uid + "/view" : "",
          silenced: false
        })
      }
    }
  }
  rows.sort(function(x, y) { return x.startsAt < y.startsAt ? -1 : x.startsAt > y.startsAt ? 1 : 0 })
  return rows
}

// Rows of every instance for one trailing panel section plus the instances whose request failed.
function section(instances, byInstance, errorsByInstance) {
  var list = [], failed = []
  for (var i = 0; i < instances.length; i++) {
    var n = instances[i].name
    list = list.concat((byInstance || {})[n] || [])
    var e = (errorsByInstance || {})[n]
    if (e) failed.push(instances.length > 1 ? n + ": " + e : e)
  }
  return { list: list, error: failed.join("; ") }
}

// The panel list: with several instances each group gets a header row (alert count or the error),
// so an unreachable instance shows up in place instead of hiding the others.
// Pending alerts and then active silences follow, each under its own header, which also carries any instance
// whose request for them failed.
function panelItems(instances, rowsByInstance, errors, silencesByInstance, silenceErrors, pendingByInstance, pendingErrors) {
  var items = []
  for (var i = 0; i < instances.length; i++) {
    var name = instances[i].name
    var rows = rowsByInstance[name] || []
    if (instances.length > 1)
      items.push({ header: true, key: "#" + name, instance: name, error: errors[name] || "", count: summarize(rows).total,
        filter: (instances[i].matchers || []).map(matcherText).join(", ") })
    items = items.concat(rows)
  }
  var pending = section(instances, pendingByInstance, pendingErrors)
  if (pending.list.length > 0 || pending.error !== "")
    items.push({ header: true, pending: true, key: "#pending", count: pending.list.length, error: pending.error })
  items = items.concat(pending.list)
  var silences = section(instances, silencesByInstance, silenceErrors)
  if (silences.list.length > 0 || silences.error !== "")
    items.push({ header: true, silences: true, key: "#silences", count: silences.list.length, error: silences.error })
  return items.concat(silences.list)
}

// Next selectable index from `from` moving by `dy`, skipping headers; stays put at the ends.
function step(items, from, dy) {
  var dir = dy < 0 ? -1 : 1
  for (var i = from + dir; i >= 0 && i < items.length; i += dir) {
    if (!items[i].header) return i
  }
  return from
}

function firstRow(items) {
  for (var i = 0; i < items.length; i++) if (!items[i].header) return i
  return -1
}

function duration(startsAt, nowMs) {
  var start = Date.parse(startsAt)
  if (!isFinite(start)) return ""
  var sec = Math.max(0, Math.floor((nowMs - start) / 1000))
  if (sec < 60) return sec + "s"
  var min = Math.floor(sec / 60)
  if (min < 60) return min + "m"
  var h = Math.floor(min / 60)
  if (h < 24) return h + "h " + (min % 60) + "m"
  return Math.floor(h / 24) + "d " + (h % 24) + "h"
}

// The other way round: how long until `endsAt`.
function remaining(endsAt, nowMs) {
  var end = Date.parse(endsAt)
  return isFinite(end) ? duration(new Date(nowMs).toISOString(), end) : ""
}

function silencesUrl(instance) { return apiBase(instance) + "/silences" }
function expireUrl(instance, id) { return apiBase(instance) + "/silence/" + encodeURIComponent(id) }

// API matcher { name, value, isRegex, isEqual } in the same text form as the instance filters.
function silenceMatcherText(m) {
  var eq = m.isEqual !== false
  return matcherText({ name: String(m.name), op: m.isRegex ? (eq ? "=~" : "!~") : (eq ? "=" : "!="), value: String(m.value) })
}

// Active silences of one instance for the panel, the ones that end first on top.
// The API also returns pending and expired silences; those are dropped.
function normalizeSilences(raw, instance) {
  if (!Array.isArray(raw)) return []
  var out = []
  for (var i = 0; i < raw.length; i++) {
    var s = raw[i] || {}
    if (!s.status || s.status.state !== "active") continue
    out.push({
      isSilence: true,
      instance: String(instance || ""),
      key: "silence:" + instance + "/" + s.id,
      id: String(s.id),
      matcherText: (s.matchers || []).map(silenceMatcherText).join(", "),
      createdBy: String(s.createdBy || ""),
      comment: String(s.comment || ""),
      endsAt: String(s.endsAt || "")
    })
  }
  out.sort(function(x, y) { return x.endsAt < y.endsAt ? -1 : x.endsAt > y.endsAt ? 1 : 0 })
  return out
}

// Silence body for POST <apiBase>/silences matching this exact alert.
function silenceBody(row, minutes, nowMs, author) {
  var matchers = []
  for (var key in row.labels) {
    matchers.push({ name: key, value: String(row.labels[key]), isRegex: false, isEqual: true })
  }
  return {
    matchers: matchers,
    startsAt: new Date(nowMs).toISOString(),
    endsAt: new Date(nowMs + minutes * 60000).toISOString(),
    createdBy: author || "omarchy-grafana-alerts",
    comment: "Silenced from the Omarchy bar"
  }
}

var DEMO_INSTANCES = [
  { name: "prod", type: "grafana", url: "https://grafana.example.com", tokenFile: "", matchers: [] },
  { name: "staging", type: "alertmanager", url: "https://alertmanager.staging.example.com", tokenFile: "",
    matchers: [parseMatcher("queue=~emails|billing")] }
]

// Demo silences in the API shape plus an `instance` field: one per instance to start with; silencing and
// expiring in demo mode add to and remove from this list. The prod one covers the TLS certificate alert.
function demoSilences(nowMs) {
  function silence(instance, id, matchers, createdBy, comment, endsInMin) {
    return { instance: instance, id: id, matchers: matchers, createdBy: createdBy, comment: comment,
      startsAt: new Date(nowMs - 3600000).toISOString(), endsAt: new Date(nowMs + endsInMin * 60000).toISOString(),
      status: { state: "active" } }
  }
  return [
    silence("prod", "demo-silence-cert", [{ name: "alertname", value: "TLS certificate expires soon", isRegex: false, isEqual: true }],
      "alice", "Renewal is in OPS-112", 60 * 50),
    silence("staging", "demo-silence-reports", [{ name: "queue", value: "reports|archive", isRegex: true, isEqual: true }],
      "bob", "Queues are being migrated", 190)
  ]
}

// Demo rules API response for a demo instance (only prod is a Grafana). "Payment latency p99" is pending in the
// phase where demoAlerts() does not fire it, so it moves from Pending to firing every 2 minutes.
function demoPending(nowMs, instance) {
  if (instance !== "prod") return null
  var phase = Math.floor(nowMs / 120000) % 2 === 0
  function ago(min) { return new Date(nowMs - min * 60000).toISOString() }
  function rule(uid, name, alerts) { return { uid: uid, name: name, state: "pending", alerts: alerts } }
  function alert(labels, summary, state, activeMinAgo) {
    return { labels: labels, annotations: { summary: summary }, state: state, activeAt: ago(activeMinAgo) }
  }
  var rules = [
    rule("demo-replication", "Replication lag", [
      alert({ alertname: "Replication lag", severity: "warning", instance: "db-02:9187" }, "Replica 38s behind (threshold 30s for 10m)", "Pending", 4)
    ]),
    rule("demo-cpu", "CPU saturation", [
      alert({ alertname: "CPU saturation", severity: "warning", node: "k8s-worker-3" }, "CPU 93% (threshold 90% for 15m)", "Pending", 9),
      alert({ alertname: "CPU saturation", severity: "warning", node: "k8s-worker-1" }, "CPU 41%", "Normal", 0)
    ])
  ]
  if (!phase) {
    rules.push(rule("demo-latency", "Payment latency p99", [
      alert({ alertname: "Payment latency p99", severity: "critical", service: "payments", env: "prod" },
        "p99 1.4s (threshold 1s for 2m)", "Pending", (nowMs % 120000) / 60000)
    ]))
  }
  return { status: "success", data: { groups: [{ name: "demo", file: "Demo", rules: rules }] } }
}

// Demo data in the real API shape, for the two DEMO_INSTANCES. Every 2 minutes "Payment latency" starts
// firing in prod while staging goes unreachable (null), so notifications, the badge and the
// unreachable mark can all be seen without a real instance. An alert matched by one of the instance's
// `silences` (demoSilences entries) is suppressed.
// The instance's matchers are applied here, as the server would: staging's filter drops "reports".
function demoAlerts(nowMs, silences, instance) {
  var phase = Math.floor(nowMs / 120000) % 2 === 0
  function ago(min) { return new Date(nowMs - min * 60000).toISOString() }
  function alert(fp, labels, annotations, startedMinAgo) {
    var silenced = (silences || []).some(function(s) {
      return s.instance === instance && matchesAll(labels, s.matchers.map(function(m) { return parseMatcher(silenceMatcherText(m)) }))
    })
    return {
      fingerprint: fp,
      labels: labels,
      annotations: annotations,
      startsAt: ago(startedMinAgo),
      generatorURL: instance === "prod" ? "https://grafana.example.com/alerting/grafana/" + fp + "/view"
        : "https://prometheus.staging.example.com/graph",
      status: { state: silenced ? "suppressed" : "active" }
    }
  }
  if (instance === "staging") {
    if (phase) return null
    return [
      alert("demo-queue", { alertname: "Queue backlog", severity: "warning", queue: "emails", env: "staging" },
        { summary: "12k messages waiting for 20m" }, 20),
      alert("demo-reports", { alertname: "Queue backlog", severity: "warning", queue: "reports", env: "staging" },
        { summary: "Not ours, filtered out" }, 30)
    ].filter(function(a) { return matchesAll(a.labels, DEMO_INSTANCES[1].matchers) })
  }
  var list = [
    alert("demo-disk", { alertname: "Disk almost full", severity: "critical", instance: "db-01:9100", mountpoint: "/var/lib/postgresql" },
      { summary: "Free space 4.2% on /var/lib/postgresql" }, 47),
    alert("demo-5xx", { alertname: "HTTP 5xx rate", severity: "warning", service: "channel-service", env: "prod" },
      { summary: "5xx ratio 2.8% over 5m (threshold 2%)" }, 12),
    alert("demo-cert", { alertname: "TLS certificate expires soon", severity: "info", host: "api.example.com" },
      { summary: "Certificate expires in 9 days" }, 60 * 26)
  ]
  if (phase) {
    list.push(alert("demo-latency", { alertname: "Payment latency p99", severity: "critical", service: "payments", env: "prod" },
      { summary: "p99 1.9s over 5m (threshold 1s)" }, 1))
  }
  return list
}

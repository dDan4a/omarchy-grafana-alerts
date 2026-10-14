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

// The panel list: with several instances each group gets a header row (alert count or the error),
// so an unreachable instance shows up in place instead of hiding the others.
function panelItems(instances, rowsByInstance, errors) {
  var items = []
  for (var i = 0; i < instances.length; i++) {
    var name = instances[i].name
    var rows = rowsByInstance[name] || []
    if (instances.length > 1)
      items.push({ header: true, key: "#" + name, instance: name, error: errors[name] || "", count: summarize(rows).total,
        filter: (instances[i].matchers || []).map(matcherText).join(", ") })
    items = items.concat(rows)
  }
  return items
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

// Demo data in the real API shape, for the two DEMO_INSTANCES. Every 2 minutes "Payment latency" starts
// firing in prod while staging goes unreachable (null), so notifications, the badge and the
// unreachable mark can all be seen without a real instance. `silencedKeys` holds row keys.
// The instance's matchers are applied here, as the server would: staging's filter drops "reports".
function demoAlerts(nowMs, silencedKeys, instance) {
  var phase = Math.floor(nowMs / 120000) % 2 === 0
  function ago(min) { return new Date(nowMs - min * 60000).toISOString() }
  function alert(fp, labels, annotations, startedMinAgo) {
    var silenced = !!(silencedKeys && silencedKeys[instance + "/" + fp])
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

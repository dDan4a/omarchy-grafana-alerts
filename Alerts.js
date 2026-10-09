.pragma library

// Pure helpers over Grafana Alertmanager v2 alerts
// (GET /api/alertmanager/grafana/api/v2/alerts). No QML types here, so tests run under node.

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

// Turns the raw API array into rows for the UI, most urgent and then oldest first.
function normalize(raw) {
  if (!Array.isArray(raw)) return []
  var rows = []
  for (var i = 0; i < raw.length; i++) {
    var a = raw[i] || {}
    var labels = a.labels || {}
    var annotations = a.annotations || {}
    var state = (a.status && a.status.state) || "active"
    rows.push({
      fingerprint: String(a.fingerprint || labels.alertname + JSON.stringify(labels)),
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

// Rows whose fingerprint was not in the previous poll. `known` is null on the first poll,
// so startup does not replay every already-firing alert as a notification.
function newAlerts(rows, known) {
  if (known === null || known === undefined) return []
  return rows.filter(function(r) { return !r.silenced && !known[r.fingerprint] })
}

function fingerprints(rows) {
  var set = {}
  for (var i = 0; i < rows.length; i++) set[rows[i].fingerprint] = true
  return set
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

// Silence body for POST /api/alertmanager/grafana/api/v2/silences matching this exact alert.
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

// Demo data in the real API shape. "Payment latency" flaps every 2 minutes so notifications
// and the badge can be seen changing without a Grafana instance.
function demoAlerts(nowMs, silencedFingerprints) {
  function ago(min) { return new Date(nowMs - min * 60000).toISOString() }
  function alert(fp, labels, annotations, startedMinAgo) {
    var silenced = !!(silencedFingerprints && silencedFingerprints[fp])
    return {
      fingerprint: fp,
      labels: labels,
      annotations: annotations,
      startsAt: ago(startedMinAgo),
      generatorURL: "https://grafana.example.com/alerting/grafana/" + fp + "/view",
      status: { state: silenced ? "suppressed" : "active" }
    }
  }
  var list = [
    alert("demo-disk", { alertname: "Disk almost full", severity: "critical", instance: "db-01:9100", mountpoint: "/var/lib/postgresql" },
      { summary: "Free space 4.2% on /var/lib/postgresql" }, 47),
    alert("demo-5xx", { alertname: "HTTP 5xx rate", severity: "warning", service: "channel-service", env: "prod" },
      { summary: "5xx ratio 2.8% over 5m (threshold 2%)" }, 12),
    alert("demo-cert", { alertname: "TLS certificate expires soon", severity: "info", host: "api.example.com" },
      { summary: "Certificate expires in 9 days" }, 60 * 26)
  ]
  if (Math.floor(nowMs / 120000) % 2 === 0) {
    list.push(alert("demo-latency", { alertname: "Payment latency p99", severity: "critical", service: "payments", env: "prod" },
      { summary: "p99 1.9s over 5m (threshold 1s)" }, 1))
  }
  return list
}

// Run: node tests/alerts.test.js
const assert = require("assert")
const fs = require("fs")
const path = require("path")

// Alerts.js is a QML `.pragma library` file: drop the pragma and expose its functions.
const src = fs.readFileSync(path.join(__dirname, "..", "Alerts.js"), "utf8").replace(/^\.pragma library\s*$/m, "")
const A = new Function(src + "; return { severityOf, displayLabels, parseInstances, apiBase, normalize, summarize, newAlerts, fingerprints, " +
  "panelItems, step, firstRow, duration, silenceBody, demoAlerts, DEMO_INSTANCES }")()

const NOW = Date.parse("2026-10-10T12:00:00Z")

// severity mapping
assert.strictEqual(A.severityOf({ severity: "High" }), "critical")
assert.strictEqual(A.severityOf({ severity: "warning" }), "warning")
assert.strictEqual(A.severityOf({}), "info")

// instances: file wins, legacy grafanaUrl is "default", nothing means demo, bad entries throw
const inst = A.parseInstances(JSON.stringify([
  { name: "prod", url: "https://grafana.work/", tokenFile: "~/t" },
  { name: "am", type: "alertmanager", url: "http://am:9093" },
]), "https://ignored", "")
assert.deepStrictEqual(inst.map(i => [i.name, i.type, i.url, i.tokenFile]),
  [["prod", "grafana", "https://grafana.work", "~/t"], ["am", "alertmanager", "http://am:9093", ""]])
assert.strictEqual(A.apiBase(inst[0]), "https://grafana.work/api/alertmanager/grafana/api/v2")
assert.strictEqual(A.apiBase(inst[1]), "http://am:9093/api/v2")
assert.deepStrictEqual(A.parseInstances(null, " https://g/ ", "~/tok"), [{ name: "default", type: "grafana", url: "https://g", tokenFile: "~/tok" }])
assert.deepStrictEqual(A.parseInstances(null, "", ""), [])
assert.throws(() => A.parseInstances("{", "", ""))
assert.throws(() => A.parseInstances("{}", "", ""), /array/)
assert.throws(() => A.parseInstances('[{"name":"x"}]', "", ""), /url/)
assert.throws(() => A.parseInstances('[{"name":"x","url":"u","type":"loki"}]', "", ""), /type/)
assert.throws(() => A.parseInstances('[{"name":"x","url":"u"},{"name":"x","url":"v"}]', "", ""), /duplicate/)

// normalize: order is silenced last, then severity, then oldest first
const raw = [
  { fingerprint: "w", labels: { alertname: "W", severity: "warning" }, startsAt: "2026-10-10T11:00:00Z", status: { state: "active" } },
  { fingerprint: "c-new", labels: { alertname: "C2", severity: "critical" }, startsAt: "2026-10-10T11:50:00Z", status: { state: "active" } },
  { fingerprint: "c-old", labels: { alertname: "C1", severity: "critical", instance: "db" }, annotations: { summary: "disk" },
    startsAt: "2026-10-10T10:00:00Z", status: { state: "active" } },
  { fingerprint: "s", labels: { alertname: "S", severity: "critical" }, startsAt: "2026-10-10T09:00:00Z", status: { state: "suppressed" } },
]
const rows = A.normalize(raw, "prod")
assert.deepStrictEqual(rows.map(r => r.fingerprint), ["c-old", "c-new", "w", "s"])
assert.strictEqual(rows[0].key, "prod/c-old")
assert.strictEqual(rows[0].instance, "prod")
assert.strictEqual(rows[0].summary, "disk")
assert.strictEqual(rows[0].labelText, "instance=db")
assert.deepStrictEqual(A.normalize(null), [])

// summarize ignores silenced
assert.deepStrictEqual(A.summarize(rows), { critical: 2, warning: 1, info: 0, silenced: 1, total: 3 })

// newAlerts: nothing on first poll, only unseen and unsilenced later
assert.deepStrictEqual(A.newAlerts(rows, null), [])
const known = A.fingerprints(rows.filter(r => r.fingerprint !== "c-new"))
assert.deepStrictEqual(A.newAlerts(rows, known).map(r => r.fingerprint), ["c-new"])
// the same fingerprint in another instance is a different alert
assert.deepStrictEqual(A.newAlerts(A.normalize(raw, "staging"), A.fingerprints(rows)).length, 3)

// panel items: a header per instance only when there are several; navigation skips headers
const two = [{ name: "prod" }, { name: "staging" }]
const items = A.panelItems(two, { prod: rows.slice(0, 2) }, { staging: "timeout" })
assert.deepStrictEqual(items.map(i => i.header ? "#" + i.instance : i.key), ["#prod", "prod/c-old", "prod/c-new", "#staging"])
assert.strictEqual(items[0].count, 2)
assert.strictEqual(items[3].error, "timeout")
assert.strictEqual(A.firstRow(items), 1)
assert.strictEqual(A.step(items, 1, -1), 1)
assert.strictEqual(A.step(items, 1, 1), 2)
assert.strictEqual(A.step(items, 2, 1), 2)
assert.strictEqual(A.firstRow(A.panelItems(two, {}, {})), -1)
assert.strictEqual(A.panelItems([{ name: "default" }], { default: rows }, {}).length, rows.length)

// duration
assert.strictEqual(A.duration("2026-10-10T11:59:30Z", NOW), "30s")
assert.strictEqual(A.duration("2026-10-10T11:48:00Z", NOW), "12m")
assert.strictEqual(A.duration("2026-10-10T09:15:00Z", NOW), "2h 45m")
assert.strictEqual(A.duration("2026-10-08T10:00:00Z", NOW), "2d 2h")
assert.strictEqual(A.duration("garbage", NOW), "")

// silence matches every label exactly and lasts the given minutes
const body = A.silenceBody(rows[0], 60, NOW, "dan")
assert.strictEqual(body.matchers.length, 3)
assert.ok(body.matchers.every(m => m.isEqual && !m.isRegex))
assert.strictEqual(Date.parse(body.endsAt) - Date.parse(body.startsAt), 3600000)

// demo data: two instances; prod flaps, staging goes unreachable, local silences by key
assert.deepStrictEqual(A.DEMO_INSTANCES.map(i => i.name), ["prod", "staging"])
const on = A.normalize(A.demoAlerts(0, {}, "prod"), "prod")
const off = A.normalize(A.demoAlerts(120000, {}, "prod"), "prod")
assert.strictEqual(on.length - off.length, 1)
assert.strictEqual(A.demoAlerts(0, {}, "staging"), null)
assert.strictEqual(A.normalize(A.demoAlerts(120000, {}, "staging"), "staging").length, 1)
const silenced = A.summarize(A.normalize(A.demoAlerts(120000, { "prod/demo-disk": true }, "prod"), "prod"))
assert.strictEqual(silenced.silenced, 1)

console.log("ok")

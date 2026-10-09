// Run: node tests/alerts.test.js
const assert = require("assert")
const fs = require("fs")
const path = require("path")

// Alerts.js is a QML `.pragma library` file: drop the pragma and expose its functions.
const src = fs.readFileSync(path.join(__dirname, "..", "Alerts.js"), "utf8").replace(/^\.pragma library\s*$/m, "")
const A = new Function(src + "; return { severityOf, displayLabels, normalize, summarize, newAlerts, fingerprints, duration, silenceBody, demoAlerts }")()

const NOW = Date.parse("2026-10-10T12:00:00Z")

// severity mapping
assert.strictEqual(A.severityOf({ severity: "High" }), "critical")
assert.strictEqual(A.severityOf({ severity: "warning" }), "warning")
assert.strictEqual(A.severityOf({}), "info")

// normalize: order is silenced last, then severity, then oldest first
const raw = [
  { fingerprint: "w", labels: { alertname: "W", severity: "warning" }, startsAt: "2026-10-10T11:00:00Z", status: { state: "active" } },
  { fingerprint: "c-new", labels: { alertname: "C2", severity: "critical" }, startsAt: "2026-10-10T11:50:00Z", status: { state: "active" } },
  { fingerprint: "c-old", labels: { alertname: "C1", severity: "critical", instance: "db" }, annotations: { summary: "disk" },
    startsAt: "2026-10-10T10:00:00Z", status: { state: "active" } },
  { fingerprint: "s", labels: { alertname: "S", severity: "critical" }, startsAt: "2026-10-10T09:00:00Z", status: { state: "suppressed" } },
]
const rows = A.normalize(raw)
assert.deepStrictEqual(rows.map(r => r.fingerprint), ["c-old", "c-new", "w", "s"])
assert.strictEqual(rows[0].summary, "disk")
assert.strictEqual(rows[0].labelText, "instance=db")
assert.deepStrictEqual(A.normalize(null), [])

// summarize ignores silenced
assert.deepStrictEqual(A.summarize(rows), { critical: 2, warning: 1, info: 0, silenced: 1, total: 3 })

// newAlerts: nothing on first poll, only unseen and unsilenced later
assert.deepStrictEqual(A.newAlerts(rows, null), [])
const known = A.fingerprints(rows.filter(r => r.fingerprint !== "c-new"))
assert.deepStrictEqual(A.newAlerts(rows, known).map(r => r.fingerprint), ["c-new"])

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

// demo data parses, flaps, and honours local silences
const on = A.normalize(A.demoAlerts(0, {}))
const off = A.normalize(A.demoAlerts(120000, {}))
assert.strictEqual(on.length - off.length, 1)
const silenced = A.summarize(A.normalize(A.demoAlerts(120000, { "demo-disk": true })))
assert.strictEqual(silenced.silenced, 1)

console.log("ok")

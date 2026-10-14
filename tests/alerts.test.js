// Run: node tests/alerts.test.js
const assert = require("assert")
const fs = require("fs")
const path = require("path")

// Alerts.js is a QML `.pragma library` file: drop the pragma and expose its functions.
const src = fs.readFileSync(path.join(__dirname, "..", "Alerts.js"), "utf8").replace(/^\.pragma library\s*$/m, "")
const A = new Function(src + "; return { severityOf, displayLabels, parseInstances, apiBase, normalize, summarize, newAlerts, fingerprints, " +
  "panelItems, step, parseMatcher, matcherText, matchesAll, alertsUrl, firstRow, duration, silenceBody, demoAlerts, DEMO_INSTANCES, " +
  "remaining, silencesUrl, expireUrl, normalizeSilences, demoSilences }")()

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
assert.deepStrictEqual(A.parseInstances(null, " https://g/ ", "~/tok"), [{ name: "default", type: "grafana", url: "https://g", tokenFile: "~/tok", matchers: [] }])
assert.deepStrictEqual(A.parseInstances(null, "", ""), [])
assert.throws(() => A.parseInstances("{", "", ""))
assert.throws(() => A.parseInstances("{}", "", ""), /array/)
assert.throws(() => A.parseInstances('[{"name":"x"}]', "", ""), /url/)
assert.throws(() => A.parseInstances('[{"name":"x","url":"u","type":"loki"}]', "", ""), /type/)
assert.throws(() => A.parseInstances('[{"name":"x","url":"u"},{"name":"x","url":"v"}]', "", ""), /duplicate/)

// matchers: Alertmanager syntax, quoted canonical form, anchored regexes, repeated filter= params
assert.deepStrictEqual(A.parseMatcher(" team = backend "), { name: "team", op: "=", value: "backend" })
assert.deepStrictEqual(A.parseMatcher('env!="dev \\"x\\""'), { name: "env", op: "!=", value: 'dev "x"' })
assert.strictEqual(A.matcherText(A.parseMatcher('env!="dev \\"x\\""')), 'env!="dev \\"x\\""')
assert.strictEqual(A.matcherText(A.parseMatcher("severity=~critical|warning")), 'severity=~"critical|warning"')
assert.throws(() => A.parseMatcher("team"), /bad matcher/)
assert.throws(() => A.parseMatcher("1x=y"), /bad matcher/)
assert.throws(() => A.parseMatcher("x=~("), /regex/)
const ms = ["severity=~critical|warning", "team!=ops", "env!~", "host=~.*"].map(A.parseMatcher)
assert.ok(A.matchesAll({ severity: "critical", env: "prod", host: "a" }, ms))
assert.ok(!A.matchesAll({ severity: "criticalish", env: "prod" }, ms))
assert.ok(!A.matchesAll({ severity: "warning", team: "ops", env: "prod" }, ms))
assert.ok(!A.matchesAll({ severity: "warning" }, ms))
assert.ok(A.matchesAll({ any: "thing" }, []))
const filtered = A.parseInstances(JSON.stringify([
  { name: "am", type: "alertmanager", url: "http://am:9093", matchers: ["team=backend", "severity=~critical|warning"] },
]), "", "")
assert.strictEqual(A.alertsUrl(filtered[0]), "http://am:9093/api/v2/alerts?active=true&inhibited=false" +
  "&filter=team%3D%22backend%22&filter=severity%3D~%22critical%7Cwarning%22")
assert.strictEqual(A.alertsUrl(inst[0]), "https://grafana.work/api/alertmanager/grafana/api/v2/alerts?active=true&inhibited=false")
assert.throws(() => A.parseInstances('[{"name":"x","url":"u","matchers":"team=a"}]', "", ""), /list/)
assert.throws(() => A.parseInstances('[{"name":"x","url":"u","matchers":["team"]}]', "", ""), /^Error: x: bad matcher/)

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
assert.strictEqual(items[0].filter, "")
assert.strictEqual(A.panelItems(filtered, {}, {})[0], undefined)
assert.strictEqual(A.panelItems(filtered.concat(inst), {}, {})[0].filter, 'team="backend", severity=~"critical|warning"')
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

// silences: only active ones, soonest end first, matchers in filter syntax; URLs per instance type
assert.strictEqual(A.silencesUrl(inst[0]), "https://grafana.work/api/alertmanager/grafana/api/v2/silences")
assert.strictEqual(A.expireUrl(inst[1], "a/b"), "http://am:9093/api/v2/silence/a%2Fb")
const sil = A.normalizeSilences([
  { id: "late", status: { state: "active" }, endsAt: "2026-10-10T15:00:00Z", createdBy: "bob", comment: "c",
    matchers: [{ name: "env", value: "dev", isRegex: false, isEqual: false }, { name: "q", value: "a|b", isRegex: true }] },
  { id: "old", status: { state: "expired" }, endsAt: "2026-10-10T11:00:00Z", matchers: [] },
  { id: "soon", status: { state: "active" }, endsAt: "2026-10-10T12:30:00Z", matchers: [{ name: "alertname", value: "X", isRegex: false, isEqual: true }] },
  { id: "next", status: { state: "pending" }, endsAt: "2026-10-10T13:00:00Z", matchers: [] },
], "prod")
assert.deepStrictEqual(sil.map(s => s.id), ["soon", "late"])
assert.strictEqual(sil[1].matcherText, 'env!="dev", q=~"a|b"')
assert.strictEqual(sil[0].matcherText, 'alertname="X"')
assert.strictEqual(sil[1].instance, "prod")
assert.ok(sil[0].isSilence && !sil[0].header)
assert.deepStrictEqual(A.normalizeSilences({ message: "forbidden" }, "prod"), [])
assert.strictEqual(A.remaining("2026-10-10T15:00:00Z", NOW), "3h 0m")
assert.strictEqual(A.remaining("garbage", NOW), "")
// silences come after all alerts under one header; a failed instance is named there, alerts are untouched
const withSil = A.panelItems(two, { prod: rows.slice(0, 1) }, {}, { prod: sil }, { staging: "403" })
assert.deepStrictEqual(withSil.map(i => i.key), ["#prod", "prod/c-old", "#staging", "#silences", "silence:prod/soon", "silence:prod/late"])
assert.strictEqual(withSil[3].count, 2)
assert.strictEqual(withSil[3].error, "staging: 403")
assert.strictEqual(A.step(withSil, 1, 1), 4)
assert.strictEqual(A.panelItems(two, {}, {}, {}, {}).length, 2)

// demo data: two instances; prod flaps, staging goes unreachable, local silences by key
assert.deepStrictEqual(A.DEMO_INSTANCES.map(i => i.name), ["prod", "staging"])
const on = A.normalize(A.demoAlerts(0, [], "prod"), "prod")
const off = A.normalize(A.demoAlerts(120000, [], "prod"), "prod")
assert.strictEqual(on.length - off.length, 1)
assert.strictEqual(A.demoAlerts(0, [], "staging"), null)
// staging's demo filter keeps the emails queue and drops reports
assert.deepStrictEqual(A.normalize(A.demoAlerts(120000, [], "staging"), "staging").map(r => r.labels.queue), ["emails"])
// demo silences suppress what they match, on their own instance only; one created with silenceBody works too
const demoSil = A.demoSilences(NOW)
assert.strictEqual(A.summarize(A.normalize(A.demoAlerts(120000, demoSil, "prod"), "prod")).silenced, 1)
assert.strictEqual(A.normalizeSilences(demoSil.filter(s => s.instance === "staging"), "staging").length, 1)
const disk = off.find(r => r.fingerprint === "demo-disk")
const created = Object.assign(A.silenceBody(disk, 60, NOW, "dan"), { instance: "prod", id: "x", status: { state: "active" } })
assert.strictEqual(A.summarize(A.normalize(A.demoAlerts(120000, demoSil.concat([created]), "prod"), "prod")).silenced, 2)
assert.strictEqual(A.summarize(A.normalize(A.demoAlerts(120000, [Object.assign({}, created, { instance: "staging" })], "prod"), "prod")).silenced, 0)

console.log("ok")

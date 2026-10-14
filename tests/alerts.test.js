// Run: node tests/alerts.test.js
process.env.TZ = "UTC" // on-call times are shown in local time
const assert = require("assert")
const fs = require("fs")
const path = require("path")

// Alerts.js is a QML `.pragma library` file: drop the pragma and expose its functions.
const src = fs.readFileSync(path.join(__dirname, "..", "Alerts.js"), "utf8").replace(/^\.pragma library\s*$/m, "")
const A = new Function(src + "; return { severityOf, displayLabels, parseInstances, apiBase, normalize, summarize, newAlerts, fingerprints, " +
  "panelItems, step, parseMatcher, matcherText, matchesAll, alertsUrl, firstRow, duration, silenceBody, demoAlerts, DEMO_INSTANCES, " +
  "remaining, silencesUrl, expireUrl, normalizeSilences, demoSilences, rulesUrl, normalizePending, demoPending, DND_FOREVER, dndActive, dndToggle, dndText, parseDnd, toNotify, " +
  "oncallRange, normalizeOncall, oncallView, demoOncall, ruleUid, ruleUrl, sparkQuery, sparkSeries, sparkGeometry, sparkCaption, demoSpark }")()

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
assert.deepStrictEqual(A.parseInstances(null, " https://g/ ", "~/tok"), [{ name: "default", type: "grafana", url: "https://g", tokenFile: "~/tok", matchers: [], oncall: null }])
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

// pending: Grafana rules API only, Pending alert instances, local matchers, longest pending first
assert.strictEqual(A.rulesUrl(inst[0]), "https://grafana.work/api/prometheus/grafana/api/v1/rules?state=pending&state=firing")
assert.strictEqual(A.rulesUrl(inst[1]), "")
const rulesResp = { status: "success", data: { groups: [{ name: "g", rules: [
  { uid: "r1", name: "Lag", annotations: { summary: "rule summary" }, alerts: [
    { labels: { alertname: "Lag", severity: "critical", team: "backend" }, state: "Pending", activeAt: "2026-10-10T11:55:00.123456789Z" },
    { labels: { alertname: "Lag", team: "backend", db: "b" }, state: "Alerting", activeAt: "2026-10-10T11:00:00Z" },
    { labels: { alertname: "Lag", team: "ops" }, state: "pending", activeAt: "2026-10-10T11:00:00Z" },
  ] },
  { name: "Cpu", alerts: [{ labels: { team: "backend", node: "n1" }, annotations: { summary: "93%" }, state: "Pending", activeAt: "2026-10-10T11:50:00Z" }] },
  { name: "Quiet", alerts: [{ labels: { team: "backend" }, state: "Normal", activeAt: "0001-01-01T00:00:00Z" }] },
] }] } }
const backend = Object.assign({}, inst[0], { name: "prod", matchers: [A.parseMatcher("team=backend")] })
const pend = A.normalizePending(rulesResp, backend)
assert.deepStrictEqual(pend.map(p => p.name), ["Cpu", "Lag"])
assert.ok(pend.every(p => p.isPending && !p.silenced && p.instance === "prod"))
assert.strictEqual(pend[1].startsAt, "2026-10-10T11:55:00.123Z")
assert.strictEqual(A.duration(pend[1].startsAt, NOW), "4m")
assert.strictEqual(pend[1].summary, "rule summary")
assert.strictEqual(pend[1].severity, "critical")
assert.strictEqual(pend[1].url, "https://grafana.work/alerting/grafana/r1/view")
assert.strictEqual(pend[0].url, "")
assert.strictEqual(pend[0].labelText, "node=n1  team=backend")
assert.strictEqual(A.normalizePending(rulesResp, inst[0]).length, 3)
assert.deepStrictEqual(A.normalizePending(null, inst[0]), [])
assert.deepStrictEqual(A.normalizePending({ message: "forbidden" }, inst[0]), [])
// pending go between alerts and silences, never into the summary; a failed rules request only marks the Pending header
const withPend = A.panelItems(two, { prod: rows.slice(0, 1) }, {}, { prod: sil.slice(0, 1) }, {}, { prod: pend }, { staging: "403" })
assert.deepStrictEqual(withPend.map(i => i.key), ["#prod", "prod/c-old", "#staging", "#pending", pend[0].key, pend[1].key,
  "#silences", "silence:prod/soon"])
assert.strictEqual(withPend[3].count, 2)
assert.strictEqual(withPend[3].error, "staging: 403")
assert.strictEqual(withPend[0].count, 1)
assert.strictEqual(A.step(withPend, 1, 1), 4)
assert.strictEqual(A.panelItems(two, {}, {}, {}, {}, {}, {}).length, 2)
// demo: only prod has pending; Payment latency is pending exactly when it is not firing
assert.strictEqual(A.demoPending(NOW, "staging"), null)
const pendOn = A.normalizePending(A.demoPending(0, "prod"), A.DEMO_INSTANCES[0]).map(p => p.name)
const pendOff = A.normalizePending(A.demoPending(120000, "prod"), A.DEMO_INSTANCES[0]).map(p => p.name)
assert.deepStrictEqual(pendOn, ["CPU saturation", "Replication lag"])
assert.ok(pendOff.includes("Payment latency p99") && pendOff.length === 3)
assert.ok(on.some(r => r.name === "Payment latency p99") && !off.some(r => r.name === "Payment latency p99"))

// do not disturb: 1 hour expires on its own, "until turned off" does not, any press while on turns it off
const HOUR = 3600000
const dnd1h = A.dndToggle(0, NOW, 60)
assert.strictEqual(dnd1h, NOW + HOUR)
assert.ok(A.dndActive(dnd1h, NOW + HOUR - 1) && !A.dndActive(dnd1h, NOW + HOUR))
assert.strictEqual(A.dndText(dnd1h, NOW + 15 * 60000), "45m left")
assert.strictEqual(A.dndText(dnd1h, NOW + HOUR), "")
assert.strictEqual(A.dndToggle(dnd1h, NOW, 0), 0)
assert.strictEqual(A.dndToggle(dnd1h, NOW + HOUR, 0), A.DND_FOREVER)
assert.ok(A.dndActive(A.DND_FOREVER, NOW + 1000 * HOUR))
assert.strictEqual(A.dndText(A.DND_FOREVER, NOW), "until turned off")
assert.strictEqual(A.dndToggle(A.DND_FOREVER, NOW, 60), 0)
assert.ok(!A.dndActive(0, NOW))
assert.strictEqual(A.parseDnd(String(dnd1h) + "\n"), dnd1h)
assert.strictEqual(A.parseDnd("-1"), A.DND_FOREVER)
for (const bad of [null, "", "garbage", "-5", "Infinity"]) assert.strictEqual(A.parseDnd(bad), 0)

// notifications are muted during DND; alerts seen during it are known afterwards, so none are replayed
const before = A.normalize(raw.slice(0, 1), "prod")
const during = A.normalize(raw, "prod")
assert.ok(during.length > before.length)
assert.deepStrictEqual(A.toNotify(during, A.fingerprints(before), true, dnd1h, NOW), [])
assert.ok(A.toNotify(during, A.fingerprints(before), true, 0, NOW).length > 0)
assert.deepStrictEqual(A.toNotify(during, A.fingerprints(before), false, 0, NOW), [])
assert.deepStrictEqual(A.toNotify(during, A.fingerprints(during), true, dnd1h, NOW + HOUR), [])

// oncall config: Grafana only, true or { user, url }
const oc = A.parseInstances(JSON.stringify([
  { name: "a", url: "https://g", oncall: true },
  { name: "b", url: "https://h", oncall: { user: " Me@x.io ", url: "https://oncall/" } },
  { name: "c", url: "https://i" },
]), "", "")
assert.deepStrictEqual(oc.map(i => i.oncall), [{ user: "", url: "" }, { user: "Me@x.io", url: "https://oncall" }, null])
assert.throws(() => A.parseInstances('[{"name":"x","type":"alertmanager","url":"u","oncall":true}]', "", ""), /grafana/)
assert.throws(() => A.parseInstances('[{"name":"x","url":"u","oncall":"yes"}]', "", ""), /oncall must be/)
assert.deepStrictEqual(A.oncallRange(NOW), { from: "2026-10-09", to: "2026-10-24" })

// final shifts: back-to-back shifts of one person merge, bad entries drop, schedules sort by name
const fs_ = (who, from, to) => ({ user_email: who + "@x.io", user_username: who, shift_start: from, shift_end: to })
const oncallRaw = {
  schedules: [{ id: "S2", name: "Secondary" }, { id: "S1", name: "Primary" }],
  shifts: [
    { id: "S1", shifts: [fs_("me", "2026-10-10T10:00:00Z", "2026-10-10T14:00:00Z"), fs_("me", "2026-10-10T08:00:00Z", "2026-10-10T10:00:00Z"),
      fs_("bob", "2026-10-10T14:00:00Z", "2026-10-11T08:00:00Z"), fs_("me", "2026-10-13T08:00:00+00:00", "2026-10-13T16:00:00+00:00"),
      fs_("bad", "nope", "2026-10-10T14:00:00Z")] },
    { id: "S2", shifts: [fs_("alice", "2026-10-10T00:00:00Z", "2026-10-11T00:00:00Z"), fs_("me", "2026-10-11T00:00:00Z", "2026-10-12T00:00:00Z")] },
  ],
}
const sched = A.normalizeOncall(oncallRaw)
assert.deepStrictEqual(sched.map(s => s.name), ["Primary", "Secondary"])
assert.deepStrictEqual(sched[0].shifts.map(s => [s.username, s.start.slice(11, 16), s.end.slice(5, 16)]),
  [["me", "08:00", "10-10T14:00"], ["bob", "14:00", "10-11T08:00"], ["me", "08:00", "10-13T16:00"]])
assert.deepStrictEqual(A.normalizeOncall(null), [])

// view: who is on call now and until when, my next two shifts, onCall for the bar
const ocInst = [{ name: "prod", oncall: { user: "ME@x.io", url: "" } }, { name: "am", oncall: null }]
const v = A.oncallView(ocInst, { prod: sched }, {}, NOW)
assert.ok(v.visible && v.onCall && v.hasUser)
assert.deepStrictEqual(v.rows.map(r => [r.title, r.me, r.text]), [
  ["Primary", true, "you · until 14:00 · 2h 0m left"],
  ["Secondary", false, "alice · until Sun 00:00 · 12h 0m left"],
])
assert.deepStrictEqual(v.current, ["Primary until 14:00"])
assert.deepStrictEqual(v.next.map(n => [n.title, n.text]), [
  ["Secondary", "Sun 00:00 – Mon 00:00 · in 12h 0m"],
  ["Primary", "Tue 08:00 – Tue 16:00 · in 2d 20h"],
])
// after my shift: bob is on call, I am not; without a user there are no next shifts
const later = A.oncallView(ocInst, { prod: sched }, {}, NOW + 3 * HOUR)
assert.ok(!later.onCall)
assert.strictEqual(later.rows[0].text, "bob · until Sun 08:00 · 17h 0m left")
const anon = A.oncallView([{ name: "prod", oncall: { user: "", url: "" } }], { prod: sched }, {}, NOW)
assert.ok(!anon.onCall && !anon.hasUser && anon.next.length === 0)
assert.strictEqual(anon.rows[0].text, "me · until 14:00 · 2h 0m left")
// nobody on call; several instances get prefixed titles; an error replaces that instance's rows only
const gap = A.oncallView(ocInst, { prod: sched }, {}, Date.parse("2026-10-12T12:00:00Z"))
assert.strictEqual(gap.rows[0].text, "nobody")
const twoOc = A.oncallView([ocInst[0], { name: "stage", oncall: { user: "", url: "" } }], { prod: sched }, { stage: "HTTP 403" }, NOW)
assert.deepStrictEqual(twoOc.rows.map(r => r.title), ["prod / Primary", "prod / Secondary", "stage"])
assert.ok(twoOc.rows[2].error && twoOc.onCall)
// no OnCall configured: nothing to show
assert.deepStrictEqual(A.oncallView([{ name: "am", oncall: null }], {}, {}, NOW).visible, false)

// demo: on call in prod Primary, next shifts listed, nothing for staging
const dv = A.oncallView(A.DEMO_INSTANCES, { prod: A.normalizeOncall(A.demoOncall(NOW, "prod")) }, {}, NOW)
assert.ok(dv.onCall && dv.next.length === 2)
assert.strictEqual(A.demoOncall(NOW, "staging"), null)

// sparkline: rule uid only on Grafana instances, from the label or the pending row
const g = { name: "prod", type: "grafana", url: "https://g" }, am = { name: "am", type: "alertmanager", url: "http://am" }
assert.strictEqual(A.ruleUid({ labels: { __alert_rule_uid__: "r1" } }, g), "r1")
assert.strictEqual(A.ruleUid({ ruleUid: "r2", labels: {} }, g), "r2")
assert.strictEqual(A.ruleUid({ labels: { __alert_rule_uid__: "r1" } }, am), "")
assert.strictEqual(A.ruleUrl(g, "a/b"), "https://g/api/ruler/grafana/api/v1/rule/a%2Fb")
assert.strictEqual(A.normalizePending(A.demoPending(NOW, "prod"), A.DEMO_INSTANCES[0])[0].ruleUid, "demo-cpu")

// sparkline: threshold through reduce, instant query turned into a range one
const expr = (refId, model) => ({ refId, datasourceUid: "__expr__", model: Object.assign({ refId }, model) })
const promA = { refId: "A", datasourceUid: "prom", model: { refId: "A", expr: "up", instant: true, range: false } }
const rule = (condition, data) => ({ grafana_alert: { uid: "u", condition, data } })
const sq = A.sparkQuery(rule("C", [promA, expr("B", { type: "reduce", expression: "A", reducer: "last" }),
  expr("C", { type: "threshold", expression: "B", conditions: [{ evaluator: { type: "gt", params: [0.5] } }] })]))
assert.deepStrictEqual(sq.thresholds, [0.5])
assert.strictEqual(sq.refId, "A")
assert.deepStrictEqual(sq.request.queries[0], { refId: "A", expr: "up", instant: false, range: true, datasource: { uid: "prom" },
  hide: false, intervalMs: 30000, maxDataPoints: 120 })
assert.strictEqual(sq.request.from, "now-1h")
// range evaluators give two lines, no_value none
assert.deepStrictEqual(A.sparkQuery(rule("C", [promA, expr("C", { type: "threshold", expression: "A",
  conditions: [{ evaluator: { type: "outside_range", params: [1, 5] } }] })])).thresholds, [1, 5])
// classic condition with one condition
const lokiA = { refId: "A", datasourceUid: "loki", model: { refId: "A", expr: "x", queryType: "instant" } }
const cc = A.sparkQuery(rule("B", [lokiA, expr("B", { type: "classic_conditions",
  conditions: [{ evaluator: { type: "lt", params: [3] }, query: { params: ["A"] }, reducer: { type: "avg" } }] })]))
assert.deepStrictEqual(cc.thresholds, [3])
assert.strictEqual(cc.request.queries[0].queryType, "range")
assert.deepStrictEqual(A.sparkQuery(rule("B", [lokiA, expr("B", { type: "classic_conditions", conditions: [
  { evaluator: { type: "gt", params: [1] }, query: { params: ["A"] } }, { evaluator: { type: "gt", params: [2] }, query: { params: ["A"] } }] })])).thresholds, [])
// math in the chain: no threshold, still the first query; no datasource query at all: null
const mq = A.sparkQuery(rule("C", [promA, expr("B", { type: "math", expression: "$A * 100" }),
  expr("C", { type: "threshold", expression: "B", conditions: [{ evaluator: { type: "gt", params: [50] } }] })]))
assert.deepStrictEqual([mq.refId, mq.thresholds], ["A", []])
assert.strictEqual(A.sparkQuery(rule("C", [expr("C", { type: "math", expression: "1" })])), null)
assert.strictEqual(A.sparkQuery({}), null)

// ds/query response: the series of this alert by labels, else the first; nulls dropped
const frame = (labels, times, vals) => ({ schema: { fields: [{ name: "Time", type: "time" }, { name: "Value", type: "number", labels }] },
  data: { values: [times, vals] } })
const resp = { results: { A: { status: 200, frames: [frame({ instance: "a" }, [1, 2, 3], [1, null, 3]), frame({ instance: "b" }, [1, 2], [7, 8])] } } }
assert.deepStrictEqual(A.sparkSeries(resp, "A", { alertname: "x", instance: "b" }), [{ t: 1, v: 7 }, { t: 2, v: 8 }])
assert.deepStrictEqual(A.sparkSeries(resp, "A", { instance: "zzz" }), [{ t: 1, v: 1 }, { t: 3, v: 3 }])
const wide = { results: { A: { frames: [{ schema: { fields: [{ type: "time" }, { type: "number", labels: { host: "x" } }, { type: "number", labels: { host: "y" } }] },
  data: { values: [[2, 1], [5, 6], [9, 8]] } }] } } }
assert.deepStrictEqual(A.sparkSeries(wide, "A", { host: "y" }), [{ t: 1, v: 8 }, { t: 2, v: 9 }])
assert.strictEqual(A.sparkSeries({ results: { A: { error: "denied", frames: [] } } }, "A", {}), null)
assert.strictEqual(A.sparkSeries(resp, "B", {}), null)
assert.strictEqual(A.sparkSeries({ results: { A: { frames: [frame({}, [1], [1])] } } }, "A", {}), null)

// geometry: the threshold is inside the box even when the series never reaches it
const geo = A.sparkGeometry([{ t: 0, v: 1 }, { t: 10, v: 2 }], [4], 100, 50)
assert.deepStrictEqual(geo.line.map(p => p.x), [0, 100])
assert.ok(geo.thresholds[0] > 0 && geo.thresholds[0] < geo.line[1].y && geo.line[0].y < 50)
assert.ok(A.sparkGeometry([{ t: 0, v: 0 }, { t: 1, v: 0 }], [], 10, 10).line.every(p => p.y === 5))
assert.strictEqual(A.sparkCaption({ points: [{ t: 0, v: 1 }, { t: 1, v: 1.23456 }], thresholds: [1] }), "last 1h · now 1.23 · threshold 1")

// demo sparklines: prod alerts end past their threshold, staging has none
const demoRows = A.normalize(A.demoAlerts(NOW, [], "prod"), "prod")
assert.ok(demoRows.every(r => A.ruleUid(r, A.DEMO_INSTANCES[0]) !== ""))
const lat = A.demoSpark(demoRows.find(r => r.name === "Payment latency p99"), NOW)
assert.ok(lat.points[0].v < 1 && lat.points[lat.points.length - 1].v > 1 && lat.thresholds[0] === 1)
assert.deepStrictEqual(A.demoSpark(demoRows[0], NOW), A.demoSpark(demoRows[0], NOW))
assert.strictEqual(A.demoSpark({ name: "Queue backlog", instance: "staging", key: "k" }, NOW), null)

console.log("ok")

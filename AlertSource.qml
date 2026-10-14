import QtQuick
import Quickshell
import Quickshell.Io
import "Alerts.js" as Alerts

// Polls every configured Grafana / Alertmanager instance (or generates demo alerts) and raises desktop
// notifications for new ones. Loaded once as the plugin's service: every monitor's bar widget shares it,
// so there is one poll and one notification per alert no matter how many bars are on screen.
Item {
  id: root

  property string instancesFile: ""
  property string grafanaUrl: ""
  property string tokenFile: ""
  property int intervalSec: 60
  property bool notify: true

  // Parsed instances.json, or the legacy grafanaUrl as one instance; empty means demo mode.
  property var configured: []
  property string configError: ""
  readonly property bool demo: configured.length === 0 && configError === ""
  readonly property var instances: demo ? Alerts.DEMO_INSTANCES : configured

  property var rowsByInstance: ({})
  property var errors: ({})
  property var known: ({})
  readonly property var rows: {
    var all = []
    for (var i = 0; i < instances.length; i++) all = all.concat(rowsByInstance[instances[i].name] || [])
    return all
  }
  readonly property var summary: Alerts.summarize(rows)
  // One line for the bar tooltip and the panel status: what is broken, if anything.
  readonly property string error: {
    if (configError !== "") return configError
    var parts = []
    for (var i = 0; i < instances.length; i++) {
      var e = errors[instances[i].name]
      if (e) parts.push(instances.length > 1 ? instances[i].name + ": " + e : e)
    }
    return parts.join("; ")
  }
  property double updatedAt: 0
  property double now: Date.now()

  // Do not disturb: local only, mutes this plugin's notifications. Saved next to other state so it survives a shell restart.
  property double dndUntil: 0
  readonly property bool dnd: Alerts.dndActive(dndUntil, now)
  readonly property string dndText: Alerts.dndText(dndUntil, now)
  readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/dan4a.grafana-alerts"

  // Silences are loaded next to the alerts but kept apart: a failed request only marks the silences section.
  property var silencesByInstance: ({})
  property var silenceErrors: ({})

  property var demoSilences: Alerts.demoSilences(Date.now())

  // Pending alerts likewise, only from Grafana instances: they never count in the badge and never notify.
  property var pendingByInstance: ({})
  property var pendingErrors: ({})
  readonly property var grafanaInstances: configured.filter(function(i) { return i.type === "grafana" })

  // OnCall schedules of Grafana instances with "oncall" on; a failure only marks the On-call section.
  property var oncallByInstance: ({})
  property var oncallErrors: ({})
  readonly property var oncallInstances: configured.filter(function(i) { return !!i.oncall })
  readonly property var oncall: Alerts.oncallView(instances, oncallByInstance, oncallErrors, now)
  readonly property var oncallRange: Alerts.oncallRange(now)

  // The token is read inside sh and handed to curl on stdin, so it never shows up in argv / ps.
  // An empty token file ($1) sends no Authorization header: a plain Alertmanager often has none.
  // The remaining arguments go to curl.
  readonly property string curlScript:
    'set -e; f=$1; shift; t=""; if [ -n "$f" ]; then t=$(cat "$f"); fi; ' +
    'if [ -n "$t" ]; then printf \'header = "Authorization: Bearer %s"\\n\' "$t"; fi | ' +
    'curl -sS --fail-with-body --max-time 10 -K - "$@"'

  // OnCall API with the instance's service account token (Bearer + X-Grafana-URL). Its URL comes from the IRM
  // (or OSS OnCall) plugin settings unless $3 sets it. Prints { schedules, shifts: [{ id, shifts }] } with the final
  // shifts of every schedule from $4 to $5. Args: token file, Grafana URL, OnCall URL or "", start date, end date.
  // ponytail: first page only (100 schedules, 100 shifts each); follow `next` if that is ever too few.
  readonly property string oncallScript:
    'set -e; command -v jq >/dev/null || { echo "needs jq" >&2; exit 127; }; ' +
    't=$(cat "$1"); g=$2; api=$3; ' +
    'c() { printf \'header = "Authorization: Bearer %s"\\n\' "$t" | curl -sS --fail-with-body --max-time 10 -K - -H "X-Grafana-URL: $g" "$@"; }; ' +
    'if [ -z "$api" ]; then for p in grafana-irm-app grafana-oncall-app; do ' +
    'api=$(c "$g/api/plugins/$p/settings" 2>/dev/null | jq -r ".jsonData.onCallApiUrl // empty" 2>/dev/null) || api=""; ' +
    '[ -n "$api" ] && break; done; fi; ' +
    '[ -n "$api" ] || { echo "OnCall API URL not found: is Grafana IRM / OnCall enabled?" >&2; exit 1; }; ' +
    'api=${api%/}; s=$(c "$api/api/v1/schedules/?perpage=100"); out=""; ' +
    'for id in $(printf "%s" "$s" | jq -r ".results[].id"); do ' +
    'r=$(c "$api/api/v1/schedules/$id/final_shifts?start_date=$4&end_date=$5&perpage=100"); ' +
    'out="$out$(printf "%s" "$r" | jq -c --arg id "$id" "{id: \\$id, shifts: .results}")"; done; ' +
    'printf "%s" "$out" | jq -s --argjson s "$(printf "%s" "$s" | jq -c .results)" "{schedules: \\$s, shifts: .}"'

  function expandHome(p) { return String(p || "").replace(/^~(?=\/)/, Quickshell.env("HOME")) }
  function instanceNamed(name) {
    for (var i = 0; i < instances.length; i++) if (instances[i].name === name) return instances[i]
    return null
  }

  // Re-reading instances.json on every poll picks up a file created or edited after start;
  // the FileView handlers then poll the instances.
  function refresh() { instancesView.reload() }

  function loadInstances(text) {
    var next = [], err = ""
    try {
      next = Alerts.parseInstances(text, grafanaUrl, tokenFile)
    } catch (e) {
      err = "instances.json: " + e.message
    }
    if (JSON.stringify(next) !== JSON.stringify(configured) || err !== configError) {
      configured = next
      configError = err
      rowsByInstance = {}
      errors = {}
      known = {}
      silencesByInstance = {}
      silenceErrors = {}
      pendingByInstance = {}
      pendingErrors = {}
      oncallByInstance = {}
      oncallErrors = {}
    }
    poll()
  }

  function poll() {
    if (demo) {
      for (var i = 0; i < instances.length; i++) {
        var raw = Alerts.demoAlerts(Date.now(), demoSilences, instances[i].name)
        if (raw === null) fail(instances[i].name, "demo: connection refused", "")
        else apply(instances[i].name, raw)
        var name = instances[i].name
        set("silencesByInstance", name, Alerts.normalizeSilences(demoSilences.filter(function(s) { return s.instance === name }), name))
        if (instances[i].type === "grafana") set("pendingByInstance", name, Alerts.normalizePending(Alerts.demoPending(Date.now(), name), instances[i]))
        if (instances[i].oncall) set("oncallByInstance", name, Alerts.normalizeOncall(Alerts.demoOncall(Date.now(), name)))
      }
      return
    }
    for (var j = 0; j < fetchers.count; j++) {
      var f = fetchers.objectAt(j)
      if (f && !f.running) f.running = true
    }
    for (var k = 0; k < silenceFetchers.count; k++) {
      var sf = silenceFetchers.objectAt(k)
      if (sf && !sf.running) sf.running = true
    }
    for (var p = 0; p < pendingFetchers.count; p++) {
      var pf = pendingFetchers.objectAt(p)
      if (pf && !pf.running) pf.running = true
    }
    for (var o = 0; o < oncallFetchers.count; o++) {
      var of = oncallFetchers.objectAt(o)
      if (of && !of.running) of.running = true
    }
  }

  function apply(name, raw) {
    var next = Alerts.normalize(raw, name)
    var fresh = Alerts.toNotify(next, known[name] === undefined ? null : known[name], notify, dndUntil, Date.now())
    for (var i = 0; i < fresh.length; i++) notifyAlert(fresh[i])
    set("known", name, Alerts.fingerprints(next))
    set("rowsByInstance", name, next)
    set("errors", name, "")
    updatedAt = Date.now()
  }

  // An unreachable instance loses its rows but keeps `known`, so its alerts are not
  // announced again when it comes back.
  function fail(name, stdout, stderr) {
    set("errors", name, errorText(stdout, stderr))
    set("rowsByInstance", name, [])
  }

  function errorText(stdout, stderr) {
    var msg = (stderr || stdout || "request failed").trim().split("\n")[0]
    return msg.length > 160 ? msg.slice(0, 157) + "..." : msg
  }

  // Maps are replaced, not mutated, so bindings on them re-evaluate.
  function set(prop, name, value) {
    var m = Object.assign({}, root[prop])
    m[name] = value
    root[prop] = m
  }

  function notifyAlert(row) {
    var body = row.summary || row.labelText
    Quickshell.execDetached(["notify-send", "--app-name=Grafana Alerts",
      "-u", row.severity === "critical" ? "critical" : "normal",
      "--", row.name, instances.length > 1 ? "[" + row.instance + "] " + body : body])
  }

  function openAlert(row) {
    if (row.url !== "") Qt.openUrlExternally(row.url)
  }

  function silence(row, minutes) {
    if (demo) {
      var body = Alerts.silenceBody(row, minutes, Date.now(), Quickshell.env("USER"))
      body.instance = row.instance
      body.id = "demo-" + Date.now()
      body.status = { state: "active" }
      demoSilences = demoSilences.concat([body])
      poll()
      return
    }
    var inst = instanceNamed(row.instance)
    if (!inst || silenceProcess.running) return
    silenceProcess.instance = inst.name
    silenceProcess.command = ["sh", "-c", curlScript, "sh", expandHome(inst.tokenFile),
      "-H", "Content-Type: application/json",
      "--data-binary", JSON.stringify(Alerts.silenceBody(row, minutes, Date.now(), Quickshell.env("USER"))),
      Alerts.apiBase(inst) + "/silences"]
    silenceProcess.running = true
  }

  // Ends a silence early (DELETE <prefix>/silence/{id}) on its own instance, then reloads alerts and silences.
  function expire(silence) {
    if (demo) {
      demoSilences = demoSilences.filter(function(s) { return !(s.instance === silence.instance && s.id === silence.id) })
      poll()
      return
    }
    var inst = instanceNamed(silence.instance)
    if (!inst || expireProcess.running) return
    expireProcess.instance = inst.name
    expireProcess.command = ["sh", "-c", curlScript, "sh", expandHome(inst.tokenFile),
      "-X", "DELETE", Alerts.expireUrl(inst, silence.id)]
    expireProcess.running = true
  }

  // minutes 0 = until turned off; any call while DND is on turns it off.
  function toggleDnd(minutes) {
    now = Date.now()
    dndUntil = Alerts.dndToggle(dndUntil, now, minutes)
    dndWriter.command = ["sh", "-c", 'umask 077; mkdir -p "$1" && printf "%s\\n" "$2" > "$1/dnd.tmp" && mv "$1/dnd.tmp" "$1/dnd"',
      "sh", stateDir, String(dndUntil)]
    dndWriter.running = true
  }

  onGrafanaUrlChanged: refresh()
  onTokenFileChanged: refresh()

  FileView {
    id: instancesView
    path: root.expandHome(root.instancesFile)
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.loadInstances(text())
    onLoadFailed: root.loadInstances(null)
  }

  FileView {
    path: root.stateDir + "/dnd"
    printErrors: false
    onLoaded: root.dndUntil = Alerts.parseDnd(text())
  }

  Process { id: dndWriter }

  IpcHandler {
    target: "dan4a.grafana-alerts"
    function refresh(): void { root.refresh() }
    function dnd(minutes: int): void { root.toggleDnd(minutes) }
  }

  Timer {
    interval: Math.max(15, root.intervalSec) * 1000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  // Ticks durations ("12m") without hitting the API.
  Timer {
    interval: 30000
    running: true
    repeat: true
    onTriggered: root.now = Date.now()
  }

  // One fetch process per configured instance, so a slow or dead instance does not hold up the others.
  Instantiator {
    id: fetchers
    model: root.configured
    delegate: Process {
      required property var modelData
      command: ["sh", "-c", root.curlScript, "sh", root.expandHome(modelData.tokenFile),
        Alerts.alertsUrl(modelData)]
      stdout: StdioCollector { id: fetchOut; waitForEnd: true }
      stderr: StdioCollector { id: fetchErr; waitForEnd: true }
      onExited: function(exitCode) {
        var out = String(fetchOut.text || "")
        if (exitCode !== 0) { root.fail(modelData.name, out, String(fetchErr.text || "")); return }
        try {
          root.apply(modelData.name, JSON.parse(out))
        } catch (e) {
          root.fail(modelData.name, "unexpected response: " + out.slice(0, 80), "")
        }
      }
    }
  }

  Instantiator {
    id: silenceFetchers
    model: root.configured
    delegate: Process {
      required property var modelData
      command: ["sh", "-c", root.curlScript, "sh", root.expandHome(modelData.tokenFile), Alerts.silencesUrl(modelData)]
      stdout: StdioCollector { id: silencesOut; waitForEnd: true }
      stderr: StdioCollector { id: silencesErr; waitForEnd: true }
      onExited: function(exitCode) {
        var out = String(silencesOut.text || "")
        var list = null, err = ""
        if (exitCode !== 0) err = root.errorText(out, String(silencesErr.text || ""))
        else {
          try { list = JSON.parse(out) } catch (e) { err = "unexpected response: " + out.slice(0, 80) }
        }
        root.set("silencesByInstance", modelData.name, Alerts.normalizeSilences(list, modelData.name))
        root.set("silenceErrors", modelData.name, err)
      }
    }
  }

  Instantiator {
    id: pendingFetchers
    model: root.grafanaInstances
    delegate: Process {
      required property var modelData
      command: ["sh", "-c", root.curlScript, "sh", root.expandHome(modelData.tokenFile), Alerts.rulesUrl(modelData)]
      stdout: StdioCollector { id: pendingOut; waitForEnd: true }
      stderr: StdioCollector { id: pendingErr; waitForEnd: true }
      onExited: function(exitCode) {
        var out = String(pendingOut.text || "")
        var raw = null, err = ""
        if (exitCode !== 0) err = root.errorText(out, String(pendingErr.text || ""))
        else {
          try { raw = JSON.parse(out) } catch (e) { err = "unexpected response: " + out.slice(0, 80) }
        }
        root.set("pendingByInstance", modelData.name, Alerts.normalizePending(raw, modelData))
        root.set("pendingErrors", modelData.name, err)
      }
    }
  }

  Instantiator {
    id: oncallFetchers
    model: root.oncallInstances
    delegate: Process {
      required property var modelData
      command: ["sh", "-c", root.oncallScript, "sh", root.expandHome(modelData.tokenFile), modelData.url, modelData.oncall.url,
        root.oncallRange.from, root.oncallRange.to]
      stdout: StdioCollector { id: oncallOut; waitForEnd: true }
      stderr: StdioCollector { id: oncallErr; waitForEnd: true }
      // A failed request keeps the last schedules, so a blip does not blank the section; the error is shown instead.
      onExited: function(exitCode) {
        var out = String(oncallOut.text || "")
        if (exitCode !== 0) { root.set("oncallErrors", modelData.name, root.errorText(out, String(oncallErr.text || ""))); return }
        try {
          root.set("oncallByInstance", modelData.name, Alerts.normalizeOncall(JSON.parse(out)))
          root.set("oncallErrors", modelData.name, "")
        } catch (e) {
          root.set("oncallErrors", modelData.name, "unexpected response: " + out.slice(0, 80))
        }
      }
    }
  }

  Process {
    id: expireProcess
    property string instance: ""
    stdout: StdioCollector { id: expireOut; waitForEnd: true }
    stderr: StdioCollector { id: expireErr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.set("silenceErrors", instance, "expire: " + root.errorText(String(expireOut.text || ""), String(expireErr.text || "")))
      else root.poll()
    }
  }

  Process {
    id: silenceProcess
    property string instance: ""
    stdout: StdioCollector { id: silenceOut; waitForEnd: true }
    stderr: StdioCollector { id: silenceErr; waitForEnd: true }
    // A failed silence keeps the rows and shows the error until the next poll.
    onExited: function(exitCode) {
      if (exitCode !== 0) root.set("errors", instance, "silence: " + root.errorText(String(silenceOut.text || ""), String(silenceErr.text || "")))
      else root.poll()
    }
  }
}

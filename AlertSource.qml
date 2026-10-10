import QtQuick
import Quickshell
import Quickshell.Io
import "Alerts.js" as Alerts

// Polls Grafana-managed alerts (or generates demo ones) and raises desktop notifications for new ones.
// Loaded once as the plugin's service: every monitor's bar widget shares it, so there is one poll
// and one notification per alert no matter how many bars are on screen.
Item {
  id: root

  property string grafanaUrl: ""
  property string tokenFile: ""
  property int intervalSec: 60
  property bool notify: true
  // Demo mode needs no Grafana: it is on whenever no URL is configured.
  readonly property bool demo: grafanaUrl.trim() === ""

  property var rows: []
  readonly property var summary: Alerts.summarize(rows)
  property string error: ""
  property double updatedAt: 0
  property double now: Date.now()

  property var known: null
  property var demoSilences: ({})

  readonly property string baseUrl: grafanaUrl.trim().replace(/\/+$/, "")
  readonly property string tokenPath: tokenFile.replace(/^~(?=\/)/, Quickshell.env("HOME"))

  function refresh() {
    if (demo) {
      apply(Alerts.demoAlerts(Date.now(), demoSilences))
      return
    }
    if (fetchProcess.running) return
    // The token is read inside sh and handed to curl on stdin, so it never shows up in argv / ps.
    fetchProcess.command = ["sh", "-c",
      'set -e; t=$(cat "$1"); printf \'header = "Authorization: Bearer %s"\\n\' "$t" | ' +
      'curl -sS --fail-with-body --max-time 10 -K - "$2"',
      "sh", tokenPath, baseUrl + "/api/alertmanager/grafana/api/v2/alerts?active=true&inhibited=false"]
    fetchProcess.running = true
  }

  function apply(raw) {
    var next = Alerts.normalize(raw)
    if (notify) {
      var fresh = Alerts.newAlerts(next, known)
      for (var i = 0; i < fresh.length; i++) notifyAlert(fresh[i])
    }
    known = Alerts.fingerprints(next)
    rows = next
    error = ""
    updatedAt = Date.now()
  }

  function notifyAlert(row) {
    Quickshell.execDetached(["notify-send", "--app-name=Grafana",
      "-u", row.severity === "critical" ? "critical" : "normal",
      "--", row.name, row.summary || row.labelText])
  }

  function openAlert(row) {
    if (row.url !== "") Qt.openUrlExternally(row.url)
  }

  function silence(row, minutes) {
    if (demo) {
      var s = Object.assign({}, demoSilences)
      s[row.fingerprint] = true
      demoSilences = s
      refresh()
      return
    }
    if (silenceProcess.running) return
    silenceProcess.command = ["sh", "-c",
      'set -e; t=$(cat "$1"); printf \'header = "Authorization: Bearer %s"\\n\' "$t" | ' +
      'curl -sS --fail-with-body --max-time 10 -K - -H "Content-Type: application/json" --data-binary "$3" "$2"',
      "sh", tokenPath, baseUrl + "/api/alertmanager/grafana/api/v2/silences",
      JSON.stringify(Alerts.silenceBody(row, minutes, Date.now(), Quickshell.env("USER")))]
    silenceProcess.running = true
  }

  function failure(stdout, stderr) {
    var msg = (stderr || stdout || "request failed").trim().split("\n")[0]
    error = msg.length > 160 ? msg.slice(0, 157) + "..." : msg
  }

  onGrafanaUrlChanged: { known = null; refresh() }
  Component.onCompleted: refresh()

  IpcHandler {
    target: "dan4a.grafana-alerts"
    function refresh(): void { root.refresh() }
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

  Process {
    id: fetchProcess
    stdout: StdioCollector { id: fetchOut; waitForEnd: true }
    stderr: StdioCollector { id: fetchErr; waitForEnd: true }
    onExited: function(exitCode) {
      var out = String(fetchOut.text || "")
      if (exitCode !== 0) { root.failure(out, String(fetchErr.text || "")); return }
      try {
        root.apply(JSON.parse(out))
      } catch (e) {
        root.failure("unexpected response: " + out.slice(0, 80), "")
      }
    }
  }

  Process {
    id: silenceProcess
    stdout: StdioCollector { id: silenceOut; waitForEnd: true }
    stderr: StdioCollector { id: silenceErr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.failure(String(silenceOut.text || ""), String(silenceErr.text || ""))
      root.refresh()
    }
  }
}

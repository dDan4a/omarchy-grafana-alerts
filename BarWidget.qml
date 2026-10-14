import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "dan4a.grafana-alerts"

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property real openPanelIndicatorWidth: button.implicitWidth
  readonly property real openPanelIndicatorHeight: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  // One service instance shared by the widgets on every monitor (see AlertSource.qml).
  readonly property var source: bar && bar.shell ? bar.shell.serviceFor("dan4a.grafana-alerts") : null
  readonly property var summary: source ? source.summary : ({ critical: 0, warning: 0, info: 0, silenced: 0, total: 0 })
  readonly property string error: source ? source.error : ""
  readonly property bool dnd: source ? source.dnd === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    target.bar = root.bar
    target.settings = root.settings
    target.anchorItem = button
    target.hostWidget = root
    target.source = root.source
  }

  // Settings live on the bar widget entry; the service has none of its own, so push them in.
  function configureSource() {
    if (!source) return
    source.instancesFile = String(setting("instancesFile", "~/.config/grafana-alerts/instances.json"))
    source.grafanaUrl = String(setting("grafanaUrl", ""))
    source.tokenFile = String(setting("tokenFile", "~/.config/grafana-alerts/token"))
    source.intervalSec = Number(setting("refreshIntervalSec", 60))
    source.notify = setting("notify", true) === true
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  onBarChanged: injectPanel()
  onSettingsChanged: { configureSource(); injectPanel() }
  onSourceChanged: { configureSource(); injectPanel() }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: { root.injectPanel(); Qt.callLater(root.injectPanel) }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    active: root.opened
    // nf-md-bell / nf-md-bell_alert; nf-md-bell_off while do not disturb is on
    text: (root.dnd ? "󰂛" : root.summary.total > 0 ? "󰂞" : "󰂚") + (root.summary.total > 0 ? " " + root.summary.total : "")
    foreground: root.summary.critical > 0 ? Color.urgent : (root.bar ? root.bar.barForeground : Color.foreground)
    dimmed: root.summary.total === 0 && root.error === ""
    tooltipText: (root.error !== "" ? "Alerts: " + root.error
      : root.summary.total === 0 ? "Alerts: all quiet"
      : "Alerts: " + root.summary.critical + " critical, " + root.summary.warning + " warning, " + root.summary.info + " info")
      + (root.dnd ? "\nDo not disturb: " + root.source.dndText : "")
    onPressed: root.togglePanel()
  }
}

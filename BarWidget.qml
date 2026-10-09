import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "dan4a.grafana-alerts"

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property real openPanelIndicatorWidth: button.implicitWidth
  readonly property real openPanelIndicatorHeight: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  readonly property var summary: source.summary

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
    target.source = source
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  AlertSource {
    id: source
    grafanaUrl: String(root.setting("grafanaUrl", ""))
    tokenFile: String(root.setting("tokenFile", "~/.config/grafana-alerts/token"))
    intervalSec: Number(root.setting("refreshIntervalSec", 60))
    notify: root.setting("notify", true) === true
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: { root.injectPanel(); Qt.callLater(root.injectPanel) }
  }

  IpcHandler {
    target: "dan4a.grafana-alerts"
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.togglePanel() }
    function refresh(): void { source.refresh() }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    active: root.opened
    // nf-md-bell / nf-md-bell_alert
    text: root.summary.total > 0 ? "󰂞 " + root.summary.total : "󰂚"
    foreground: root.summary.critical > 0 ? Color.urgent : (root.bar ? root.bar.barForeground : Color.foreground)
    dimmed: root.summary.total === 0 && source.error === ""
    tooltipText: source.error !== "" ? "Grafana: " + source.error
      : root.summary.total === 0 ? "Grafana: all quiet"
      : "Grafana: " + root.summary.critical + " critical, " + root.summary.warning + " warning, " + root.summary.info + " info"
    onPressed: root.togglePanel()
  }
}

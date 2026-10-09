import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Alerts.js" as Alerts

Panel {
  id: root
  moduleName: "dan4a.grafana-alerts"
  ipcTarget: moduleName
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var source: null
  readonly property var barIdentity: hostWidget || root
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.4)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property var rows: source ? source.rows : []
  readonly property var summary: source ? source.summary : Alerts.summarize([])
  property int selected: 0

  function open() { root.selected = 0; root.controller.show() }
  function close() { root.controller.hide() }
  function toggle() { root.opened ? root.close() : root.open() }
  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function severityColor(row) {
    if (row.silenced) return root.dim
    if (row.severity === "critical") return Color.urgent
    if (row.severity === "warning") return Color.accent
    return Color.muted
  }

  function heroMeta() {
    if (!source) return ""
    if (summary.total === 0) return summary.silenced > 0 ? "All quiet · " + summary.silenced + " silenced" : "All quiet"
    var parts = []
    if (summary.critical) parts.push(summary.critical + " critical")
    if (summary.warning) parts.push(summary.warning + " warning")
    if (summary.info) parts.push(summary.info + " info")
    if (summary.silenced) parts.push(summary.silenced + " silenced")
    return parts.join(" · ")
  }

  function statusLine() {
    if (!source) return ""
    if (source.error !== "") return source.error
    var updated = source.updatedAt > 0 ? "Updated " + Alerts.duration(new Date(source.updatedAt).toISOString(), source.now) + " ago" : "Loading…"
    return source.demo ? updated + " · set grafanaUrl in the widget settings to connect" : updated
  }

  onRowsChanged: if (selected >= rows.length) selected = Math.max(0, rows.length - 1)

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (root.rows.length === 0) return
        root.selected = Math.max(0, Math.min(root.rows.length - 1, root.selected + dy))
        list.positionViewAtIndex(root.selected, ListView.Contain)
      }
      onActivateRequested: if (root.rows.length > 0) root.source.openAlert(root.rows[root.selected])
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        var key = text.toLowerCase()
        if (key === "r") root.source.refresh()
        else if (key === "s" && root.rows.length > 0 && !root.rows[root.selected].silenced)
          root.source.silence(root.rows[root.selected], 60)
      }

      Column {
        id: contentColumn
        width: parent.width
        spacing: Style.space(10)

        PanelHero {
          width: parent.width
          title: "Grafana alerts"
          meta: root.heroMeta()
          detail: !root.source ? "" : root.source.error !== "" ? "Error" : root.source.demo ? "Demo" : ""
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconComponent: Text {
            text: root.summary.total > 0 ? "󰂞" : "󰂚"
            color: root.summary.critical > 0 ? Color.urgent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.display
          }
        }

        Text {
          width: parent.width
          text: root.statusLine()
          color: root.source && root.source.error !== "" ? Color.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.Wrap
          textFormat: Text.PlainText
        }

        PanelSeparator { width: parent.width }

        Text {
          visible: root.rows.length === 0
          width: parent.width
          text: root.source && root.source.error !== "" ? "Could not load alerts." : "Nothing is firing. 🎉"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          horizontalAlignment: Text.AlignHCenter
          topPadding: Style.space(8)
          bottomPadding: Style.space(8)
        }

        ListView {
          id: list
          visible: root.rows.length > 0
          width: parent.width
          height: Math.min(contentHeight, Style.space(420))
          clip: true
          spacing: Style.space(4)
          model: root.rows
          boundsBehavior: Flickable.StopAtBounds

          delegate: Rectangle {
            id: rowItem
            required property var modelData
            required property int index
            readonly property bool isSelected: index === root.selected

            width: ListView.view.width
            height: rowColumn.implicitHeight + Style.space(12)
            radius: Style.space(6)
            color: isSelected || hover.hovered ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08) : "transparent"
            opacity: modelData.silenced ? 0.55 : 1

            HoverHandler { id: hover }
            TapHandler {
              onTapped: { root.selected = rowItem.index; root.source.openAlert(rowItem.modelData) }
            }

            Rectangle {
              id: dot
              width: Style.space(8)
              height: width
              radius: width / 2
              color: root.severityColor(rowItem.modelData)
              anchors.left: parent.left
              anchors.leftMargin: Style.space(8)
              y: Style.space(6) + nameText.height / 2 - height / 2
            }

            Column {
              id: rowColumn
              anchors.left: dot.right
              anchors.leftMargin: Style.space(8)
              anchors.right: actions.left
              anchors.rightMargin: Style.space(6)
              y: Style.space(6)
              spacing: Style.space(2)

              Text {
                id: nameText
                width: parent.width
                text: rowItem.modelData.name + (rowItem.modelData.silenced ? "  (silenced)" : "")
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.subtitle
                font.bold: true
                elide: Text.ElideRight
                textFormat: Text.PlainText
              }
              Text {
                visible: text !== ""
                width: parent.width
                text: rowItem.modelData.summary
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                wrapMode: Text.Wrap
                maximumLineCount: 2
                elide: Text.ElideRight
                textFormat: Text.PlainText
              }
              Text {
                visible: text !== ""
                width: parent.width
                text: rowItem.modelData.labelText
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
                textFormat: Text.PlainText
              }
            }

            Row {
              id: actions
              anchors.right: parent.right
              anchors.rightMargin: Style.space(4)
              y: Style.space(4)
              spacing: Style.space(2)

              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: root.source ? Alerts.duration(rowItem.modelData.startsAt, root.source.now) : ""
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                rightPadding: Style.space(4)
              }
              PanelActionButton {
                visible: !rowItem.modelData.silenced
                iconText: "󰂛" // nf-md-bell_off
                tooltipText: "Silence for 1 hour (s)"
                foreground: root.foreground
                onClicked: root.source.silence(rowItem.modelData, 60)
              }
              PanelActionButton {
                visible: rowItem.modelData.url !== ""
                iconText: "󰏌" // nf-md-open_in_new
                tooltipText: "Open in Grafana (Enter)"
                foreground: root.foreground
                onClicked: root.source.openAlert(rowItem.modelData)
              }
            }
          }
        }

        Text {
          width: parent.width
          text: "↑↓ select · Enter open · s silence 1h · r refresh"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
        }
      }
    }
  }
}

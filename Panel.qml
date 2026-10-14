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
  // Rows grouped by instance, with a header per instance when there are several, then pending alerts and active silences.
  readonly property var items: source
    ? Alerts.panelItems(source.instances, source.rowsByInstance, source.errors, source.silencesByInstance, source.silenceErrors,
      source.pendingByInstance, source.pendingErrors) : []
  readonly property var current: selected >= 0 && selected < items.length && !items[selected].header ? items[selected] : null
  readonly property var summary: source ? source.summary : Alerts.summarize([])
  property int selected: 0

  function open() { root.selected = Alerts.firstRow(root.items); root.controller.show() }
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
    return source.demo ? updated + " · demo: create instances.json or set the Grafana URL in the widget settings" : updated
  }

  onItemsChanged: if (!current) selected = Alerts.firstRow(items)

  function headerText(item) {
    if (item.pending) return "Pending · " + item.count + (item.error !== "" ? " · could not load: " + item.error : "")
    if (item.silences) return "Silences · " + item.count + (item.error !== "" ? " · could not load: " + item.error : "")
    var name = item.filter !== "" ? item.instance + " {" + item.filter + "}" : item.instance
    if (item.error !== "") return name + " · unreachable: " + item.error
    return name + " · " + (item.count > 0 ? item.count + " firing" : "all quiet")
  }

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
        if (!root.current) return
        root.selected = Alerts.step(root.items, root.selected, dy)
        list.positionViewAtIndex(root.selected, ListView.Contain)
      }
      onActivateRequested: if (root.current && !root.current.isSilence) root.source.openAlert(root.current)
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        var key = text.toLowerCase()
        if (key === "r") root.source.refresh()
        else if (key === "s" && root.current && !root.current.isSilence && !root.current.isPending && !root.current.silenced)
          root.source.silence(root.current, 60)
        else if (key === "u" && root.current && root.current.isSilence)
          root.source.expire(root.current)
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
          visible: root.items.length > 0
          width: parent.width
          height: Math.min(contentHeight, Style.space(420))
          clip: true
          spacing: Style.space(4)
          model: root.items
          boundsBehavior: Flickable.StopAtBounds

          delegate: Loader {
            id: itemLoader
            required property var modelData
            required property int index
            width: ListView.view.width
            sourceComponent: modelData.header ? headerComponent : modelData.isSilence ? silenceComponent : rowComponent
          }

          Component {
            id: headerComponent
            Text {
              readonly property var modelData: parent ? parent.modelData : ({})
              width: parent ? parent.width : 0
              text: root.headerText(modelData)
              color: modelData.error ? Color.urgent : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              topPadding: Style.space(6)
              leftPadding: Style.space(8)
              elide: Text.ElideRight
              textFormat: Text.PlainText
            }
          }

          Component {
            id: silenceComponent
            Rectangle {
              id: silenceItem
              readonly property var modelData: parent ? parent.modelData : ({})
              readonly property int index: parent ? parent.index : -1

              width: parent ? parent.width : 0
              height: silenceColumn.implicitHeight + Style.space(12)
              radius: Style.space(6)
              color: index === root.selected || silenceHover.hovered ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08) : "transparent"

              HoverHandler { id: silenceHover }
              TapHandler { onTapped: root.selected = silenceItem.index }

              Column {
                id: silenceColumn
                anchors.left: parent.left
                anchors.leftMargin: Style.space(24)
                anchors.right: silenceActions.left
                anchors.rightMargin: Style.space(6)
                y: Style.space(6)
                spacing: Style.space(2)

                Text {
                  width: parent.width
                  text: silenceItem.modelData.matcherText
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
                  text: [root.source && root.source.instances.length > 1 ? silenceItem.modelData.instance : "",
                    silenceItem.modelData.createdBy, silenceItem.modelData.comment].filter(function(t) { return t !== "" }).join(" · ")
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  textFormat: Text.PlainText
                }
              }

              Row {
                id: silenceActions
                anchors.right: parent.right
                anchors.rightMargin: Style.space(4)
                y: Style.space(4)
                spacing: Style.space(2)

                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  text: root.source ? "ends in " + Alerts.remaining(silenceItem.modelData.endsAt, root.source.now) : ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  rightPadding: Style.space(4)
                }
                PanelActionButton {
                  iconText: "󰂚" // nf-md-bell
                  tooltipText: "Expire silence (u)"
                  foreground: root.foreground
                  onClicked: root.source.expire(silenceItem.modelData)
                }
              }
            }
          }

          Component {
            id: rowComponent
            Rectangle {
              id: rowItem
              readonly property var modelData: parent ? parent.modelData : ({})
              readonly property int index: parent ? parent.index : -1
              readonly property bool isSelected: index === root.selected

              width: parent ? parent.width : 0
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
                  visible: !rowItem.modelData.silenced && !rowItem.modelData.isPending
                  iconText: "󰂛" // nf-md-bell_off
                  tooltipText: "Silence for 1 hour (s)"
                  foreground: root.foreground
                  onClicked: root.source.silence(rowItem.modelData, 60)
                }
                PanelActionButton {
                  visible: rowItem.modelData.url !== ""
                  iconText: "󰏌" // nf-md-open_in_new
                  tooltipText: "Open alert source (Enter)"
                  foreground: root.foreground
                  onClicked: root.source.openAlert(rowItem.modelData)
                }
              }
            }
          }
        }

        Text {
          width: parent.width
          text: "↑↓ select · Enter open · s silence 1h · u expire silence · r refresh"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
        }
      }
    }
  }
}

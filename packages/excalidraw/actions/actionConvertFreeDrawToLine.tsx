import { arrayToMap } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/element";
import {
  canConvertFreeDrawToLine,
  freeDrawToLine,
} from "@excalidraw/element/freeDrawToLine";
import { LinearElementEditor } from "@excalidraw/element/linearElementEditor";
import { newElementWith } from "@excalidraw/element/mutateElement";

import { IconButton } from "../components/IconButton";
import { lineEditorIcon } from "../components/icons";
import { t } from "../i18n";

import { register } from "./register";

export const actionConvertFreeDrawToLine = register({
  name: "convertFreeDrawToLine",
  label: "labels.convertFreeDrawToLine",
  icon: lineEditorIcon,
  keywords: ["freedraw", "pen", "points", "convert", "line"],
  trackEvent: { category: "element" },
  predicate: (elements, appState, _, app) => {
    const selected = app.scene.getSelectedElements(appState);
    return selected.length > 0 && selected.every(canConvertFreeDrawToLine);
  },
  perform(elements, appState, _, app) {
    const selected = app.scene.getSelectedElements(appState);
    if (!selected.length || !selected.every(canConvertFreeDrawToLine)) {
      return false;
    }

    const converted = new Map(
      selected.map((element) => [element.id, freeDrawToLine(element)]),
    );
    const nextElements = elements.flatMap((element) => {
      const line = converted.get(element.id);
      return line
        ? [newElementWith(element, { isDeleted: true }), line]
        : [element];
    });
    const lines = [...converted.values()];

    return {
      elements: nextElements,
      appState: {
        ...appState,
        selectedElementIds: Object.fromEntries(
          lines.map(({ id }) => [id, true]),
        ),
        selectedLinearElement:
          lines.length === 1
            ? new LinearElementEditor(lines[0], arrayToMap(nextElements), true)
            : null,
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ appState, app, updateData }) => {
    const selected = app.scene.getSelectedElements(appState);
    if (!selected.length || !selected.every(canConvertFreeDrawToLine)) {
      return null;
    }
    return (
      <IconButton
        type="button"
        icon={lineEditorIcon}
        aria-label={t("labels.convertFreeDrawToLine")}
        title={t("labels.convertFreeDrawToLineDescription")}
        onClick={() => updateData(null)}
      />
    );
  },
});

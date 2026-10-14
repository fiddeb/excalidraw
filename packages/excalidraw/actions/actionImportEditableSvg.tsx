import { CaptureUpdateAction, getCommonBounds } from "@excalidraw/element";
import { newElementWith } from "@excalidraw/element/mutateElement";

import { importEditableSvg } from "../data/editableSvg";

import { t } from "../i18n";
import { LoadIcon } from "../components/icons";

import { register } from "./register";

import type { EditableSvgResult } from "../data/editableSvg";

export const actionImportEditableSvg = register<
  string | EditableSvgResult | null
>({
  name: "importEditableSvg",
  label: "labels.importEditableSvg",
  icon: LoadIcon,
  keywords: ["svg", "import", "vector", "editable"],
  trackEvent: { category: "element" },
  predicate: (_elements, appState) => !appState.viewModeEnabled,
  perform(elements, appState, source, app) {
    if (appState.viewModeEnabled) {
      return false;
    }
    if (!source) {
      return {
        appState: { ...appState, openDialog: { name: "editableSvg" } },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }
    let result;
    try {
      result =
        typeof source === "string"
          ? importEditableSvg(source, app.ownerWindow.DOMParser)
          : source;
    } catch {
      return {
        appState: {
          ...appState,
          toast: { message: t("editableSvg.invalid"), closable: true },
        },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }
    if (!result.elements.length) {
      return false;
    }
    const [minX, minY, maxX, maxY] = getCommonBounds(result.elements);
    const centerX =
      -appState.scrollX + appState.width / (2 * appState.zoom.value);
    const centerY =
      -appState.scrollY + appState.height / (2 * appState.zoom.value);
    const imported = result.elements.map((element) =>
      newElementWith(element, {
        x: element.x + centerX - (minX + maxX) / 2,
        y: element.y + centerY - (minY + maxY) / 2,
      }),
    );
    app.focusContainer();
    return {
      elements: [...elements, ...imported],
      appState: {
        ...appState,
        openDialog: null,
        selectedElementIds: Object.fromEntries(
          imported.map(({ id }) => [id, true]),
        ),
        selectedGroupIds: {},
        selectedLinearElement: null,
        activeTool: {
          ...appState.activeTool,
          type: "selection",
          customType: null,
        },
        toast: null,
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

import { arrayToMap } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/element";
import {
  canCreateRingSegment,
  ellipseToRingSegmentElements,
  isValidRingSegment,
} from "@excalidraw/element/ringSegment";
import { LinearElementEditor } from "@excalidraw/element/linearElementEditor";
import { newElementWith } from "@excalidraw/element/mutateElement";

import type { RingSegmentOptions } from "@excalidraw/element/ringSegment";

import { IconButton } from "../components/IconButton";
import { polygonIcon } from "../components/icons";
import { t } from "../i18n";

import { register } from "./register";

export const actionCreateRingSegment = register<RingSegmentOptions | null>({
  name: "createRingSegment",
  label: "labels.createRingSegment",
  icon: polygonIcon,
  keywords: ["ring", "arc", "donut", "sector", "sunburst"],
  trackEvent: { category: "element" },
  predicate: (elements, appState, _, app) => {
    const selected = app.scene.getSelectedElements(appState);
    return selected.length === 1 && canCreateRingSegment(selected[0]);
  },
  perform(elements, appState, options, app) {
    const source =
      appState.openDialog?.name === "ringSegment"
        ? app.scene
            .getNonDeletedElementsMap()
            .get(appState.openDialog.sourceElementId)
        : app.scene.getSelectedElements(appState)[0];
    if (!source || !canCreateRingSegment(source)) {
      return false;
    }
    if (!options) {
      if (app.scene.getSelectedElements(appState).length !== 1) {
        return false;
      }
      return {
        appState: {
          ...appState,
          openDialog: { name: "ringSegment", sourceElementId: source.id },
        },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }
    if (!isValidRingSegment(options)) {
      return false;
    }
    const lines = ellipseToRingSegmentElements(source, options);
    const nextElements = elements.flatMap((element) =>
      element.id === source.id
        ? [newElementWith(element, { isDeleted: true }), ...lines]
        : [element],
    );
    return {
      elements: nextElements,
      appState: {
        ...appState,
        openDialog: null,
        selectedElementIds: Object.fromEntries(
          lines.map(({ id }) => [id, true]),
        ),
        selectedGroupIds: {},
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
    return selected.length === 1 && canCreateRingSegment(selected[0]) ? (
      <IconButton
        type="button"
        icon={polygonIcon}
        aria-label={t("labels.createRingSegment")}
        title={t("labels.createRingSegmentDescription")}
        onClick={() => updateData(null)}
      />
    ) : null;
  },
});

import { CaptureUpdateAction } from "@excalidraw/element";
import {
  canCutAtIntersections,
  cutAtIntersections,
} from "@excalidraw/element/cutAtIntersections";
import { newElementWith } from "@excalidraw/element/mutateElement";

import { IconButton } from "../components/IconButton";
import { lineEditorIcon } from "../components/icons";
import { t } from "../i18n";

import { register } from "./register";

export const actionCutAtIntersections = register({
  name: "cutAtIntersections",
  label: "labels.cutAtIntersections",
  icon: lineEditorIcon,
  keywords: ["cut", "split", "intersection", "outline"],
  trackEvent: { category: "element" },
  predicate: (elements, appState, _, app) =>
    canCutAtIntersections(app.scene.getSelectedElements(appState)),
  perform(elements, appState, _, app) {
    const selected = app.scene.getSelectedElements(appState);
    const result = cutAtIntersections(
      selected,
      app.scene.getNonDeletedElementsMap(),
    );
    if (!result.ok) {
      return {
        appState: {
          ...appState,
          toast: {
            message: t(`outlineCut.${result.reason}`),
            closable: true,
            duration: 6000,
          },
        },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }
    const next = elements.flatMap((element) => {
      const parts = result.replacements.get(element.id);
      return parts
        ? [newElementWith(element, { isDeleted: true }), ...parts]
        : [element];
    });
    const selectedIds = selected.flatMap(
      (element) =>
        result.replacements.get(element.id)?.map(({ id }) => id) || [
          element.id,
        ],
    );
    app.focusContainer();
    return {
      elements: next,
      appState: {
        ...appState,
        selectedElementIds: Object.fromEntries(
          selectedIds.map((id) => [id, true]),
        ),
        selectedGroupIds: {},
        selectedLinearElement: null,
        toast: null,
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ appState, app, updateData }) =>
    canCutAtIntersections(app.scene.getSelectedElements(appState)) ? (
      <IconButton
        type="button"
        icon={lineEditorIcon}
        aria-label={t("labels.cutAtIntersections")}
        title={t("labels.cutAtIntersectionsDescription")}
        onClick={() => updateData(null)}
      />
    ) : null,
});

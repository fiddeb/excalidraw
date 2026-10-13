import { arrayToMap } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/element";
import {
  canBooleanShapes,
  booleanShapes,
} from "@excalidraw/element/booleanOperations";
import { LinearElementEditor } from "@excalidraw/element/linearElementEditor";
import { newElementWith } from "@excalidraw/element/mutateElement";

import type { BooleanShapeOperation } from "@excalidraw/element/booleanOperations";

import { IconButton } from "../components/IconButton";
import {
  polygonIcon,
  booleanIntersectionIcon,
  booleanDifferenceIcon,
  booleanXorIcon,
} from "../components/icons";

import { t } from "../i18n";

import { register } from "./register";

const createBooleanAction = (
  operation: BooleanShapeOperation,
  name: "unionShapes" | "intersectionShapes" | "differenceShapes" | "xorShapes",
  icon: typeof polygonIcon,
) =>
  register({
    name,
    label: `labels.${name}`,
    icon,
    keywords: [operation, "merge", "boolean", "shape", "combine"],
    trackEvent: { category: "element" },
    predicate: (elements, appState, _, app) =>
      canBooleanShapes(app.scene.getSelectedElements(appState)),
    perform(elements, appState, _, app) {
      const selected = app.scene.getSelectedElements(appState);
      if (!canBooleanShapes(selected)) {
        return false;
      }
      const result = booleanShapes(selected, operation);
      if (!result.ok) {
        app.focusContainer();
        return {
          appState: {
            ...appState,
            toast: {
              message:
                operation === "union"
                  ? t(`shapeUnion.${result.reason}`)
                  : t(`shapeBoolean.${result.reason}`),
              closable: true,
              duration: 6000,
            },
          },
          captureUpdate: CaptureUpdateAction.EVENTUALLY,
        };
      }
      const selectedIds = new Set(selected.map(({ id }) => id));
      const insertionId =
        operation === "difference"
          ? selected[0].id
          : selected[selected.length - 1].id;
      const lines = result.elements;
      const nextElements = elements.flatMap((element) => {
        if (!selectedIds.has(element.id)) {
          return [element];
        }
        const deleted = newElementWith(element, { isDeleted: true });
        return element.id === insertionId ? [deleted, ...lines] : [deleted];
      });
      app.focusContainer();
      return {
        elements: nextElements,
        appState: {
          ...appState,
          toast: lines.length
            ? null
            : {
                message: t("shapeBoolean.emptyResult"),
                duration: 6000,
                closable: true,
              },
          editingGroupId: lines.length ? appState.editingGroupId : null,
          selectedElementIds: Object.fromEntries(
            lines.map(({ id }) => [id, true]),
          ),
          selectedGroupIds: {},
          selectedLinearElement:
            lines.length === 1
              ? new LinearElementEditor(
                  lines[0],
                  arrayToMap(nextElements),
                  true,
                )
              : null,
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      };
    },
    PanelComponent: ({ appState, app, updateData }) =>
      canBooleanShapes(app.scene.getSelectedElements(appState)) ? (
        <IconButton
          type="button"
          icon={icon}
          aria-label={t(`labels.${name}`)}
          title={t(`labels.${name}Description`)}
          onClick={() => updateData(null)}
        />
      ) : null,
  });

export const actionUnionShapes = createBooleanAction(
  "union",
  "unionShapes",
  polygonIcon,
);
export const actionIntersectionShapes = createBooleanAction(
  "intersection",
  "intersectionShapes",
  booleanIntersectionIcon,
);
export const actionDifferenceShapes = createBooleanAction(
  "difference",
  "differenceShapes",
  booleanDifferenceIcon,
);
export const actionXorShapes = createBooleanAction(
  "xor",
  "xorShapes",
  booleanXorIcon,
);

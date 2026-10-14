import { arrayToMap } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/element";
import {
  canCloseLine,
  canSplitLine,
  splitLine,
  canReduceLinePoints,
  reduceLinePoints,
  canJoinLines,
  closeLine,
  isEditableOpenLine,
  joinLines,
  LineJoinError,
} from "@excalidraw/element/lineOperations";
import { LinearElementEditor } from "@excalidraw/element/linearElementEditor";
import { newElementWith } from "@excalidraw/element/mutateElement";

import { IconButton } from "../components/IconButton";
import { LinkIcon, polygonIcon, lineEditorIcon } from "../components/icons";
import { t } from "../i18n";

import { register } from "./register";

export const actionJoinLines = register({
  name: "joinLines",
  label: "labels.joinLines",
  icon: LinkIcon,
  keywords: ["join", "connect", "merge", "line", "path"],
  trackEvent: { category: "element" },
  predicate: (elements, appState, _, app) =>
    canJoinLines(app.scene.getSelectedElements(appState)),
  perform(elements, appState, _, app) {
    const selected = app.scene.getSelectedElements(appState);
    if (!canJoinLines(selected) || !selected.every(isEditableOpenLine)) {
      return false;
    }
    try {
      const line = joinLines(selected, app.scene.getNonDeletedElementsMap());
      const selectedIds = new Set(selected.map(({ id }) => id));
      const topId = selected[selected.length - 1].id;
      const nextElements = elements.flatMap((element) => {
        if (!selectedIds.has(element.id)) {
          return [element];
        }
        const deleted = newElementWith(element, { isDeleted: true });
        return element.id === topId ? [deleted, line] : [deleted];
      });
      return {
        elements: nextElements,
        appState: {
          ...appState,
          toast: null,
          selectedElementIds: { [line.id]: true },
          selectedGroupIds: {},
          selectedLinearElement: new LinearElementEditor(
            line,
            arrayToMap(nextElements),
          ),
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      };
    } catch (error) {
      // Keep the original elements and selection intact if conversion fails.
      console.error("Line joining failed", error);
      return {
        appState: {
          ...appState,
          toast: {
            message:
              error instanceof LineJoinError && error.reason === "tooComplex"
                ? t("lineJoin.tooComplex")
                : t("lineJoin.failed"),
            closable: true,
            duration: 6000,
          },
        },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }
  },
  PanelComponent: ({ appState, app, updateData }) =>
    canJoinLines(app.scene.getSelectedElements(appState)) ? (
      <IconButton
        type="button"
        icon={LinkIcon}
        aria-label={t("labels.joinLines")}
        title={t("labels.joinLinesDescription")}
        onClick={() => updateData(null)}
      />
    ) : null,
});

export const actionCloseLine = register({
  name: "closeLine",
  label: "labels.closeLine",
  icon: polygonIcon,
  keywords: ["close", "fill", "polygon", "line", "path"],
  trackEvent: { category: "element" },
  predicate: (elements, appState, _, app) => {
    const selected = app.scene.getSelectedElements(appState);
    return selected.length === 1 && canCloseLine(selected[0]);
  },
  perform(elements, appState, _, app) {
    const selected = app.scene.getSelectedElements(appState);
    if (selected.length !== 1 || !canCloseLine(selected[0])) {
      return false;
    }
    const line = newElementWith(
      closeLine(selected[0], app.scene.getNonDeletedElementsMap()),
      {},
      true,
    );
    const nextElements = elements.map((element) =>
      element.id === line.id ? line : element,
    );
    return {
      elements: nextElements,
      appState: {
        ...appState,
        selectedLinearElement: new LinearElementEditor(
          line,
          arrayToMap(nextElements),
        ),
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ appState, app, updateData }) => {
    const selected = app.scene.getSelectedElements(appState);
    return selected.length === 1 && canCloseLine(selected[0]) ? (
      <IconButton
        type="button"
        icon={polygonIcon}
        aria-label={t("labels.closeLine")}
        title={t("labels.closeLineDescription")}
        onClick={() => updateData(null)}
      />
    ) : null;
  },
});

export const actionReduceLinePoints = register({
  name: "reduceLinePoints",
  label: "labels.reduceLinePoints",
  icon: lineEditorIcon,
  keywords: ["simplify", "reduce", "points", "outline", "line"],
  trackEvent: { category: "element" },
  predicate: (elements, appState, _, app) => {
    const selected = app.scene.getSelectedElements(appState);
    return selected.length === 1 && canReduceLinePoints(selected[0]);
  },
  perform(elements, appState, _, app) {
    const selected = app.scene.getSelectedElements(appState);
    if (selected.length !== 1 || !canReduceLinePoints(selected[0])) {
      return false;
    }
    const line = newElementWith(
      reduceLinePoints(selected[0], app.scene.getNonDeletedElementsMap()),
      {},
      true,
    );
    const nextElements = elements.map((element) =>
      element.id === line.id ? line : element,
    );
    return {
      elements: nextElements,
      appState: {
        ...appState,
        selectedLinearElement: new LinearElementEditor(
          line,
          arrayToMap(nextElements),
          true,
        ),
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ appState, app, updateData }) => {
    const selected = app.scene.getSelectedElements(appState);
    return selected.length === 1 && canReduceLinePoints(selected[0]) ? (
      <IconButton
        type="button"
        icon={lineEditorIcon}
        aria-label={t("labels.reduceLinePoints")}
        title={t("labels.reduceLinePointsDescription")}
        onClick={() => updateData(null)}
      />
    ) : null;
  },
});

export const actionSplitLine = register({
  name: "splitLine",
  label: "labels.splitLine",
  icon: lineEditorIcon,
  keywords: ["split", "cut", "break", "points", "outline", "line"],
  trackEvent: { category: "element" },
  predicate: (elements, appState, _, app) => {
    const selected = app.scene.getSelectedElements(appState);
    const editor = appState.selectedLinearElement;
    return (
      selected.length === 1 &&
      !!editor?.isEditing &&
      editor.elementId === selected[0].id &&
      canSplitLine(selected[0], editor.selectedPointsIndices ?? [])
    );
  },
  perform(elements, appState, _, app) {
    const selected = app.scene.getSelectedElements(appState);
    const editor = appState.selectedLinearElement;
    if (
      selected.length !== 1 ||
      !editor?.isEditing ||
      editor.elementId !== selected[0].id ||
      !canSplitLine(selected[0], editor.selectedPointsIndices ?? [])
    ) {
      return false;
    }
    const lines = splitLine(
      selected[0],
      editor.selectedPointsIndices ?? [],
      app.scene.getNonDeletedElementsMap(),
    );
    const nextElements = elements.flatMap((element) =>
      element.id === selected[0].id
        ? [newElementWith(element, { isDeleted: true }), ...lines]
        : [element],
    );
    app.focusContainer();
    return {
      elements: nextElements,
      appState: {
        ...appState,
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
    const editor = appState.selectedLinearElement;
    return selected.length === 1 &&
      !!editor?.isEditing &&
      editor.elementId === selected[0].id &&
      canSplitLine(selected[0], editor.selectedPointsIndices ?? []) ? (
      <IconButton
        type="button"
        icon={lineEditorIcon}
        aria-label={t("labels.splitLine")}
        title={t("labels.splitLineDescription")}
        onClick={() => updateData(null)}
      />
    ) : null;
  },
});

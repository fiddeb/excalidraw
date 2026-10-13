import React from "react";

import { arrayToMap, getSizeFromPoints, ROUNDNESS } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  LinearElementEditor,
  newLinearElement,
} from "@excalidraw/element";
import {
  canSplitLine,
  getLineSplitIndices,
  splitLine,
  canJoinLines,
} from "@excalidraw/element/lineOperations";
import { pointFrom } from "@excalidraw/math";

import type { LocalPoint, Radians } from "@excalidraw/math";
import type {
  ExcalidrawLineElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { actionSplitLine } from "../actions/actionLineOperations";
import { serializeAsJSON } from "../data/json";
import { restoreElements } from "../data/restore";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { render, screen, fireEvent, waitFor } from "./test-utils";

const { h } = window;
const line = (closed = false) => {
  const points = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
    ...(closed ? [[0, 0]] : []),
  ].map(([x, y]) => pointFrom<LocalPoint>(x, y));
  return newLinearElement({
    type: "line",
    x: 200,
    y: 300,
    points,
    ...getSizeFromPoints(points),
    polygon: closed,
    backgroundColor: "#a5d8ff",
    fillStyle: "hachure",
    groupIds: ["inner", "outer"],
    frameId: "frame",
    opacity: 60,
    roundness: null,
  }) as NonDeleted<ExcalidrawLineElement>;
};
const global = (element: ExcalidrawLineElement) =>
  element.points.map(([x, y]) => [element.x + x, element.y + y]);
const selectPoints = (
  element: NonDeleted<ExcalidrawLineElement>,
  indices: number[],
) => {
  API.setSelectedElements([element]);
  API.setAppState({
    selectedLinearElement: {
      ...new LinearElementEditor(element, arrayToMap(h.elements), true),
      selectedPointsIndices: indices,
    },
  });
};

describe("split line geometry", () => {
  it("splits an open path at multiple internal vertices, retaining every edge", () => {
    const source = line();
    const snapshot = JSON.stringify(source);
    const parts = splitLine(source, [2, 1, 1, 0, 3], arrayToMap([source]));
    expect(parts).toHaveLength(3);
    const original = global(source);
    expect(parts.map(global)).toEqual([
      [original[0], original[1]],
      [original[1], original[2]],
      [original[2], original[3]],
    ]);
    expect(canJoinLines(parts)).toBe(true);
    for (const part of parts) {
      expect(part).toMatchObject({
        type: "line",
        polygon: false,
        backgroundColor: "transparent",
        groupIds: ["inner", "outer"],
        frameId: "frame",
        opacity: 60,
        fillStyle: "hachure",
      });
      expect(part.id).not.toBe(source.id);
    }
    expect(new Set(parts.map(({ id }) => id)).size).toBe(3);
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it("opens a closed outline at one vertex with independent coincident endpoints", () => {
    const source = line(true);
    const [part] = splitLine(source, [2], arrayToMap([source]));
    const original = global(source);
    expect(global(part)).toEqual([
      original[2],
      original[3],
      original[0],
      original[1],
      original[2],
    ]);
    expect(part.polygon).toBe(false);
    expect(part.backgroundColor).toBe("transparent");
    expect(part.points[0]).toEqual(part.points.at(-1));
    expect(getLineSplitIndices(source, [0, 4])).toEqual([0]);
    expect(splitLine(source, [0, 4], arrayToMap([source]))).toHaveLength(1);
  });

  it("splits a rotated loop at multiple vertices without adding or dropping edges", () => {
    const source = { ...line(true), angle: (Math.PI / 2) as Radians };
    const snapshot = JSON.stringify(source);
    const parts = splitLine(source, [1, 3], arrayToMap([source]));
    expect(parts).toHaveLength(2);
    const original = LinearElementEditor.getPointsGlobalCoordinates(
      {
        ...source,
        points: source.points.map(([x, y]) => pointFrom<LocalPoint>(x, y)),
      },
      arrayToMap([source]),
    );
    const expected = [
      [original[1], original[2], original[3]],
      [original[3], original[0], original[1]],
    ];
    parts
      .map(global)
      .forEach((points, i) =>
        points.forEach((point, j) =>
          point.forEach((value, axis) =>
            expect(value).toBeCloseTo(expected[i][j][axis]),
          ),
        ),
      );
    expect(canJoinLines(parts)).toBe(true);
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it("does not create invisible elements for duplicate vertices", () => {
    const source = {
      ...line(),
      points: [
        pointFrom<LocalPoint>(0, 0),
        pointFrom<LocalPoint>(0, 0),
        pointFrom<LocalPoint>(100, 0),
        pointFrom<LocalPoint>(100, 100),
      ],
    };
    const parts = splitLine(source, [1], arrayToMap([source]));
    expect(parts).toHaveLength(1);
    expect(parts[0].points).toHaveLength(3);
    expect(
      canSplitLine(
        {
          ...source,
          points: source.points.map(() => pointFrom<LocalPoint>(0, 0)),
        },
        [1],
      ),
    ).toBe(false);
  });

  it("rejects endpoints on open lines, invalid indices, locked, bound and curved paths", () => {
    const source = line();
    for (const indices of [[], [0, 3], [-1, 20, NaN, 1.5]]) {
      expect(canSplitLine(source, indices)).toBe(false);
      expect(splitLine(source, indices, arrayToMap([source]))).toEqual([]);
    }
    for (const override of [
      { locked: true },
      { isDeleted: true },
      { roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS } },
      { boundElements: [{ id: "arrow", type: "arrow" as const }] },
      { startArrowhead: "arrow" as const },
      { points: [] },
    ]) {
      expect(canSplitLine({ ...source, ...override }, [1])).toBe(false);
    }
    expect(canSplitLine(API.createElement({ type: "arrow" }), [1])).toBe(false);
  });
});

describe("split at selected points action", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  it("splits from the panel in place, keeps group/frame membership and supports undo/redo", () => {
    const frame = API.createElement({ type: "frame" });
    const source = { ...line(), frameId: frame.id };
    const above = API.createElement({ type: "rectangle" });
    API.updateScene({
      elements: [frame, source, above],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    selectPoints(source, [1, 2]);
    fireEvent.click(
      screen.getByRole("button", { name: "Split at selected points" }),
    );
    const live = h.elements.filter((element) => !element.isDeleted);
    expect(live.map(({ type }) => type)).toEqual([
      "frame",
      "line",
      "line",
      "line",
      "rectangle",
    ]);
    expect(live.at(-1)?.id).toBe(above.id);
    live.slice(1, 4).forEach((part) =>
      expect(part).toMatchObject({
        groupIds: ["inner", "outer"],
        frameId: frame.id,
        polygon: false,
        backgroundColor: "transparent",
      }),
    );
    expect(h.state.selectedElementIds).toEqual(
      Object.fromEntries(live.slice(1, 4).map(({ id }) => [id, true])),
    );
    expect(h.state.selectedLinearElement).toBeNull();
    Keyboard.undo();
    expect(h.elements.filter((element) => !element.isDeleted)).toEqual([
      expect.objectContaining({ id: frame.id }),
      expect.objectContaining({ id: source.id, points: source.points }),
      expect.objectContaining({ id: above.id }),
    ]);
    Keyboard.redo();
    expect(
      h.elements.filter((element) => !element.isDeleted).map(({ id }) => id),
    ).toEqual(live.map(({ id }) => id));
  });

  it("round-trips a single opened contour as polygon=false and enters point editing", () => {
    const source = { ...line(true), groupIds: [], frameId: null };
    API.setElements([source]);
    selectPoints(source, [2]);
    API.executeAction(actionSplitLine);
    const part = h.elements.find((element) => !element.isDeleted)!;
    expect(h.state.selectedLinearElement).toMatchObject({
      elementId: part.id,
      isEditing: true,
    });
    const json = JSON.parse(serializeAsJSON(h.elements, h.state, {}, "local"));
    expect(
      restoreElements(json.elements, null).filter(
        (element) => !element.isDeleted,
      )[0],
    ).toMatchObject({
      type: "line",
      polygon: false,
      backgroundColor: "transparent",
      points: (part as ExcalidrawLineElement).points,
    });
  });

  it("does nothing without point editing or an internal selected point", () => {
    const source = line();
    API.setElements([source]);
    API.setSelectedElements([source]);
    API.executeAction(actionSplitLine);
    expect(h.elements).toEqual([source]);
    selectPoints(source, [0, 3]);
    expect(
      screen.queryByRole("button", { name: "Split at selected points" }),
    ).toBeNull();
    API.executeAction(actionSplitLine);
    expect(h.elements).toEqual([source]);
  });
});

describe("split lines on phones", () => {
  it("exposes the split action while editing selected points on a phone", async () => {
    await render(<Excalidraw UIOptions={{ getFormFactor: () => "phone" }} />);
    fireEvent.resize(window);
    await waitFor(() => expect(h.app.editorInterface.formFactor).toBe("phone"));
    const source = { ...line(), groupIds: [], frameId: null };
    API.setElements([source]);
    selectPoints(source, [1]);
    fireEvent.click(
      screen.getByRole("button", { name: "Split at selected points" }),
    );
    expect(h.elements.filter((element) => !element.isDeleted)).toHaveLength(2);
  });
});

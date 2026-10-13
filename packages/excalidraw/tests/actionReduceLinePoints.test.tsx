import React from "react";

import { arrayToMap, getSizeFromPoints, ROUNDNESS } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  newLinearElement,
  LinearElementEditor,
} from "@excalidraw/element";
import {
  canReduceLinePoints,
  reduceLinePoints,
} from "@excalidraw/element/lineOperations";
import { pointFrom } from "@excalidraw/math";

import type {
  ExcalidrawLineElement,
  NonDeleted,
} from "@excalidraw/element/types";

import type { LocalPoint, Radians } from "@excalidraw/math";

import { actionReduceLinePoints } from "../actions/actionLineOperations";
import { serializeAsJSON } from "../data/json";
import { restoreElements } from "../data/restore";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { fireEvent, render, screen } from "./test-utils";

const { h } = window;
const outline = () => {
  const points = Array.from({ length: 32 }, (_, i) =>
    pointFrom<LocalPoint>(
      100 * Math.cos((i * Math.PI) / 16) - 100,
      60 * Math.sin((i * Math.PI) / 16),
    ),
  );
  points.push(points[0]);
  return newLinearElement({
    type: "line",
    x: 200,
    y: 100,
    points,
    ...getSizeFromPoints(points),
    polygon: true,
    roundness: null,
    backgroundColor: "#a5d8ff",
    fillStyle: "hachure",
    groupIds: ["group"],
    frameId: "frame",
    opacity: 60,
  }) as NonDeleted<ExcalidrawLineElement>;
};

describe("reduce line points", () => {
  it("reduces progressively and keeps closed contours, styling and scene positions", () => {
    const source = { ...outline(), angle: (Math.PI / 3) as Radians };
    const original = JSON.stringify(source);
    const before = LinearElementEditor.getPointsGlobalCoordinates(
      {
        ...source,
        points: source.points.map(([x, y]) => pointFrom<LocalPoint>(x, y)),
      },
      arrayToMap([source]),
    );
    let result = reduceLinePoints(source, arrayToMap([source]));
    expect(result.points).toHaveLength(25);
    expect(result).toMatchObject({
      id: source.id,
      type: "line",
      polygon: true,
      angle: 0,
      groupIds: ["group"],
      frameId: "frame",
      opacity: 60,
      fillStyle: "hachure",
      backgroundColor: "#a5d8ff",
    });
    const after = LinearElementEditor.getPointsGlobalCoordinates(
      result,
      arrayToMap([result]),
    );
    for (const point of after) {
      expect(
        before.some(
          ([x, y]) =>
            Math.abs(x - point[0]) < 1e-8 && Math.abs(y - point[1]) < 1e-8,
        ),
      ).toBe(true);
    }
    while (Boolean(canReduceLinePoints(result))) {
      const count = result.points.length;
      result = reduceLinePoints(result, arrayToMap([result]));
      expect(result.points.length).toBeLessThan(count);
      expect(result.points[0]).toEqual(result.points.at(-1));
    }
    expect(result.points).toHaveLength(4);
    expect(JSON.stringify(source)).toBe(original);
  });

  it("preserves open endpoints and removes redundant points before corners", () => {
    const points = [
      [0, 0],
      [25, 0],
      [50, 0],
      [100, 0],
      [100, 100],
    ].map(([x, y]) => pointFrom<LocalPoint>(x, y));
    const source = newLinearElement({
      type: "line",
      x: 0,
      y: 0,
      points,
      ...getSizeFromPoints(points),
    });
    if (!canReduceLinePoints(source)) {
      throw new Error("Expected a reducible line");
    }
    const result = reduceLinePoints(source, arrayToMap([source]));
    expect(result.points).toHaveLength(4);
    expect(result.points[0]).toEqual(points[0]);
    expect(result.points.at(-1)).toEqual(points.at(-1));
    expect(result.points).toContainEqual(points[3]);
    expect(result.polygon).toBe(false);
  });

  it("rejects locked, deleted, curved and minimal paths, including empty lines", () => {
    const source = outline();
    for (const override of [
      { locked: true },
      { isDeleted: true },
      { roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS } },
      { points: [] },
      { points: source.points.slice(0, 2) },
    ]) {
      expect(canReduceLinePoints({ ...source, ...override })).toBe(false);
    }
  });
});

describe("reduce points action", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  it("reduces from the panel, edits points and supports undo/redo and file round-trip", () => {
    const source = { ...outline(), groupIds: [], frameId: null };
    const behind = API.createElement({ type: "rectangle" });
    API.updateScene({
      elements: [behind, source],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([source]);
    fireEvent.click(screen.getByRole("button", { name: "Reduce points" }));
    const result = h.elements[1];
    expect(result).toMatchObject({ id: source.id, points: expect.any(Array) });
    expect(h.state.selectedLinearElement).toMatchObject({
      elementId: source.id,
      isEditing: true,
    });
    expect(h.elements[0].id).toBe(behind.id);
    const saved = JSON.parse(serializeAsJSON(h.elements, h.state, {}, "local"));
    expect(restoreElements(saved.elements, null)[1]).toMatchObject({
      type: "line",
      points: (result as typeof source).points,
      polygon: true,
    });
    Keyboard.undo();
    expect(h.elements[1]).toMatchObject({ points: source.points });
    Keyboard.redo();
    const redoPoints = (h.elements[1] as typeof source).points;
    expect(redoPoints).toHaveLength((result as typeof source).points.length);
    redoPoints.forEach((point, i) => {
      point.forEach((value, axis) =>
        expect(value).toBeCloseTo((result as typeof source).points[i][axis], 8),
      );
    });
    API.executeAction(actionReduceLinePoints);
    expect((h.elements[1] as typeof source).points.length).toBeLessThan(
      (result as typeof source).points.length,
    );
  });
});

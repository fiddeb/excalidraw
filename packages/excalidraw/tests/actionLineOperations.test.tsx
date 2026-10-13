import React from "react";

import { arrayToMap, getSizeFromPoints, ROUNDNESS } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  newLinearElement,
  LinearElementEditor,
} from "@excalidraw/element";
import {
  canJoinLines,
  closeLine,
  getLineOperationPoints,
  joinLines,
} from "@excalidraw/element/lineOperations";
import { pointFrom } from "@excalidraw/math";

import type { LocalPoint, Radians } from "@excalidraw/math";
import type {
  ExcalidrawLineElement,
  NonDeleted,
} from "@excalidraw/element/types";

import {
  actionCloseLine,
  actionJoinLines,
} from "../actions/actionLineOperations";
import { serializeAsJSON } from "../data/json";
import { restoreElements } from "../data/restore";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { fireEvent, render, screen } from "./test-utils";

const { h } = window;
const line = (coordinates: [number, number][]) => {
  const points = coordinates.map(([x, y]) => pointFrom<LocalPoint>(x, y));
  return newLinearElement({
    type: "line",
    x: 0,
    y: 0,
    points,
    ...getSizeFromPoints(points),
    roughness: 0,
  }) as NonDeleted<ExcalidrawLineElement>;
};

describe("line operations geometry", () => {
  it.each([
    [
      [100, 0],
      [100, 100],
    ],
    [
      [100, 100],
      [100, 0],
    ],
    [
      [-100, 0],
      [0, 0],
    ],
    [
      [0, 0],
      [-100, 0],
    ],
  ] as [number, number][][])(
    "joins either end in either direction: %j, %j",
    (...coordinates) => {
      const first = line([
        [0, 0],
        [100, 0],
      ]);
      const second = line(coordinates);
      const result = joinLines([first, second], arrayToMap([first, second]));
      const points = LinearElementEditor.getPointsGlobalCoordinates(
        result,
        arrayToMap([result]),
      );
      expect(points).toHaveLength(3);
      for (const point of [...first.points, ...second.points]) {
        expect(points).toContainEqual(point);
      }
      expect(result.type).toBe("line");
      expect(result.roundness).toBeNull();
    },
  );

  it("assembles unordered segments into a closed outline without duplicate junctions", () => {
    const inputs = [
      line([
        [100, 0],
        [100, 100],
      ]),
      line([
        [0, 100],
        [0, 0],
      ]),
      line([
        [0, 0],
        [100, 0],
      ]),
      line([
        [100, 100],
        [0, 100],
      ]),
    ];
    const result = joinLines(inputs, arrayToMap(inputs));
    expect(result.points).toHaveLength(5);
    expect(result.points[0]).toEqual(result.points[4]);
    expect(result).toMatchObject({ polygon: true, width: 100, height: 100 });
  });

  it("keeps gaps as explicit segments and inherits the top line's style and shared groups", () => {
    const bottom = {
      ...line([
        [0, 0],
        [100, 0],
      ]),
      groupIds: ["inner-a", "outer"],
      strokeColor: "#ff0000",
    };
    const top = {
      ...line([
        [105, 0],
        [105, 100],
      ]),
      groupIds: ["inner-b", "outer"],
      strokeColor: "#0000ff",
      strokeWidth: 4,
    };
    const result = joinLines([bottom, top], arrayToMap([bottom, top]));
    expect(result).toMatchObject({
      groupIds: ["outer"],
      strokeColor: top.strokeColor,
      strokeWidth: 4,
    });
    expect(result.points).toHaveLength(4);
  });

  it("flattens a rotated curve and closes it without moving its existing contour", () => {
    const curve = {
      ...line([
        [0, 0],
        [50, 80],
        [100, 0],
      ]),
      roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS },
      angle: (Math.PI / 3) as Radians,
    };
    const map = arrayToMap([curve]);
    const original = JSON.stringify(curve);
    const sampled = getLineOperationPoints(curve, map);
    expect(sampled.length).toBeGreaterThan(3);
    const result = closeLine(curve, map);
    const actual = LinearElementEditor.getPointsGlobalCoordinates(
      result,
      arrayToMap([result]),
    );
    expect(actual.length).toBe(sampled.length + 1);
    sampled.forEach((point, index) => {
      expect(actual[index][0]).toBeCloseTo(point[0]);
      expect(actual[index][1]).toBeCloseTo(point[1]);
    });
    expect(actual[actual.length - 1]).toEqual(actual[0]);
    expect(JSON.stringify(curve)).toBe(original);
  });

  it("rejects locked lines, closed polygons, arrows and different frames", () => {
    const first = line([
      [0, 0],
      [100, 0],
    ]);
    const second = line([
      [100, 0],
      [100, 100],
    ]);
    expect(canJoinLines([first, { ...second, locked: true }])).toBe(false);
    expect(canJoinLines([first, { ...second, polygon: true }])).toBe(false);
    expect(canJoinLines([first, { ...second, frameId: "other" }])).toBe(false);
    expect(
      canJoinLines([first, newLinearElement({ ...second, type: "arrow" })]),
    ).toBe(false);
  });
});

describe("line operation actions", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  it("joins from the panel, preserves stacking order, and restores originals with undo", () => {
    const first = line([
      [0, 0],
      [100, 0],
    ]);
    const middle = API.createElement({ type: "rectangle" });
    const second = line([
      [100, 0],
      [100, 100],
    ]);
    API.updateScene({
      elements: [first, middle, second],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([first, second]);
    fireEvent.click(screen.getByRole("button", { name: "Join lines" }));
    const visible = () => h.elements.filter((element) => !element.isDeleted);
    expect(visible().map(({ type }) => type)).toEqual(["rectangle", "line"]);
    const result = visible()[1];
    expect(h.state.selectedElementIds).toEqual({ [result.id]: true });
    Keyboard.undo();
    expect(visible().map(({ id }) => id)).toEqual([
      first.id,
      middle.id,
      second.id,
    ]);
    Keyboard.redo();
    expect(visible().map(({ id }) => id)).toEqual([middle.id, result.id]);
  });

  it("closes a three-point line, preserves fill through serialization, and supports undo", () => {
    const source = {
      ...line([
        [0, 0],
        [100, 0],
        [100, 100],
      ]),
      backgroundColor: "#a5d8ff",
    };
    API.updateScene({
      elements: [source],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([source]);
    fireEvent.click(screen.getByRole("button", { name: "Close outline" }));
    const closed = h.elements.find(
      ({ id }) => id === source.id,
    ) as ExcalidrawLineElement;
    expect(closed.points).toHaveLength(4);
    expect(closed.points[3]).toEqual(closed.points[0]);
    expect(closed.polygon).toBe(true);
    const exported = JSON.parse(
      serializeAsJSON(h.elements, h.state, {}, "local"),
    );
    const restored = restoreElements(exported.elements, null)[0];
    expect(restored).toMatchObject({
      type: "line",
      points: closed.points,
      polygon: true,
      backgroundColor: source.backgroundColor,
    });
    Keyboard.undo();
    expect(h.elements.find(({ id }) => id === source.id)).toMatchObject({
      points: source.points,
      polygon: false,
    });
  });

  it("guards invalid selections even when actions are invoked directly", () => {
    const source = line([
      [0, 0],
      [100, 0],
    ]);
    const rectangle = API.createElement({ type: "rectangle" });
    API.setElements([source, rectangle]);
    API.setSelectedElements([source, rectangle]);
    API.executeAction(actionJoinLines);
    expect(h.elements).toHaveLength(2);
    API.setSelectedElements([source]);
    API.executeAction(actionCloseLine);
    expect(h.elements[0]).toMatchObject({
      points: source.points,
      polygon: false,
    });
  });
});

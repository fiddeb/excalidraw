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
  MAX_JOIN_LINES,
  MAX_JOIN_POINTS,
} from "@excalidraw/element/lineOperations";
import * as lineOperations from "@excalidraw/element/lineOperations";
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
  it("calculates bounds for dense imported paths without exceeding the argument limit", () => {
    const points = Array.from({ length: 200_000 }, (_, i) =>
      pointFrom<LocalPoint>(i - 100_000, i % 2),
    );
    expect(getSizeFromPoints(points)).toEqual({ width: 199_999, height: 1 });
  });

  it("rejects excessive work before joining and leaves inputs intact", () => {
    const dense = line(
      Array.from({ length: MAX_JOIN_POINTS }, (_, i) => [i, i % 2]),
    );
    const small = line([
      [0, 0],
      [100, 0],
    ]);
    const before = JSON.stringify(dense);
    expect(() => joinLines([dense, small], arrayToMap([dense, small]))).toThrow(
      "tooComplex",
    );
    expect(JSON.stringify(dense)).toBe(before);
    const many = Array.from({ length: MAX_JOIN_LINES + 1 }, () => small);
    expect(() => joinLines(many, arrayToMap(many))).toThrow("tooComplex");
  });

  it("rejects nonfinite curve coordinates before curve subdivision", () => {
    const malformed = {
      ...line([
        [0, 0],
        [50, 80],
        [100, 0],
      ]),
      angle: NaN as Radians,
      roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS },
    };
    const small = line([
      [100, 0],
      [200, 0],
    ]);
    expect(() =>
      joinLines([malformed, small], arrayToMap([malformed, small])),
    ).toThrow("invalidGeometry");
  });

  it("enforces the point budget after sampling curves", () => {
    const curve = {
      ...line([
        [0, 0],
        [50, 80],
        [100, 0],
      ]),
      roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS },
    };
    expect(() => getLineOperationPoints(curve, arrayToMap([curve]), 3)).toThrow(
      "tooComplex",
    );
  });

  it("joins three rotated curves without moving or mutating their contours", () => {
    const inputs = [0, 100, 200].map((x) => ({
      ...line([
        [0, 0],
        [50, 80],
        [100, 0],
      ]),
      x,
      angle: (Math.PI / 6) as Radians,
      roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS },
    }));
    const before = JSON.stringify(inputs);
    const map = arrayToMap(inputs);
    const expected = inputs.flatMap((input) =>
      getLineOperationPoints(input, map),
    );
    const joined = joinLines(inputs, map);
    const actual = LinearElementEditor.getPointsGlobalCoordinates(
      joined,
      arrayToMap([joined]),
    );
    for (const [x, y] of expected) {
      expect(
        actual.some(
          ([ax, ay]) => Math.abs(ax - x) < 1e-6 && Math.abs(ay - y) < 1e-6,
        ),
      ).toBe(true);
    }
    expect(JSON.stringify(inputs)).toBe(before);
  });
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

  it("joins three ordinary lines into a triangle and supports undo and redo", () => {
    const inputs = [
      line([
        [0, 0],
        [100, 0],
      ]),
      line([
        [100, 0],
        [50, 80],
      ]),
      line([
        [50, 80],
        [0, 0],
      ]),
    ];
    API.updateScene({
      elements: inputs,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements(inputs);
    fireEvent.click(screen.getByRole("button", { name: "Join lines" }));
    expect(h.elements.filter((el) => !el.isDeleted)).toHaveLength(1);
    expect(h.elements.find((el) => !el.isDeleted)).toMatchObject({
      type: "line",
      polygon: true,
      points: [
        [0, 0],
        [100, 0],
        [50, 80],
        [0, 0],
      ],
    });
    Keyboard.undo();
    expect(
      h.elements.filter((el) => !el.isDeleted).map(({ id }) => id),
    ).toEqual(inputs.map(({ id }) => id));
    Keyboard.redo();
    expect(h.elements.filter((el) => !el.isDeleted)).toHaveLength(1);
  });

  it("reports an excessive join without deleting originals or changing selection", () => {
    const inputs = [
      line(Array.from({ length: MAX_JOIN_POINTS }, (_, i) => [i, i % 2])),
      line([
        [0, 0],
        [100, 0],
      ]),
    ];
    API.updateScene({
      elements: inputs,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements(inputs);
    const selection = { ...h.state.selectedElementIds };
    const original = JSON.stringify(h.elements);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      API.executeAction(actionJoinLines);
      expect(h.state.toast?.message).toContain("too complex");
      expect(JSON.stringify(h.elements)).toBe(original);
      expect(h.state.selectedElementIds).toEqual(selection);
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps the scene usable when joining throws an unexpected error", () => {
    const inputs = [
      line([
        [0, 0],
        [100, 0],
      ]),
      line([
        [100, 0],
        [100, 100],
      ]),
    ];
    API.updateScene({
      elements: inputs,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements(inputs);
    const original = JSON.stringify(h.elements);
    const join = vi
      .spyOn(lineOperations, "joinLines")
      .mockImplementationOnce(() => {
        throw new Error("Unexpected conversion failure");
      });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      API.executeAction(actionJoinLines);
      expect(h.state.toast?.message).toContain("could not be joined");
      expect(JSON.stringify(h.elements)).toBe(original);
      join.mockRestore();
      API.executeAction(actionJoinLines);
      expect(h.elements.filter((el) => !el.isDeleted)).toHaveLength(1);
      Keyboard.undo();
      expect(
        h.elements.filter((el) => !el.isDeleted).map(({ id }) => id),
      ).toEqual(inputs.map(({ id }) => id));
    } finally {
      join.mockRestore();
      errors.mockRestore();
    }
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

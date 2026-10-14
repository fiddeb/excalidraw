import React from "react";

import { getSizeFromPoints, ROUNDNESS } from "@excalidraw/common";
import { CaptureUpdateAction, newLinearElement } from "@excalidraw/element";
import {
  canUnionShapes,
  getBooleanShapePoints,
  isSimpleBooleanRing,
  unionShapes,
} from "@excalidraw/element/booleanOperations";
import { pointFrom, polygonArea } from "@excalidraw/math";

import type { LocalPoint, Radians } from "@excalidraw/math";
import type {
  ExcalidrawElement,
  ExcalidrawLineElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { actionUnionShapes } from "../actions/actionUnionShapes";
import { serializeAsJSON } from "../data/json";
import { restoreElements } from "../data/restore";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { render, screen, fireEvent, waitFor } from "./test-utils";

const { h } = window;
const rect = (x = 0, y = 0, width = 100, height = 100) =>
  API.createElement({
    type: "rectangle",
    x,
    y,
    width,
    height,
    roundness: null,
  });
const contour = (coords: [number, number][]) => {
  const points = coords.map(([x, y]) => pointFrom<LocalPoint>(x, y));
  return newLinearElement({
    type: "line",
    x: 0,
    y: 0,
    points,
    ...getSizeFromPoints(points),
    polygon: true,
    roundness: null,
  }) as NonDeleted<ExcalidrawLineElement>;
};
const resultLines = (sources: ExcalidrawElement[]) => {
  const result = unionShapes(sources);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.elements;
};
const area = (lines: readonly ExcalidrawLineElement[]) =>
  lines.reduce((sum, line) => sum + polygonArea(line.points, 0), 0);
const holeSources = () => [
  rect(0, 0, 300, 50),
  rect(0, 250, 300, 50),
  rect(0, 50, 50, 200),
  rect(250, 50, 50, 200),
];

describe("shape union geometry", () => {
  it("combines overlapping rectangles without their interior edges", () => {
    const sources = [rect(), rect(50, 50)];
    const snapshot = JSON.stringify(sources);
    const result = resultLines(sources);
    expect(result).toHaveLength(1);
    expect(area(result)).toBeCloseTo(17500);
    expect(result[0].points).toHaveLength(9);
    expect(result[0]).toMatchObject({
      type: "line",
      polygon: true,
      roundness: null,
      angle: 0,
    });
    expect(JSON.stringify(sources)).toBe(snapshot);
  });

  it.each([
    [100, 0, 1],
    [100, 100, 2],
    [200, 0, 2],
  ])(
    "handles edge/point tangency and disconnected regions at (%s, %s)",
    (x, y, count) => {
      const result = resultLines([rect(), rect(x, y)]);
      expect(result).toHaveLength(count);
      expect(area(result)).toBeCloseTo(20000);
      result.forEach((line) =>
        expect(isSimpleBooleanRing(getBooleanShapePoints(line))).toBe(true),
      );
    },
  );

  it("handles identical and contained shapes, using the topmost style", () => {
    const outer = rect(0, 0, 200, 200);
    const top = {
      ...rect(50, 50, 50, 50),
      strokeColor: "#e03131",
      backgroundColor: "#a5d8ff",
      fillStyle: "cross-hatch" as const,
      opacity: 40,
      link: "https://example.com",
      customData: { stale: "geometry" },
    };
    const [line] = resultLines([outer, top]);
    expect(area([line])).toBeCloseTo(40000);
    expect(line).toMatchObject({
      strokeColor: top.strokeColor,
      backgroundColor: top.backgroundColor,
      fillStyle: top.fillStyle,
      opacity: 40,
      link: top.link,
    });
    expect(line.customData).toBeUndefined();
    expect(resultLines([outer, { ...outer, id: "duplicate" }])).toHaveLength(1);
  });

  it("unions concave closed contours, regardless of their winding", () => {
    const shape = contour([
      [0, 0],
      [100, 0],
      [100, 50],
      [50, 50],
      [50, 100],
      [0, 100],
      [0, 0],
    ]);
    const reversed = { ...shape, points: [...shape.points].reverse() };
    const result = resultLines([reversed, rect(25, 25, 50, 50)]);
    expect(area(result)).toBeCloseTo(8125);
    expect(result).toHaveLength(1);
  });

  it.each(["ellipse", "diamond", "rectangle"] as const)(
    "supports ideal %s geometry and rounded corners",
    (type) => {
      const shape = API.createElement({
        type,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
      });
      const result = resultLines([shape, rect(200, 0)]);
      expect(result).toHaveLength(2);
      expect(area(result)).toBeGreaterThan(14000);
      expect(area(result)).toBeLessThanOrEqual(20000);
      if (type !== "diamond") {
        expect(result[0].points.length).toBeGreaterThan(5);
      }
    },
  );

  it("preserves rotated geometry while ignoring sketch roughness and seed", () => {
    const rotated = { ...rect(0, 0, 100, 50), angle: (Math.PI / 2) as Radians };
    const other = rect(200, 200);
    const result = resultLines([rotated, other]);
    expect(area(result)).toBeCloseTo(15000);
    const altered = resultLines([
      { ...rotated, roughness: 2, seed: 999 },
      other,
    ]);
    expect(altered.map(({ points }) => points)).toEqual(
      result.map(({ points }) => points),
    );
    const line = contour([
      [0, 0],
      [100, 0],
      [100, 50],
      [0, 50],
      [0, 0],
    ]);
    expect(
      resultLines([{ ...line, angle: (Math.PI / 2) as Radians }, other]).map(
        ({ points }) => points,
      ),
    ).toEqual(result.map(({ points }) => points));
  });

  it("retains only shared outer groups and the common frame", () => {
    const a = { ...rect(), groupIds: ["a", "outer"], frameId: "frame" };
    const b = { ...rect(50, 0), groupIds: ["b", "outer"], frameId: "frame" };
    expect(resultLines([a, b])[0]).toMatchObject({
      groupIds: ["outer"],
      frameId: "frame",
    });
    expect(canUnionShapes([a, { ...b, frameId: "other" }])).toBe(false);
  });

  it("creates a union with a hole using native fill and contour parts", () => {
    const result = unionShapes(holeSources());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.elements).toHaveLength(3);
      expect(result.elements[0].strokeColor).toBe("transparent");
      expect(
        result.elements
          .slice(1)
          .every((element) => element.backgroundColor === "transparent"),
      ).toBe(true);
    }
  });

  it("rejects crossing, self-touching, retraced and zero-area contours", () => {
    for (const coords of [
      [
        [0, 0],
        [100, 100],
        [0, 100],
        [100, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [100, 0],
        [50, 0],
        [50, 100],
        [0, 100],
        [0, 0],
      ],
      [
        [0, 0],
        [100, 0],
        [200, 0],
        [0, 0],
      ],
    ] as [number, number][][]) {
      expect(unionShapes([contour(coords), rect(200, 0)])).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("allows redundant collinear and consecutive duplicate points", () => {
    const source = contour([
      [0, 0],
      [0, 0],
      [50, 0],
      [100, 0],
      [100, 100],
      [0, 100],
      [0, 0],
    ]);
    expect(area(resultLines([source, rect(50, 0)]))).toBeCloseTo(15000);
  });

  it("uses robust intersections for very narrow polygons and translated geometry", () => {
    const a = rect(900000, 900000, 0.01, 100);
    const b = rect(900000.005, 900000, 0.01, 100);
    expect(area(resultLines([a, b]))).toBeCloseTo(1.5, 5);
  });

  it("rejects excessive complexity and unsupported selections", () => {
    expect(
      unionShapes(Array.from({ length: 101 }, (_, i) => rect(i * 100, 0))),
    ).toEqual({ ok: false, reason: "tooComplex" });
    const original = rect();
    expect(canUnionShapes([original])).toBe(false);
    for (const other of [
      { ...original, locked: true },
      { ...original, isDeleted: true },
      { ...original, boundElements: [{ id: "text", type: "text" as const }] },
      { ...original, boundElements: [{ id: "arrow", type: "arrow" as const }] },
      API.createElement({ type: "line" }),
      API.createElement({ type: "arrow" }),
      {
        ...contour([
          [0, 0],
          [100, 0],
          [100, 100],
          [0, 0],
        ]),
        roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS },
      },
    ]) {
      expect(canUnionShapes([original, other])).toBe(false);
    }
  });
});

describe("union shapes action", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  it("unions from the panel at the topmost source layer and supports undo/redo and saving", () => {
    const frame = API.createElement({ type: "frame" });
    const first = {
      ...rect(),
      groupIds: ["first", "outer"],
      frameId: frame.id,
    };
    const between = API.createElement({ type: "text", text: "middle" });
    const top = {
      ...rect(50, 50),
      groupIds: ["top", "outer"],
      frameId: frame.id,
      backgroundColor: "#a5d8ff",
      fillStyle: "hachure" as const,
      opacity: 50,
    };
    const above = API.createElement({ type: "text", text: "above" });
    API.updateScene({
      elements: [frame, first, between, top, above],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([first, top]);
    fireEvent.click(screen.getByRole("button", { name: "Union shapes" }));
    const live = h.elements.filter((element) => !element.isDeleted);
    expect(live.map(({ type }) => type)).toEqual([
      "frame",
      "text",
      "line",
      "text",
    ]);
    expect(live[1].id).toBe(between.id);
    expect(live[3].id).toBe(above.id);
    const result = live[2];
    expect(result).toMatchObject({
      groupIds: ["outer"],
      frameId: frame.id,
      backgroundColor: "#a5d8ff",
      fillStyle: "hachure",
      opacity: 50,
    });
    expect(h.state.selectedLinearElement).toMatchObject({
      elementId: result.id,
      isEditing: true,
    });
    const saved = JSON.parse(serializeAsJSON(h.elements, h.state, {}, "local"));
    expect(
      restoreElements(saved.elements, null).filter(
        (element) => !element.isDeleted,
      )[2],
    ).toMatchObject({
      type: "line",
      points: (result as ExcalidrawLineElement).points,
      polygon: true,
      frameId: frame.id,
    });
    Keyboard.undo();
    expect(
      h.elements.filter((element) => !element.isDeleted).map(({ id }) => id),
    ).toEqual([frame.id, first.id, between.id, top.id, above.id]);
    Keyboard.redo();
    expect(
      h.elements.filter((element) => !element.isDeleted).map(({ id }) => id),
    ).toEqual(live.map(({ id }) => id));
  });

  it("selects all disconnected results as separate ordinary elements", () => {
    const sources = [rect(), rect(200, 0)];
    API.setElements(sources);
    API.setSelectedElements(sources);
    API.executeAction(actionUnionShapes);
    const live = h.elements.filter((element) => !element.isDeleted);
    expect(live).toHaveLength(2);
    expect(h.state.selectedLinearElement).toBeNull();
    expect(h.state.selectedElementIds).toEqual(
      Object.fromEntries(live.map(({ id }) => [id, true])),
    );
  });

  it("selects native hole parts after a union", () => {
    const sources = holeSources();
    API.setElements(sources);
    API.setSelectedElements(sources);
    API.executeAction(actionUnionShapes);
    const live = h.elements.filter((element) => !element.isDeleted);
    expect(live).toHaveLength(3);
    expect(h.state.selectedElementIds).toEqual(
      Object.fromEntries(live.map(({ id }) => [id, true])),
    );
    expect(h.state.toast).toBeNull();
  });
});

describe("union shapes on phones", () => {
  it("is available from the mobile actions", async () => {
    await render(<Excalidraw UIOptions={{ getFormFactor: () => "phone" }} />);
    fireEvent.resize(window);
    await waitFor(() => expect(h.app.editorInterface.formFactor).toBe("phone"));
    const sources = [rect(), rect(50, 50)];
    API.setElements(sources);
    API.setSelectedElements(sources);
    fireEvent.click(screen.getByRole("button", { name: "Union shapes" }));
    expect(h.elements.filter((element) => !element.isDeleted)).toEqual([
      expect.objectContaining({ type: "line", polygon: true }),
    ]);
  });
});

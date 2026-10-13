import React from "react";

import { CaptureUpdateAction, newLinearElement } from "@excalidraw/element";
import {
  booleanShapes,
  canBooleanShapes,
  getBooleanShapePoints,
  isSimpleBooleanRing,
} from "@excalidraw/element/booleanOperations";
import { pointFrom, polygonArea } from "@excalidraw/math";

import type { BooleanShapeOperation } from "@excalidraw/element/booleanOperations";
import type {
  ExcalidrawElement,
  ExcalidrawLineElement,
} from "@excalidraw/element/types";
import type { LocalPoint, Radians } from "@excalidraw/math";

import {
  actionIntersectionShapes,
  actionDifferenceShapes,
  actionXorShapes,
} from "../actions/actionUnionShapes";
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
const linesFor = (
  sources: ExcalidrawElement[],
  operation: BooleanShapeOperation,
) => {
  const result = booleanShapes(sources, operation);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.elements;
};
const area = (lines: readonly ExcalidrawLineElement[]) =>
  lines.reduce((sum, line) => sum + polygonArea(line.points, 0), 0);
const commands = [
  {
    operation: "intersection",
    action: actionIntersectionShapes,
    label: "Intersection of shapes",
    count: 1,
    area: 2500,
    emptySources: () => [rect(), rect(200, 0)],
  },
  {
    operation: "difference",
    action: actionDifferenceShapes,
    label: "Subtract from bottom shape",
    count: 1,
    area: 7500,
    emptySources: () => [rect(), rect()],
  },
  {
    operation: "xor",
    action: actionXorShapes,
    label: "Exclude overlap (XOR)",
    count: 2,
    area: 15000,
    emptySources: () => [rect(), rect()],
  },
] as const;

describe("intersection, difference and XOR geometry", () => {
  it.each(commands)(
    "computes $operation without mutating its inputs",
    ({ operation, count, area: expectedArea }) => {
      const sources = [rect(), rect(50, 50)];
      const snapshot = JSON.stringify(sources);
      const lines = linesFor(sources, operation);
      expect(lines).toHaveLength(count);
      expect(area(lines)).toBeCloseTo(expectedArea);
      lines.forEach((line) => {
        expect(line).toMatchObject({
          type: "line",
          polygon: true,
          angle: 0,
          roundness: null,
        });
        expect(isSimpleBooleanRing(getBooleanShapePoints(line))).toBe(true);
        expect(line.points[0]).toEqual(line.points.at(-1));
      });
      expect(JSON.stringify(sources)).toBe(snapshot);
    },
  );

  it.each(commands)(
    "handles empty results for $operation as successful empty geometry",
    ({ operation, emptySources }) => {
      expect(booleanShapes(emptySources(), operation)).toEqual({
        ok: true,
        elements: [],
      });
    },
  );

  it("intersects all inputs, including disconnected shared areas", () => {
    expect(
      area(linesFor([rect(), rect(50, 0), rect(0, 50)], "intersection")),
    ).toBeCloseTo(2500);
    const c = newLinearElement({
      type: "line",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      polygon: true,
      points: [
        [0, 0],
        [100, 0],
        [100, 25],
        [25, 25],
        [25, 75],
        [100, 75],
        [100, 100],
        [0, 100],
        [0, 0],
      ].map(([x, y]) => pointFrom<LocalPoint>(x, y)),
    });
    const lines = linesFor([c, rect(50, 0, 25, 100)], "intersection");
    expect(lines).toHaveLength(2);
    expect(area(lines)).toBeCloseTo(1250);
  });

  it("subtracts all cutters from the base and may produce separate pieces", () => {
    const sources = [rect(), rect(-10, -10, 35, 120), rect(75, -10, 35, 120)];
    const lines = linesFor(sources, "difference");
    expect(lines).toHaveLength(1);
    expect(area(lines)).toBeCloseTo(5000);
    expect(lines[0]).toMatchObject({ x: 25, width: 50, height: 100 });
    const parts = linesFor([rect(), rect(40, -10, 20, 120)], "difference");
    expect(parts).toHaveLength(2);
    expect(area(parts)).toBeCloseTo(8000);
  });

  it("uses scene order for difference and odd coverage for multi-shape XOR", () => {
    const big = {
      ...rect(0, 0, 200, 200),
      strokeColor: "#e03131",
      groupIds: ["base", "outer"],
      opacity: 60,
    };
    const small = rect(0, 0, 100, 100);
    const result = linesFor([big, small], "difference");
    expect(area(result)).toBeCloseTo(30000);
    expect(result[0]).toMatchObject({
      strokeColor: big.strokeColor,
      groupIds: big.groupIds,
      opacity: 60,
    });
    expect(linesFor([small, big], "difference")).toEqual([]);
    expect(area(linesFor([rect(), rect(), rect()], "xor"))).toBeCloseTo(10000);
    expect(linesFor([rect(), rect(), rect(), rect()], "xor")).toEqual([]);
  });

  it.each(["difference", "xor"] as const)(
    "refuses a nested $operation result with a hole",
    (operation) => {
      expect(
        booleanShapes([rect(0, 0, 200, 200), rect(50, 50, 50, 50)], operation),
      ).toEqual({ ok: false, reason: "holes" });
    },
  );

  it.each([
    [100, 0],
    [100, 100],
  ])("does not create zero-area lines for tangency at (%s,%s)", (x, y) => {
    const sources = [rect(), rect(x, y)];
    expect(linesFor(sources, "intersection")).toEqual([]);
    expect(area(linesFor(sources, "difference"))).toBeCloseTo(10000);
    expect(area(linesFor(sources, "xor"))).toBeCloseTo(20000);
  });

  it.each(commands)(
    "handles rotation with $operation independently of sketch jitter",
    ({ operation }) => {
      const sources = [
        { ...rect(0, 0, 100, 50), angle: (Math.PI / 2) as Radians },
        rect(50, 25),
      ];
      const lines = linesFor(sources, operation);
      const expected = { intersection: 1250, difference: 3750, xor: 12500 };
      expect(area(lines)).toBeCloseTo(expected[operation]);
      const altered = linesFor(
        [{ ...sources[0], roughness: 2, seed: 9876 }, sources[1]],
        operation,
      );
      expect(altered.map(({ points }) => points)).toEqual(
        lines.map(({ points }) => points),
      );
    },
  );

  it("works on native ellipses and their approximate editable outlines", () => {
    const circle = API.createElement({
      type: "ellipse",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    const cut = rect(50, 0);
    const intersection = linesFor([circle, cut], "intersection");
    const difference = linesFor([circle, cut], "difference");
    expect(area(intersection)).toBeGreaterThan(3800);
    expect(area(intersection)).toBeLessThan(4000);
    expect(area(difference)).toBeCloseTo(area(intersection));
    expect(area(linesFor([circle, cut], "xor"))).toBeCloseTo(10000);
  });

  it.each(commands)(
    "applies the same input safeguards to $operation",
    ({ operation }) => {
      const source = rect();
      expect(
        canBooleanShapes([source, { ...rect(50, 50), frameId: "other" }]),
      ).toBe(false);
      for (const other of [
        { ...source, locked: true },
        { ...source, boundElements: [{ id: "arrow", type: "arrow" as const }] },
        API.createElement({ type: "line" }),
        API.createElement({ type: "arrow" }),
      ]) {
        expect(booleanShapes([source, other], operation)).toEqual({
          ok: false,
          reason: "invalid",
        });
      }
      const crossing = newLinearElement({
        type: "line",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        polygon: true,
        points: [
          [0, 0],
          [100, 100],
          [0, 100],
          [100, 0],
          [0, 0],
        ].map(([x, y]) => pointFrom<LocalPoint>(x, y)),
      });
      expect(booleanShapes([source, crossing], operation)).toEqual({
        ok: false,
        reason: "invalid",
      });
      expect(
        booleanShapes(
          Array.from({ length: 101 }, () => rect()),
          operation,
        ),
      ).toEqual({ ok: false, reason: "tooComplex" });
    },
  );
});

describe("boolean shape actions", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  it.each(commands)(
    "executes $operation from the panel, preserves style/layer/groups/frame, saves and undoes",
    ({ operation, label, count, area: expectedArea }) => {
      const frame = API.createElement({ type: "frame" });
      const base = {
        ...rect(),
        frameId: frame.id,
        groupIds: ["base", "outer"],
        backgroundColor: "#ffc9c9",
        strokeColor: "#e03131",
        fillStyle: "solid" as const,
        opacity: 60,
      };
      const between = API.createElement({ type: "text", text: "between" });
      const top = {
        ...rect(50, 50),
        frameId: frame.id,
        groupIds: ["cutter", "outer"],
        backgroundColor: "#a5d8ff",
        fillStyle: "hachure" as const,
        opacity: 50,
      };
      const above = API.createElement({ type: "text", text: "above" });
      API.updateScene({
        elements: [frame, base, between, top, above],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      // Selection click order must not replace scene/layer order for difference.
      API.setSelectedElements([top, base]);
      fireEvent.click(screen.getByRole("button", { name: label }));
      const live = h.elements.filter((element) => !element.isDeleted);
      const lines = live.filter(
        (element): element is ExcalidrawLineElement => element.type === "line",
      );
      expect(lines).toHaveLength(count);
      expect(area(lines)).toBeCloseTo(expectedArea);
      const style = operation === "difference" ? base : top;
      lines.forEach((line) =>
        expect(line).toMatchObject({
          frameId: frame.id,
          backgroundColor: style.backgroundColor,
          fillStyle: style.fillStyle,
          opacity: style.opacity,
          groupIds: operation === "difference" ? base.groupIds : ["outer"],
        }),
      );
      expect(live[operation === "difference" ? count + 1 : 1].id).toBe(
        between.id,
      );
      expect(live.at(-1)?.id).toBe(above.id);
      expect(h.state.selectedElementIds).toEqual(
        Object.fromEntries(lines.map(({ id }) => [id, true])),
      );
      expect(h.state.selectedLinearElement?.isEditing ?? false).toBe(
        count === 1,
      );
      const saved = JSON.parse(
        serializeAsJSON(h.elements, h.state, {}, "local"),
      );
      const restored = restoreElements(saved.elements, null).filter(
        (element) => !element.isDeleted && element.type === "line",
      );
      restored.forEach((line, i) =>
        expect(line).toMatchObject({
          type: "line",
          polygon: true,
          points: lines[i].points,
          frameId: frame.id,
          groupIds: lines[i].groupIds,
        }),
      );
      Keyboard.undo();
      expect(
        h.elements.filter((element) => !element.isDeleted).map(({ id }) => id),
      ).toEqual([frame.id, base.id, between.id, top.id, above.id]);
      Keyboard.redo();
      expect(
        h.elements.filter((element) => !element.isDeleted).map(({ id }) => id),
      ).toEqual(live.map(({ id }) => id));
    },
  );

  it.each(commands)(
    "removes an empty $operation result in one undoable step with an explanation",
    ({ action, emptySources }) => {
      const sources = emptySources();
      const untouched = API.createElement({ type: "text", text: "keep" });
      API.updateScene({
        elements: [...sources, untouched],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      API.setSelectedElements(sources);
      API.executeAction(action);
      expect(
        h.elements.filter((element) => !element.isDeleted).map(({ id }) => id),
      ).toEqual([untouched.id]);
      expect(h.state.selectedElementIds).toEqual({});
      expect(h.state.selectedLinearElement).toBeNull();
      expect(h.state.toast?.message).toContain("result has no area");
      const saved = JSON.parse(
        serializeAsJSON(h.elements, h.state, {}, "local"),
      );
      expect(
        restoreElements(saved.elements, null)
          .filter((element) => !element.isDeleted)
          .map(({ id }) => id),
      ).toEqual([untouched.id]);
      Keyboard.undo();
      expect(
        h.elements.filter((element) => !element.isDeleted).map(({ id }) => id),
      ).toEqual([...sources.map(({ id }) => id), untouched.id]);
      Keyboard.redo();
      expect(
        h.elements.filter((element) => !element.isDeleted).map(({ id }) => id),
      ).toEqual([untouched.id]);
    },
  );

  it.each([actionDifferenceShapes, actionXorShapes])(
    "keeps originals and selection when holes are refused by $name",
    (action) => {
      const sources = [rect(0, 0, 200, 200), rect(50, 50, 50, 50)];
      API.setElements(sources);
      API.setSelectedElements(sources);
      API.executeAction(action);
      expect(h.elements).toEqual(sources);
      expect(h.state.selectedElementIds).toEqual(
        Object.fromEntries(sources.map(({ id }) => [id, true])),
      );
      expect(h.state.toast?.message).toContain("would create a hole");
    },
  );
});

describe("boolean operations on phones", () => {
  it.each(commands)(
    "exposes $operation from the mobile actions",
    async ({ label, count }) => {
      await render(<Excalidraw UIOptions={{ getFormFactor: () => "phone" }} />);
      fireEvent.resize(window);
      await waitFor(() =>
        expect(h.app.editorInterface.formFactor).toBe("phone"),
      );
      const sources = [rect(), rect(50, 50)];
      API.setElements(sources);
      API.setSelectedElements(sources);
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(h.elements.filter((element) => !element.isDeleted)).toHaveLength(
        count,
      );
    },
  );
});

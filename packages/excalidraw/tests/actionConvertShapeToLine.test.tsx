import React from "react";

import { ROUNDNESS } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/element";
import {
  canConvertShapeToLine,
  getShapeOutlinePoints,
  shapeToLine,
} from "@excalidraw/element/shapeToLine";

import type { Radians } from "@excalidraw/math";

import { actionConvertShapeToLine } from "../actions/actionConvertShapeToLine";
import { serializeAsJSON } from "../data/json";
import { restoreElements } from "../data/restore";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { render, screen, fireEvent } from "./test-utils";

const { h } = window;

describe("editable shape outlines", () => {
  it.each(["rectangle", "ellipse", "diamond"] as const)(
    "converts %s with rotation and native style data",
    (type) => {
      const original = API.createElement({
        type,
        x: 100,
        y: 200,
        width: 80,
        height: 40,
        angle: (Math.PI / 2) as Radians,
        backgroundColor: "#a5d8ff",
        fillStyle: "hachure",
        opacity: 50,
        groupIds: ["inner", "outer"],
        frameId: "frame",
      });
      if (!canConvertShapeToLine(original)) {
        throw new Error("Expected an outline shape");
      }
      const snapshot = JSON.stringify(original);
      const line = shapeToLine(original);
      expect(line).toMatchObject({
        type: "line",
        angle: 0,
        polygon: true,
        roundness: null,
        groupIds: original.groupIds,
        frameId: "frame",
        backgroundColor: "#a5d8ff",
        fillStyle: "hachure",
        opacity: 50,
      });
      expect(line.id).not.toBe(original.id);
      expect(line.points[0]).toEqual(line.points.at(-1));
      const global = line.points.map(([x, y]) => [line.x + x, line.y + y]);
      const expectedFirst =
        type === "rectangle"
          ? [160, 180]
          : type === "diamond"
          ? [160, 220]
          : [140, 260];
      expectedFirst.forEach((value, i) =>
        expect(global[0][i]).toBeCloseTo(value),
      );
      expect(JSON.stringify(original)).toBe(snapshot);
    },
  );

  it("uses four corners for sharp shapes and samples rounded geometry", () => {
    for (const type of ["rectangle", "diamond"] as const) {
      const sharp = API.createElement({
        type,
        width: 100,
        height: 60,
        roundness: null,
      });
      if (!canConvertShapeToLine(sharp)) {
        throw new Error("Expected an outline shape");
      }
      expect(shapeToLine(sharp).points).toHaveLength(5);
      const rounded = {
        ...sharp,
        roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
      };
      expect(shapeToLine(rounded).points.length).toBeGreaterThan(5);
    }
  });

  it("adapts ellipse sampling to size and keeps approximation error below 0.75", () => {
    let previous = 0;
    for (const size of [4, 100, 1000]) {
      const ellipse = API.createElement({
        type: "ellipse",
        x: 0,
        y: 0,
        width: size,
        height: size,
      });
      if (!canConvertShapeToLine(ellipse)) {
        throw new Error("Expected an outline shape");
      }
      const points = getShapeOutlinePoints(ellipse);
      expect(points.length).toBeGreaterThanOrEqual(previous);
      previous = points.length;
      for (let i = 1; i < points.length; i++) {
        const x = (points[i - 1][0] + points[i][0]) / 2 - size / 2;
        const y = (points[i - 1][1] + points[i][1]) / 2 - size / 2;
        expect(size / 2 - Math.hypot(x, y)).toBeLessThanOrEqual(0.75);
      }
    }
  });

  it("rejects degenerate, locked, deleted and bound shapes", () => {
    const shape = API.createElement({
      type: "rectangle",
      width: 100,
      height: 60,
    });
    expect(canConvertShapeToLine(shape)).toBe(true);
    for (const overrides of [
      { width: 0 },
      { height: NaN },
      { locked: true },
      { isDeleted: true },
      { boundElements: [{ id: "text", type: "text" as const }] },
      { boundElements: [{ id: "arrow", type: "arrow" as const }] },
    ]) {
      expect(canConvertShapeToLine({ ...shape, ...overrides })).toBe(false);
    }
    expect(canConvertShapeToLine(API.createElement({ type: "line" }))).toBe(
      false,
    );
  });
});

describe("convert shape action", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  it("enters point editing and restores the original on undo, then redoes", () => {
    const shape = API.createElement({
      type: "ellipse",
      width: 100,
      height: 60,
    });
    API.updateScene({
      elements: [shape],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([shape]);
    fireEvent.click(
      screen.getByRole("button", { name: "Convert to editable outline" }),
    );
    const line = h.elements.find((element) => !element.isDeleted)!;
    expect(h.state.selectedLinearElement).toMatchObject({
      elementId: line.id,
      isEditing: true,
    });
    Keyboard.undo();
    expect(h.elements.filter((element) => !element.isDeleted)).toEqual([
      expect.objectContaining({ id: shape.id, type: "ellipse" }),
    ]);
    Keyboard.redo();
    expect(h.elements.filter((element) => !element.isDeleted)).toEqual([
      expect.objectContaining({ id: line.id, type: "line" }),
    ]);
  });

  it("retains layer order, groups, frames and serializes as ordinary editable lines", () => {
    const frame = API.createElement({ type: "frame" });
    const first = API.createElement({
      type: "rectangle",
      width: 80,
      height: 40,
      groupIds: ["group"],
      frameId: frame.id,
    });
    const middle = API.createElement({ type: "line" });
    const last = API.createElement({ type: "diamond", width: 80, height: 40 });
    API.setElements([frame, first, middle, last]);
    API.setSelectedElements([first, last]);
    API.executeAction(actionConvertShapeToLine);
    const live = h.elements.filter((element) => !element.isDeleted);
    expect(live.map(({ type }) => type)).toEqual([
      "frame",
      "line",
      "line",
      "line",
    ]);
    expect(live[2].id).toBe(middle.id);
    expect(live[1]).toMatchObject({ groupIds: ["group"], frameId: frame.id });
    expect(h.state.selectedLinearElement).toBeNull();
    const saved = JSON.parse(serializeAsJSON(h.elements, h.state, {}, "local"));
    const restored = restoreElements(saved.elements, null).filter(
      (element) => !element.isDeleted,
    );
    expect(restored.map(({ type }) => type)).toEqual(
      live.map(({ type }) => type),
    );
    expect(restored[1]).toMatchObject({
      points: (live[1] as ReturnType<typeof shapeToLine>).points,
      polygon: true,
      groupIds: ["group"],
      frameId: frame.id,
    });
  });

  it("leaves mixed selections untouched", () => {
    const shape = API.createElement({ type: "rectangle" });
    const line = API.createElement({ type: "line" });
    API.setElements([shape, line]);
    API.setSelectedElements([shape, line]);
    expect(
      screen.queryByRole("button", { name: "Convert to editable outline" }),
    ).toBeNull();
    API.executeAction(actionConvertShapeToLine);
    expect(h.elements.map(({ id }) => id)).toEqual([shape.id, line.id]);
  });
});

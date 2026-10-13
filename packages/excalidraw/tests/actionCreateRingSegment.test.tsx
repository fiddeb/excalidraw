import React from "react";

import { CaptureUpdateAction } from "@excalidraw/element";
import {
  canCreateRingSegment,
  ellipseToRingSegment,
  getRingSegmentPoints,
  isValidRingSegment,
} from "@excalidraw/element/ringSegment";

import type { Radians } from "@excalidraw/math";

import { actionCreateRingSegment } from "../actions/actionCreateRingSegment";
import { serializeAsJSON } from "../data/json";
import { restoreElements } from "../data/restore";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { render, screen, fireEvent, waitFor } from "./test-utils";

const { h } = window;
const options = {
  outerRadius: 100,
  innerRadius: 50,
  startAngle: 0,
  endAngle: 90,
};

describe("ring segment geometry", () => {
  it("walks the outer arc, inner arc backwards and closes with actual edges", () => {
    const points = getRingSegmentPoints(options);
    const steps = (points.length - 1) / 2;
    expect(points[0]).toEqual([100, 0]);
    expect(points[steps - 1][0]).toBeCloseTo(0);
    expect(points[steps - 1][1]).toBeCloseTo(100);
    expect(points[steps][0]).toBeCloseTo(0);
    expect(points[steps][1]).toBeCloseTo(50);
    expect(points.at(-2)).toEqual([50, 0]);
    expect(points.at(-1)).toEqual(points[0]);
    // Each inner/outer chord stays within its radius, with <0.75 approximation error.
    for (let i = 1; i < steps; i++) {
      const middle = points[i].map(
        (value, axis) => (value + points[i - 1][axis]) / 2,
      );
      expect(100 - Math.hypot(...middle)).toBeLessThanOrEqual(0.75);
    }
  });

  it.each([270, -270, 359.9, -359.9, 0.1])(
    "supports a signed span of %s degrees without a compound path",
    (endAngle) => {
      const points = getRingSegmentPoints({ ...options, endAngle });
      expect(points.length).toBeGreaterThan(4);
      expect(points[0]).toEqual(points.at(-1));
      const inner = points.slice((points.length - 1) / 2, -1);
      inner.forEach(([x, y]) => expect(Math.hypot(x, y)).toBeCloseTo(50));
    },
  );

  it("allows sectors and scales the sampling with radius", () => {
    const sector = getRingSegmentPoints({ ...options, innerRadius: 0 });
    expect(sector.at(-2)).toEqual([0, 0]);
    expect(
      getRingSegmentPoints({ ...options, outerRadius: 1000 }).length,
    ).toBeGreaterThan(getRingSegmentPoints(options).length);
  });

  it.each([
    { innerRadius: 100 },
    { innerRadius: -1 },
    { outerRadius: 0 },
    { outerRadius: 10001 },
    { endAngle: 360 },
    { endAngle: 0 },
    { endAngle: NaN },
    { startAngle: Infinity },
    { endAngle: 3601 },
  ])("rejects invalid values %j", (override) => {
    const value = { ...options, ...override };
    expect(isValidRingSegment(value)).toBe(false);
    expect(() => getRingSegmentPoints(value)).toThrow();
  });

  it("keeps source center, rotation, frame, groups and style without mutating the ellipse", () => {
    const source = API.createElement({
      type: "ellipse",
      x: 100,
      y: 200,
      width: 200,
      height: 100,
      angle: (Math.PI / 2) as Radians,
      groupIds: ["inner", "outer"],
      frameId: "frame",
      opacity: 60,
      backgroundColor: "#a5d8ff",
      fillStyle: "cross-hatch",
    });
    if (!canCreateRingSegment(source)) {
      throw new Error("Expected an eligible ellipse");
    }
    const snapshot = JSON.stringify(source);
    const line = ellipseToRingSegment(source, options);
    expect(line).toMatchObject({
      type: "line",
      angle: 0,
      polygon: true,
      roundness: null,
      groupIds: source.groupIds,
      frameId: "frame",
      opacity: 60,
      backgroundColor: "#a5d8ff",
      fillStyle: "cross-hatch",
    });
    expect(line.x).toBeCloseTo(200);
    expect(line.y).toBeCloseTo(350);
    expect(line.id).not.toBe(source.id);
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it("rejects locked, deleted and bound ellipses", () => {
    const source = API.createElement({ type: "ellipse" });
    for (const override of [
      { locked: true },
      { isDeleted: true },
      { boundElements: [{ id: "text", type: "text" as const }] },
      { boundElements: [{ id: "arrow", type: "arrow" as const }] },
      { width: 0 },
    ]) {
      expect(canCreateRingSegment({ ...source, ...override })).toBe(false);
    }
    expect(canCreateRingSegment(API.createElement({ type: "rectangle" }))).toBe(
      false,
    );
  });
});

describe("ring segment dialog and action", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  it("validates values, previews and replaces in place with undo/redo and file round-trip", () => {
    const frame = API.createElement({ type: "frame" });
    const ellipse = API.createElement({
      type: "ellipse",
      width: 200,
      height: 200,
      groupIds: ["group"],
      frameId: frame.id,
    });
    const above = API.createElement({ type: "rectangle" });
    API.updateScene({
      elements: [frame, ellipse, above],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([ellipse]);
    fireEvent.click(
      screen.getByRole("button", { name: "Create ring segment" }),
    );
    expect(
      screen.getByRole("img", { name: "Ring segment preview" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("End angle (°)"), {
      target: { value: "360" },
    });
    expect(
      screen.getByRole("button", { name: "Replace ellipse" }),
    ).toBeDisabled();
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("End angle (°)"), {
      target: { value: "270" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace ellipse" }));
    const live = h.elements.filter((element) => !element.isDeleted);
    expect(live.map(({ type }) => type)).toEqual([
      "frame",
      "line",
      "rectangle",
    ]);
    const line = live[1];
    expect(line).toMatchObject({ groupIds: ["group"], frameId: frame.id });
    expect(live[2].id).toBe(above.id);
    expect(h.state.openDialog).toBeNull();
    expect(h.state.selectedLinearElement).toMatchObject({
      elementId: line.id,
      isEditing: true,
    });
    const json = JSON.parse(serializeAsJSON(h.elements, h.state, {}, "local"));
    expect(
      restoreElements(json.elements, null).filter(
        (element) => !element.isDeleted,
      )[1],
    ).toMatchObject({
      type: "line",
      points: (line as ReturnType<typeof ellipseToRingSegment>).points,
      polygon: true,
      frameId: frame.id,
    });
    Keyboard.undo();
    expect(
      h.elements
        .filter((element) => !element.isDeleted)
        .map(({ type }) => type),
    ).toEqual(["frame", "ellipse", "rectangle"]);
    Keyboard.redo();
    expect(h.elements.filter((element) => !element.isDeleted)[1]).toMatchObject(
      { id: line.id, type: "line" },
    );
  });

  it("cancels without replacing the original", () => {
    const ellipse = API.createElement({ type: "ellipse" });
    API.setElements([ellipse]);
    API.setSelectedElements([ellipse]);
    API.executeAction(actionCreateRingSegment);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.state.openDialog).toBeNull();
    expect(h.elements.map(({ id }) => id)).toEqual([ellipse.id]);
  });
});

describe("ring segments on phones", () => {
  it("opens the dialog from the mobile actions and creates an editable contour", async () => {
    await render(<Excalidraw UIOptions={{ getFormFactor: () => "phone" }} />);
    const ellipse = API.createElement({
      type: "ellipse",
      width: 100,
      height: 100,
    });
    API.setElements([ellipse]);
    API.setSelectedElements([ellipse]);
    fireEvent.resize(window);
    await waitFor(() => expect(h.app.editorInterface.formFactor).toBe("phone"));
    fireEvent.click(
      screen.getByRole("button", { name: "Create ring segment" }),
    );
    expect(
      screen.getByRole("img", { name: "Ring segment preview" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace ellipse" }));
    expect(h.elements.filter((element) => !element.isDeleted)).toEqual([
      expect.objectContaining({ type: "line", polygon: true }),
    ]);
  });
});

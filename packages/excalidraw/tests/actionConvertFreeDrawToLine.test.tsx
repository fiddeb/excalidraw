import React from "react";

import { pointFrom } from "@excalidraw/math";
import { CaptureUpdateAction, newFreeDrawElement } from "@excalidraw/element";
import {
  canConvertFreeDrawToLine,
  freeDrawToLine,
} from "@excalidraw/element/freeDrawToLine";

import type { LocalPoint, Radians } from "@excalidraw/math";

import { actionConvertFreeDrawToLine } from "../actions/actionConvertFreeDrawToLine";
import { serializeAsJSON } from "../data/json";
import { restoreElements } from "../data/restore";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { render, screen, fireEvent } from "./test-utils";

const { h } = window;
const point = (x: number, y: number) => pointFrom<LocalPoint>(x, y);
const stroke = () =>
  newFreeDrawElement({
    type: "freedraw",
    x: 100,
    y: 200,
    width: 40,
    height: 30,
    points: [point(0, 0), point(10, 0.2), point(20, 0), point(40, 30)],
    pressures: [0.2, 0.5, 0.8, 0.4],
    simulatePressure: false,
    strokeColor: "#e03131",
    strokeWidth: 2,
    opacity: 60,
  });

describe("freeDrawToLine", () => {
  it("simplifies the centerline into ordinary line data without mutating the stroke", () => {
    const original = stroke();
    const snapshot = JSON.stringify(original);
    const line = freeDrawToLine(original);
    expect(line.type).toBe("line");
    expect(line.id).not.toBe(original.id);
    expect(line.points).toEqual([point(0, 0), point(20, 0), point(40, 30)]);
    expect(line).toMatchObject({
      x: 100,
      y: 200,
      width: 40,
      height: 30,
      strokeColor: original.strokeColor,
      strokeWidth: 2,
      opacity: 60,
      startArrowhead: null,
      endArrowhead: null,
      roundness: null,
    });
    expect(line).not.toHaveProperty("pressures");
    expect(line).not.toHaveProperty("strokeOptions");
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("keeps rotated points in the same scene positions", () => {
    const original = {
      ...stroke(),
      angle: (Math.PI / 2) as Radians,
      points: [point(10, 20), point(30, 20), point(30, 40)],
    };
    const line = freeDrawToLine(original);
    expect(line.angle).toBe(0);
    const globalPoints = line.points.map(([x, y]) => [x + line.x, y + line.y]);
    for (const [index, expected] of [
      [130, 220],
      [130, 240],
      [110, 240],
    ].entries()) {
      expect(globalPoints[index][0]).toBeCloseTo(expected[0]);
      expect(globalPoints[index][1]).toBeCloseTo(expected[1]);
    }
  });

  it("closes filled contours and retains their group, frame and styling", () => {
    const original = {
      ...stroke(),
      points: [
        point(0, 0),
        point(100, 0),
        point(100, 100),
        point(0, 100),
        point(0, 2),
      ],
      backgroundColor: "#a5d8ff",
      groupIds: ["group"],
      frameId: "frame",
      link: "https://excalidraw.com",
    };
    const line = freeDrawToLine(original);
    expect(line.points[line.points.length - 1]).toEqual(line.points[0]);
    expect(line).toMatchObject({
      polygon: true,
      backgroundColor: original.backgroundColor,
      fillStyle: original.fillStyle,
      groupIds: original.groupIds,
      frameId: original.frameId,
      link: original.link,
    });
  });

  it("rejects dots and locked strokes", () => {
    expect(
      canConvertFreeDrawToLine({
        ...stroke(),
        points: [point(0, 0), point(0, 0)],
      }),
    ).toBe(false);
    expect(canConvertFreeDrawToLine({ ...stroke(), locked: true })).toBe(false);
    expect(canConvertFreeDrawToLine({ ...stroke(), points: [] })).toBe(false);
  });
});

describe("convert freedraw action", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  it("is available in the panel, enters point editing and supports undo/redo", () => {
    const original = stroke();
    API.updateScene({
      elements: [original],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([original]);
    fireEvent.click(
      screen.getByRole("button", { name: "Convert to editable line" }),
    );
    const line = h.elements.find((element) => !element.isDeleted)!;
    expect(line.type).toBe("line");
    expect(h.state.selectedLinearElement).toMatchObject({
      elementId: line.id,
      isEditing: true,
    });

    Keyboard.undo();
    expect(h.elements.filter((element) => !element.isDeleted)).toEqual([
      expect.objectContaining({
        id: original.id,
        type: "freedraw",
        pressures: original.pressures,
      }),
    ]);
    Keyboard.redo();
    expect(h.elements.filter((element) => !element.isDeleted)).toEqual([
      expect.objectContaining({ id: line.id, type: "line" }),
    ]);
  });

  it("converts multiple strokes and round-trips through the existing file format", () => {
    const first = stroke();
    const second = { ...stroke(), x: 300 };
    API.setElements([first, second]);
    API.setSelectedElements([first, second]);
    API.executeAction(actionConvertFreeDrawToLine);
    const lines = h.elements.filter((element) => !element.isDeleted);
    expect(lines.map((element) => element.type)).toEqual(["line", "line"]);
    expect(h.state.selectedElementIds).toEqual(
      Object.fromEntries(lines.map(({ id }) => [id, true])),
    );
    const exported = JSON.parse(
      serializeAsJSON(h.elements, h.state, {}, "local"),
    );
    const restored = restoreElements(exported.elements, null).filter(
      (element) => !element.isDeleted,
    );
    expect(restored).toHaveLength(2);
    restored.forEach((element, index) => {
      expect(element).toMatchObject({
        ...JSON.parse(JSON.stringify(lines[index])),
        boundElements: [],
      });
    });
  });

  it("does not convert a mixed selection", () => {
    const original = stroke();
    const rectangle = API.createElement({ type: "rectangle" });
    API.setElements([original, rectangle]);
    API.setSelectedElements([original, rectangle]);
    expect(
      screen.queryByRole("button", { name: "Convert to editable line" }),
    ).toBeNull();
    API.executeAction(actionConvertFreeDrawToLine);
    expect(h.elements.map((element) => element.type)).toEqual([
      "freedraw",
      "rectangle",
    ]);
  });
});

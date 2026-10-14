import { arrayToMap, isTransparent } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/element";
import {
  booleanShapes,
  getBooleanShapePoints,
} from "@excalidraw/element/booleanOperations";
import {
  canCutAtIntersections,
  cutAtIntersections,
} from "@excalidraw/element/cutAtIntersections";
import { splitKeyholeContours } from "@excalidraw/element/polygonContours";
import { ellipseToRingSegmentElements } from "@excalidraw/element/ringSegment";
import { pointFrom, polygonIncludesPoint, polygon } from "@excalidraw/math";

import type { GlobalPoint, LocalPoint, Radians } from "@excalidraw/math";
import type { ExcalidrawLineElement } from "@excalidraw/element/types";

import { actionCopyStyles, actionPasteStyles } from "../actions/actionStyles";

import {
  actionChangeBackgroundColor,
  actionChangeStrokeColor,
  actionChangeRoundness,
} from "../actions/actionProperties";

import { actionCutAtIntersections } from "../actions/actionCutAtIntersections";
import { actionImportEditableSvg } from "../actions/actionImportEditableSvg";
import { importEditableSvg } from "../data/editableSvg";
import * as editableSvgData from "../data/editableSvg";
import { serializeAsJSON } from "../data/json";
import { restoreElements } from "../data/restore";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { render, screen, fireEvent, waitFor, act } from "./test-utils";

const { h } = window;
const rectangle = (x = 0, y = 0, width = 200, height = 200) =>
  API.createElement({
    type: "rectangle",
    x,
    y,
    width,
    height,
    roundness: null,
    backgroundColor: "#ff000080",
    opacity: 60,
  });
const svg = (content: string, attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${content}</svg>`;
const convert = (content: string, attrs = "") =>
  importEditableSvg(svg(content, attrs), window.DOMParser);
const covers = (line: ExcalidrawLineElement, x: number, y: number) => {
  const rings = splitKeyholeContours(getBooleanShapePoints(line))!;
  return (
    rings.filter((ring) =>
      polygonIncludesPoint(pointFrom<GlobalPoint>(x, y), polygon(...ring)),
    ).length %
      2 ===
    1
  );
};

describe("native hole geometry", () => {
  it.each(["solid", "hachure", "cross-hatch"] as const)(
    "preserves transparent holes with %s fill and multiple islands",
    (fillStyle) => {
      const sources = [
        { ...rectangle(), fillStyle },
        rectangle(30, 30, 40, 40),
        rectangle(110, 110, 40, 40),
      ];
      const result = booleanShapes(sources, "difference");
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.elements).toHaveLength(4);
      expect(new Set(result.elements.map(({ id }) => id)).size).toBe(4);
      const paint = result.elements[0];
      expect(paint).toMatchObject({
        strokeColor: "transparent",
        backgroundColor: "#ff000080",
        fillStyle,
        opacity: 60,
      });
      expect(covers(paint, 10, 10)).toBe(true);
      expect(covers(paint, 50, 50)).toBe(false);
      expect(covers(paint, 130, 130)).toBe(false);
      expect(
        result.elements
          .slice(1)
          .every((element) => isTransparent(element.backgroundColor)),
      ).toBe(true);
      expect(result.elements.every((element) => !element.customData)).toBe(
        true,
      );
      const saved = JSON.parse(JSON.stringify(result.elements));
      const restored = restoreElements(saved, null) as ExcalidrawLineElement[];
      expect(covers(restored[0], 50, 50)).toBe(false);
      const next = booleanShapes(
        [...restored, rectangle(20, 20, 60, 60)],
        "union",
      );
      expect(next.ok).toBe(true);
      if (next.ok) {
        expect(covers(next.elements[0], 50, 50)).toBe(true);
        expect(covers(next.elements[0], 130, 130)).toBe(false);
      }
    },
  );

  it("creates a full donut at the ellipse center and retains frame and groups", () => {
    const ellipse = API.createElement({
      type: "ellipse",
      x: 100,
      y: 200,
      width: 200,
      height: 200,
      angle: (Math.PI / 3) as Radians,
      frameId: "frame",
      groupIds: ["outer"],
      backgroundColor: "#ff0000",
    });
    if (ellipse.type !== "ellipse") {
      throw new Error("Expected ellipse");
    }
    const parts = ellipseToRingSegmentElements(ellipse, {
      outerRadius: 100,
      innerRadius: 50,
      startAngle: 0,
      endAngle: 360,
    });
    expect(parts).toHaveLength(3);
    expect(covers(parts[0], 200, 300)).toBe(false);
    expect(covers(parts[0], 270, 300)).toBe(true);
    expect(
      parts.every(
        (part) => part.frameId === "frame" && part.groupIds[1] === "outer",
      ),
    ).toBe(true);
  });
});

describe("cut at intersections", () => {
  const line = (x: number, y: number, dx: number, dy: number) =>
    API.createElement({
      type: "line",
      x,
      y,
      width: Math.abs(dx),
      height: Math.abs(dy),
      points: [pointFrom(0, 0), pointFrom(dx, dy)],
      roundness: null,
    });
  it("cuts two crossing strokes at exact scene coordinates and preserves their styles", () => {
    const a = {
      ...line(0, 50, 100, 0),
      strokeColor: "#ff0000",
      groupIds: ["group"],
    };
    const b = line(50, 0, 0, 100);
    const result = cutAtIntersections([a, b], arrayToMap([a, b]));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect([...result.replacements.values()].flat()).toHaveLength(4);
    const parts = result.replacements.get(a.id)!;
    expect(parts[0]).toMatchObject({
      x: 0,
      y: 50,
      points: [
        [0, 0],
        [50, 0],
      ],
      strokeColor: "#ff0000",
      groupIds: ["group"],
      backgroundColor: "transparent",
    });
    expect(parts[1]).toMatchObject({
      x: 50,
      y: 50,
      points: [
        [0, 0],
        [50, 0],
      ],
    });
    expect(
      new Set([...result.replacements.values()].flat().map(({ id }) => id))
        .size,
    ).toBe(4);
  });
  it("cuts a closed shape cyclically without adding a spurious fragment at its origin", () => {
    const shape = rectangle(0, 0, 100, 100);
    const cutter = line(-10, 50, 120, 0);
    const result = cutAtIntersections(
      [shape, cutter],
      arrayToMap([shape, cutter]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.replacements.get(shape.id)).toHaveLength(2);
    expect(result.replacements.get(cutter.id)).toHaveLength(3);
    expect(
      result.replacements
        .get(shape.id)!
        .every(
          (part) => !part.polygon && part.backgroundColor === "transparent",
        ),
    ).toBe(true);
  });
  it("cuts a native hole group without cutting invisible bridges or leaving its fill behind", () => {
    const hole = booleanShapes(
      [rectangle(), rectangle(50, 50, 50, 50)],
      "difference",
    );
    if (!hole.ok) {
      throw new Error("Missing hole geometry");
    }
    const cutter = line(-20, 75, 240, 0);
    const sources = [...hole.elements, cutter];
    const result = cutAtIntersections(sources, arrayToMap(sources));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.replacements.get(hole.elements[0].id)).toEqual([]);
      expect(result.replacements.get(hole.elements[1].id)).toHaveLength(2);
      expect(result.replacements.get(hole.elements[2].id)).toHaveLength(2);
      expect(result.replacements.get(cutter.id)).toHaveLength(5);
    }
  });

  it("handles T junctions, rotation and untouched selections; refuses overlap and frames", () => {
    const a = line(0, 50, 100, 0);
    const b = line(50, 50, 0, 100);
    const result = cutAtIntersections([a, b], arrayToMap([a, b]));
    expect(result.ok && result.replacements.get(a.id)).toHaveLength(2);
    expect(result.ok && result.replacements.has(b.id)).toBe(false);
    const rotated = { ...line(0, 50, 100, 0), angle: (Math.PI / 2) as Radians };
    const horizontal = line(0, 50, 100, 0);
    const rotatedResult = cutAtIntersections(
      [rotated, horizontal],
      arrayToMap([rotated, horizontal]),
    );
    expect(rotatedResult.ok && rotatedResult.replacements.size).toBe(2);
    expect(
      cutAtIntersections([a, line(10, 50, 100, 0)], arrayToMap([a])),
    ).toEqual({ ok: false, reason: "overlap" });
    expect(canCutAtIntersections([a, { ...b, frameId: "other" }])).toBe(false);
    expect(
      canCutAtIntersections([
        a,
        { ...b, boundElements: [{ id: "text", type: "text" }] },
      ]),
    ).toBe(false);
  });
});

describe("editable SVG conversion", () => {
  it("keeps rectangles and ellipses native, preserving viewBox, transforms and nested groups", () => {
    const result = convert(
      '<g transform="translate(10 20)"><g transform="rotate(90)"><rect x="0" y="0" width="20" height="10" fill="red"/><ellipse cx="40" cy="20" rx="10" ry="5" fill="blue"/></g></g>',
      'viewBox="0 0 100 100" width="200" height="200"',
    );
    expect(result.warnings).toEqual([]);
    expect(result.elements.map(({ type }) => type)).toEqual([
      "rectangle",
      "ellipse",
    ]);
    expect(result.elements[0]).toMatchObject({
      y: 50,
      width: 40,
      height: 20,
      backgroundColor: "#ff0000",
      angle: Math.PI / 2,
    });
    expect(result.elements[0].x).toBeCloseTo(-10);
    expect(result.elements[0].groupIds).toHaveLength(3);
    expect(result.elements[0].groupIds).toEqual(result.elements[1].groupIds);
  });
  it("turns cubic, quadratic and arc paths into editable line points", () => {
    for (const d of [
      "M0 0 C20 80 80 80 100 0",
      "M0 0 Q50 80 100 0",
      "M0 0 A50 50 0 0 1 100 0",
    ]) {
      const result = convert(`<path d="${d}" fill="none" stroke="red"/>`);
      expect(result.warnings).toEqual([]);
      expect(result.elements).toHaveLength(1);
      const element = result.elements[0] as ExcalidrawLineElement;
      expect(element.type).toBe("line");
      expect(element.points.length).toBeGreaterThan(3);
      expect(element.points[0]).toEqual([0, 0]);
      expect(element.points[element.points.length - 1]).toEqual([100, 0]);
    }
  });
  it("preserves compound evenodd and nonzero holes without painting a cover", () => {
    for (const rule of ["evenodd", "nonzero"]) {
      const result = convert(
        `<path d="M0 0H100V100H0Z M25 25V75H75V25Z" fill="red" stroke="black" fill-rule="${rule}"/>`,
      );
      expect(result.warnings).toEqual([]);
      const paint = result.elements.find(
        (element) => !isTransparent(element.backgroundColor),
      ) as ExcalidrawLineElement;
      expect(covers(paint, 10, 10)).toBe(true);
      expect(covers(paint, 50, 50)).toBe(false);
      expect(
        result.elements.every(
          (element) => element.type === "line" && !element.customData,
        ),
      ).toBe(true);
    }
    const filled = convert(
      '<path d="M0 0H100V100H0Z M25 25H75V75H25Z" fill="red"/>',
    );
    expect(covers(filled.elements[0] as ExcalidrawLineElement, 50, 50)).toBe(
      true,
    );
  });
  it("applies currentColor, inherited paint and alpha; preserves an open stroked path's endpoints", () => {
    const result = convert(
      '<g color="#123456" fill="currentColor" fill-opacity="0.5"><rect width="10" height="20"/><path d="M0 0L20 20L40 0" stroke="black"/></g>',
    );
    expect(result.elements[0].backgroundColor).toBe("#12345680");
    const outline = result.elements[
      result.elements.length - 1
    ] as ExcalidrawLineElement;
    expect(outline.points).toEqual([
      [0, 0],
      [20, 20],
      [40, 0],
    ]);
    expect(outline.polygon).toBe(false);
  });
  it("reports skipped resources/effects and rejects XML entities and malformed paths safely", () => {
    const result = convert(
      '<script>alert(1)</script><image href="https://example.com/test.png"/><text>Text</text><rect width="20" height="20" fill="url(#gradient)"/><rect width="20" height="20" filter="url(#blur)"/><path d="M0 0Z,1"/><rect width="10" height="10"/>',
    );
    expect(result.elements).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(6);
    expect(() =>
      importEditableSvg(
        '<!DOCTYPE svg SYSTEM "https://example.com"><svg/>',
        window.DOMParser,
      ),
    ).toThrow();
    expect(() => importEditableSvg("<svg", window.DOMParser)).toThrow();
  });
});

describe("advanced geometry editor actions", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });
  it("cuts in one undoable step and retains unrelated elements and native serialization", () => {
    const a = API.createElement({
      type: "line",
      x: 0,
      y: 50,
      points: [pointFrom(0, 0), pointFrom(100, 0)],
      width: 100,
      height: 0,
    });
    const b = API.createElement({
      type: "line",
      x: 50,
      y: 0,
      points: [pointFrom(0, 0), pointFrom(0, 100)],
      width: 0,
      height: 100,
    });
    const untouched = rectangle(200, 200);
    API.updateScene({
      elements: [a, b, untouched],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([a, b]);
    API.executeAction(actionCutAtIntersections);
    expect(h.elements.filter((element) => !element.isDeleted)).toHaveLength(5);
    const saved = JSON.parse(serializeAsJSON(h.elements, h.state, {}, "local"));
    expect(
      restoreElements(saved.elements, null).filter(
        (element) => !element.isDeleted,
      ),
    ).toHaveLength(5);
    Keyboard.undo();
    expect(
      h.elements.filter((element) => !element.isDeleted).map(({ id }) => id),
    ).toEqual([a.id, b.id, untouched.id]);
    Keyboard.redo();
    expect(h.elements.filter((element) => !element.isDeleted)).toHaveLength(5);
  });
  it("restyles native hole fills and boundaries independently without closing the hole", () => {
    const result = booleanShapes(
      [rectangle(), rectangle(50, 50, 50, 50)],
      "difference",
    );
    if (!result.ok) {
      throw new Error("Missing hole geometry");
    }
    API.updateScene({
      elements: result.elements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements(result.elements);
    act(() =>
      h.app.actionManager.executeAction(actionChangeBackgroundColor, "ui", {
        color: "#00ff00",
      }),
    );
    expect(h.elements[0].backgroundColor).toBe("#00ff00");
    expect(
      h.elements
        .slice(1)
        .every((element) => element.backgroundColor === "transparent"),
    ).toBe(true);
    act(() =>
      h.app.actionManager.executeAction(actionChangeStrokeColor, "ui", {
        color: "#0000ff",
      }),
    );
    expect(h.elements[0].strokeColor).toBe("transparent");
    expect(
      h.elements.slice(1).every((element) => element.strokeColor === "#0000ff"),
    ).toBe(true);
    expect(covers(h.elements[0] as ExcalidrawLineElement, 75, 75)).toBe(false);
    act(() =>
      h.app.actionManager.executeAction(actionChangeRoundness, "ui", "round"),
    );
    expect(h.elements.every((element) => element.roundness === null)).toBe(
      true,
    );
  });

  it("uses a filled open SVG curve as a boolean area without treating its stroke as another operand", () => {
    const result = convert(
      '<path d="M0 0Q50 80 100 0" fill="red" stroke="black"/>',
    );
    const combined = booleanShapes(
      [...result.elements, rectangle(40, -20, 20, 100)],
      "difference",
    );
    expect(combined.ok).toBe(true);
    if (combined.ok) {
      expect(combined.elements).toHaveLength(2);
    }
  });

  it("restyles a filled open SVG curve without adding a closing stroke", () => {
    const result = convert(
      '<path d="M0 0Q50 80 100 0" fill="red" stroke="black"/>',
    );
    API.updateScene({
      elements: result.elements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements(result.elements);
    act(() =>
      h.app.actionManager.executeAction(actionChangeBackgroundColor, "ui", {
        color: "#00ff00",
      }),
    );
    const outlines = h.elements.filter(
      (element) => !isTransparent(element.strokeColor),
    );
    expect(outlines).toHaveLength(1);
    expect(outlines[0].backgroundColor).toBe("transparent");
    expect((outlines[0] as ExcalidrawLineElement).polygon).toBe(false);
  });

  it("preserves paint roles and refuses boolean operations after an independent boundary edit", () => {
    const result = booleanShapes(
      [rectangle(), rectangle(50, 50, 50, 50)],
      "difference",
    );
    if (!result.ok) {
      throw new Error("Missing hole geometry");
    }
    const edited = result.elements.map((element, index) =>
      index === 1
        ? {
            ...element,
            points: element.points.map((point, i) =>
              i === 1 ? pointFrom<LocalPoint>(point[0] + 5, point[1]) : point,
            ),
          }
        : element,
    );
    expect(booleanShapes([...edited, rectangle(250, 0)], "union")).toEqual({
      ok: false,
      reason: "invalid",
    });
    API.setElements(edited);
    API.setSelectedElements(edited);
    act(() =>
      h.app.actionManager.executeAction(actionChangeBackgroundColor, "ui", {
        color: "#00ff00",
      }),
    );
    expect(h.elements[0].backgroundColor).toBe("#00ff00");
    expect(
      h.elements
        .slice(1)
        .every((element) => element.backgroundColor === "transparent"),
    ).toBe(true);
    act(() =>
      h.app.actionManager.executeAction(actionChangeStrokeColor, "ui", {
        color: "#0000ff",
      }),
    );
    expect(h.elements[0].strokeColor).toBe("transparent");
  });

  it("pastes a style onto a hole group without painting the outlines or keyhole bridges", () => {
    const result = booleanShapes(
      [rectangle(), rectangle(50, 50, 50, 50)],
      "difference",
    );
    if (!result.ok) {
      throw new Error("Missing geometry");
    }
    const style = {
      ...rectangle(300, 0),
      strokeColor: "#123456",
      backgroundColor: "#abcdef",
      roughness: 0,
    };
    API.setElements([style, ...result.elements]);
    API.setSelectedElements([style]);
    API.executeAction(actionCopyStyles);
    API.setSelectedElements(result.elements);
    API.executeAction(actionPasteStyles);
    const paint = h.elements.find(({ id }) => id === result.elements[0].id)!;
    expect(paint).toMatchObject({
      strokeColor: "transparent",
      backgroundColor: "#abcdef",
      roundness: null,
    });
    expect(
      h.elements
        .filter((element) =>
          result.elements.slice(1).some(({ id }) => id === element.id),
        )
        .every(
          (element) =>
            element.backgroundColor === "transparent" &&
            element.strokeColor === "#123456",
        ),
    ).toBe(true);
  });

  it("reviews SVG limitations before importing supported parts", () => {
    const convert = vi.spyOn(editableSvgData, "importEditableSvg");
    API.setAppState({ openDialog: { name: "editableSvg" } });
    fireEvent.change(screen.getByLabelText("SVG source"), {
      target: {
        value: svg('<rect width="40" height="40"/><text>unsupported</text>'),
      },
    });
    const button = screen.getByRole("button", { name: "Import elements" });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review conversion" }));
    expect(screen.getByRole("status").textContent).toContain(
      "1 editable elements",
    );
    expect(screen.getByRole("status").textContent).toContain("Skipped <text>");
    expect(button).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Import the supported parts with these limitations.",
      }),
    );
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(h.elements.filter((element) => !element.isDeleted)).toHaveLength(1);
    expect(h.state.openDialog).toBeNull();
    expect(convert).toHaveBeenCalledTimes(1);
    convert.mockRestore();
  });

  it("imports SVG with one undo step without replacing the scene", () => {
    const original = rectangle();
    API.updateScene({
      elements: [original],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    act(() =>
      h.app.actionManager.executeAction(
        actionImportEditableSvg,
        "ui",
        svg('<rect width="100" height="100" fill="red"/>'),
      ),
    );
    expect(h.elements.filter((element) => !element.isDeleted)).toHaveLength(2);
    Keyboard.undo();
    expect(
      h.elements.filter((element) => !element.isDeleted).map(({ id }) => id),
    ).toEqual([original.id]);
    Keyboard.redo();
    expect(h.elements.filter((element) => !element.isDeleted)).toHaveLength(2);
  });
});

it("makes cutting accessible from the phone actions", async () => {
  await render(<Excalidraw UIOptions={{ getFormFactor: () => "phone" }} />);
  fireEvent.resize(window);
  await waitFor(() => expect(h.app.editorInterface.formFactor).toBe("phone"));
  const a = rectangle();
  const b = rectangle(100, 100);
  API.setElements([a, b]);
  API.setSelectedElements([a, b]);
  expect(
    screen.getByRole("button", { name: "Cut at intersections" }),
  ).toBeTruthy();
});

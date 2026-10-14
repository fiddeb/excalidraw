import fs from "fs";

import { arrayToMap } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/element";
import { pointFrom, pointDistance } from "@excalidraw/math";

import { isBindableElement } from "@excalidraw/element/typeChecks";

import { getHoveredElementForBinding } from "@excalidraw/element/collision";
import { getNearestContourBindingPoint } from "@excalidraw/element/contourBinding";
import {
  bindBindingElement,
  getGlobalFixedPointForBindableElement,
  getBindingGap,
  updateBoundElements,
} from "@excalidraw/element/binding";
import { LinearElementEditor } from "@excalidraw/element/linearElementEditor";
import { createPolygonElements } from "@excalidraw/element/polygonContours";

import type { GlobalPoint, LocalPoint, Radians } from "@excalidraw/math";

import type {
  ExcalidrawArrowElement,
  NonDeleted,
  ExcalidrawLineElement,
} from "@excalidraw/element/types";

import { Excalidraw } from "../index";
import { restoreElements } from "../data/restore";
import { exportToDrawio } from "../data/drawio";

import { API } from "./helpers/api";
import { Pointer, UI, Keyboard } from "./helpers/ui";
import { render, act, waitFor } from "./test-utils";

const { h } = window;
const mouse = new Pointer("mouse");
const pts = (...points: [number, number][]) =>
  points.map(([x, y]) => pointFrom<LocalPoint>(x, y));
const shape = () =>
  API.createElement({
    type: "line",
    x: 200,
    y: 100,
    points: pts(
      [0, 0],
      [140, 0],
      [140, 50],
      [70, 50],
      [70, 140],
      [0, 140],
      [0, 0],
    ),
    polygon: true,
    backgroundColor: "#a5d8ff",
    fillStyle: "solid",
    roughness: 0,
  }) as NonDeleted<ExcalidrawLineElement>;
const endpoint = (arrow: NonDeleted<ExcalidrawArrowElement>) =>
  LinearElementEditor.getPointAtIndexGlobalCoordinates(
    arrow,
    -1,
    h.app.scene.getNonDeletedElementsMap(),
  );
const bind = (contour: NonDeleted<ExcalidrawLineElement>, elbowed = false) => {
  const arrow = API.createElement({
    type: "arrow",
    x: 450,
    y: 125,
    points: pts([0, 0], [-104, 0]),
    elbowed,
  }) as NonDeleted<ExcalidrawArrowElement>;
  API.setElements([contour, arrow]);
  act(() =>
    bindBindingElement(
      arrow,
      contour,
      "orbit",
      "end",
      h.app.scene,
      h.state.zoom,
    ),
  );
  return arrow;
};

describe("automatic contour binding", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally />);
  });
  it("only accepts explicitly closed contours, not open lines, freehand or arrows", () => {
    expect(isBindableElement(shape())).toBe(true);
    expect(
      isBindableElement(
        API.createElement({
          type: "line",
          points: pts([0, 0], [100, 0], [0, 100], [0, 0]),
          polygon: false,
        }),
      ),
    ).toBe(true);
    expect(
      isBindableElement(
        API.createElement({
          type: "line",
          points: pts([0, 0], [100, 0], [0, 100]),
        }),
      ),
    ).toBe(false);
    expect(
      isBindableElement(
        API.createElement({
          type: "arrow",
          points: pts([0, 0], [100, 0], [0, 100], [0, 0]),
        }),
      ),
    ).toBe(false);
  });
  it("draws an arrow that automatically attaches to the actual concave contour", async () => {
    const contour = shape();
    API.setElements([contour]);
    UI.clickTool("arrow");
    mouse.downAt(450, 125);
    mouse.moveTo(345, 125);
    mouse.upAt();
    await waitFor(() => {
      const arrow = h.elements.find(
        (element): element is NonDeleted<ExcalidrawArrowElement> =>
          element.type === "arrow",
      )!;
      expect(arrow.endBinding?.elementId).toBe(contour.id);
      expect(contour.boundElements).toContainEqual({
        id: arrow.id,
        type: "arrow",
      });
      const end = endpoint(arrow);
      expect(
        pointDistance(
          end,
          getNearestContourBindingPoint(
            contour,
            h.app.scene.getNonDeletedElementsMap(),
            end,
          ),
        ),
      ).toBeLessThanOrEqual(getBindingGap(contour) + 1);
    });
  });
  it("does not attach to an empty concavity inside the bounding box", () => {
    API.setElements([shape()]);
    const hit = getHoveredElementForBinding(
      pointFrom<GlobalPoint>(320, 210),
      h.app.scene.getNonDeletedElements(),
      h.app.scene.getNonDeletedElementsMap(),
      h.state.zoom,
    );
    expect(hit).toBeNull();
  });
  it.each([false, true])(
    "elbowed=%s follows translation, rotation and scaling",
    (elbowed) => {
      const contour = shape();
      const arrow = bind(contour, elbowed);
      expect(arrow.endBinding?.elementId).toBe(contour.id);
      for (const change of [
        { x: 250, y: 160 },
        { angle: (Math.PI / 3) as Radians },
        {
          points: contour.points.map(([x, y]) =>
            pointFrom<LocalPoint>(x * 1.5, y * 0.8),
          ),
        },
      ]) {
        act(() => {
          h.app.scene.mutateElement(contour, change);
          updateBoundElements(contour, h.app.scene);
        });
        const end = endpoint(arrow);
        const anchor = getGlobalFixedPointForBindableElement(
          arrow.endBinding!.fixedPoint,
          contour,
          h.app.scene.getNonDeletedElementsMap(),
        );
        expect(
          pointDistance(
            anchor,
            getNearestContourBindingPoint(
              contour,
              h.app.scene.getNonDeletedElementsMap(),
              anchor,
            ),
          ),
        ).toBeLessThan(0.01);
        expect(pointDistance(end, anchor)).toBeLessThanOrEqual(
          getBindingGap(contour) + 0.1,
        );
        expect(arrow.endBinding?.elementId).toBe(contour.id);
        if (elbowed) {
          for (let i = 1; i < arrow.points.length; i++) {
            const [a, b] = [arrow.points[i - 1], arrow.points[i]];
            expect(
              Math.min(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])),
            ).toBeLessThan(0.01);
          }
        }
      }
    },
  );
  it("updates attached arrows after point editing, and detaches when the loop opens", () => {
    const contour = { ...shape(), polygon: false };
    const arrow = bind(contour);
    const before = endpoint(arrow);
    act(() =>
      LinearElementEditor.movePoints(
        contour,
        h.app.scene,
        new Map([[1, { point: pointFrom<LocalPoint>(180, 0) }]]),
      ),
    );
    const after = endpoint(arrow);
    expect(pointDistance(before, after)).toBeGreaterThan(1);
    expect(arrow.endBinding?.elementId).toBe(contour.id);
    act(() =>
      LinearElementEditor.movePoints(
        contour,
        h.app.scene,
        new Map([
          [contour.points.length - 1, { point: pointFrom<LocalPoint>(20, 20) }],
        ]),
      ),
    );
    expect(arrow.endBinding).toBeNull();
    expect(contour.boundElements || []).toHaveLength(0);
  });
  it("moves attached arrows through the normal selection keyboard interaction", () => {
    const contour = shape();
    const arrow = bind(contour);
    act(() => updateBoundElements(contour, h.app.scene));
    const before = endpoint(arrow);
    API.setSelectedElements([contour]);
    Keyboard.keyPress("ArrowRight");
    const after = endpoint(arrow);
    expect(after[0]).toBeGreaterThan(before[0]);
    expect(arrow.endBinding?.elementId).toBe(contour.id);
  });
  it("respects opaque contour fills but allows binding through transparent holes", () => {
    const behind = API.createElement({
      type: "rectangle",
      x: 210,
      y: 110,
      width: 110,
      height: 110,
    });
    const front = API.createElement({
      type: "line",
      x: 200,
      y: 100,
      points: pts([0, 0], [140, 0], [140, 140], [0, 140], [0, 0]),
      polygon: true,
      backgroundColor: "#ff0000",
    });
    API.setElements([behind, front]);
    expect(
      getHoveredElementForBinding(
        pointFrom<GlobalPoint>(265, 165),
        h.app.scene.getNonDeletedElements(),
        h.app.scene.getNonDeletedElementsMap(),
        h.state.zoom,
      ),
    ).toBeNull();
  });
  it("anchors correctly when a contour's local points have negative coordinates", () => {
    const contour = API.createElement({
      type: "line",
      x: 300,
      y: 200,
      points: pts([0, 0], [-100, 0], [-100, -100], [0, -100], [0, 0]),
      polygon: true,
    }) as NonDeleted<ExcalidrawLineElement>;
    const arrow = bind(contour);
    const map = h.app.scene.getNonDeletedElementsMap();
    const anchor = getGlobalFixedPointForBindableElement(
      arrow.endBinding!.fixedPoint,
      contour,
      map,
    );
    expect(
      pointDistance(
        anchor,
        getNearestContourBindingPoint(contour, map, anchor),
      ),
    ).toBeLessThan(0.01);
  });
  it("binds outer and hole edges, but not the hole center or doubled bridges", () => {
    const parts = createPolygonElements(
      API.createElement({
        type: "rectangle",
        backgroundColor: "#ff0000",
        fillStyle: "solid",
      }),
      [
        [
          [
            [0, 0],
            [300, 0],
            [300, 300],
            [0, 300],
            [0, 0],
          ],
          [
            [100, 100],
            [100, 200],
            [200, 200],
            [200, 100],
            [100, 100],
          ],
        ],
      ],
    );
    fs.writeFileSync(
      "/private/tmp/contour-binding-clipboard.json",
      JSON.stringify({
        type: "excalidraw/clipboard",
        elements: [{ ...shape(), x: 400, y: 50 }, ...parts],
        files: {},
      }),
    );
    API.setElements(parts);
    const scene = h.app.scene;
    const hit = (x: number, y: number) =>
      getHoveredElementForBinding(
        pointFrom<GlobalPoint>(x, y),
        scene.getNonDeletedElements(),
        scene.getNonDeletedElementsMap(),
        h.state.zoom,
      );
    expect(hit(305, 150)).not.toBeNull();
    expect(hit(105, 150)).not.toBeNull();
    expect(hit(150, 150)).toBeNull();
    // Fill carrier alone must not offer its invisible keyhole bridge.
    API.setElements([parts[0]]);
    const segments = getNearestContourBindingPoint(
      parts[0],
      scene.getNonDeletedElementsMap(),
      pointFrom<GlobalPoint>(50, 50),
    );
    expect(
      pointDistance(segments, pointFrom<GlobalPoint>(50, 50)),
    ).toBeGreaterThan(15);
  });
  it("preserves bindings through save/restore and exports a draw.io connector terminal", () => {
    const contour = shape();
    const arrow = bind(contour);
    act(() => updateBoundElements(contour, h.app.scene));
    fs.writeFileSync(
      "/private/tmp/contour-binding-connected.json",
      JSON.stringify({
        type: "excalidraw/clipboard",
        elements: h.elements,
        files: {},
      }),
    );
    const restored = restoreElements(
      JSON.parse(JSON.stringify(h.elements)),
      null,
      { repairBindings: true },
    );
    const target = restored.find((el) => el.id === contour.id)!;
    const connection = restored.find(
      (el) => el.id === arrow.id,
    ) as ExcalidrawArrowElement;
    expect(connection.endBinding?.elementId).toBe(target.id);
    expect(target.boundElements).toContainEqual({
      id: arrow.id,
      type: "arrow",
    });
    const result = exportToDrawio(
      restored,
      {},
      { name: "Contour", encodeBase64: (value) => window.btoa(value) },
    );
    const document = new DOMParser().parseFromString(
      result.xml,
      "application/xml",
    );
    expect(
      document.querySelector('mxCell[edge="1"]')?.getAttribute("target"),
    ).toBe("e0");
  });
  it("exports rotated custom-shape attachment coordinates into the stencil's bounds", () => {
    const contour = { ...shape(), angle: (Math.PI / 3) as Radians };
    const arrow = bind(contour);
    const result = exportToDrawio(
      h.elements,
      {},
      { name: "Rotation", encodeBase64: (value) => window.btoa(value) },
    );
    const document = new DOMParser().parseFromString(
      result.xml,
      "application/xml",
    );
    const geometry = document.querySelector('mxCell[id="e0"] mxGeometry')!;
    const style = document
      .querySelector('mxCell[edge="1"]')!
      .getAttribute("style")!;
    const ratioX = Number(style.match(/entryX=([^;]+)/)![1]);
    const ratioY = Number(style.match(/entryY=([^;]+)/)![1]);
    const anchor = getGlobalFixedPointForBindableElement(
      arrow.endBinding!.fixedPoint,
      contour,
      h.app.scene.getNonDeletedElementsMap(),
    );
    // The exporter translates all geometry by the same origin. Compare relative
    // positions against the stencil's actual global bounds.
    const bounds = LinearElementEditor.getPointsGlobalCoordinates(
      contour,
      h.app.scene.getNonDeletedElementsMap(),
    );
    const minX = Math.min(...bounds.map(([x]) => x));
    const minY = Math.min(...bounds.map(([, y]) => y));
    expect(minX + Number(geometry.getAttribute("width")) * ratioX).toBeCloseTo(
      anchor[0],
      0,
    );
    expect(minY + Number(geometry.getAttribute("height")) * ratioY).toBeCloseTo(
      anchor[1],
      0,
    );
  });
  it("keeps bindings during duplication and detaches on deleting the contour", async () => {
    const contour = shape();
    const arrow = bind(contour);
    API.setSelectedElements([contour, arrow]);
    Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.keyPress("d"));
    await waitFor(() => expect(h.elements).toHaveLength(4));
    const copies = h.elements.filter(
      (element) => element.id !== contour.id && element.id !== arrow.id,
    );
    const copyShape = copies.find((element) => element.type === "line")!;
    const copyArrow = copies.find(
      (element) => element.type === "arrow",
    ) as ExcalidrawArrowElement;
    expect(copyArrow.endBinding?.elementId).toBe(copyShape.id);
    API.setSelectedElements([contour]);
    Keyboard.keyPress("Delete");
    await waitFor(() => expect(arrow.endBinding).toBeNull());
    expect(CaptureUpdateAction.IMMEDIATELY).toBeDefined();
    expect(arrayToMap(copies).size).toBe(2);
  });
});

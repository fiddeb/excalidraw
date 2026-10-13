import polygonClipping from "polygon-clipping";
import { orient2d } from "robust-predicates";

import {
  getSizeFromPoints,
  getUpdatedTimestamp,
  randomId,
} from "@excalidraw/common";
import {
  pointFrom,
  pointRotateRads,
  polygonSignedArea,
} from "@excalidraw/math";

import type { GlobalPoint, LocalPoint, Radians } from "@excalidraw/math";

import { getBoundsFromPoints } from "./bounds";
import { newLinearElement } from "./newElement";
import { canConvertShapeToLine, getShapeOutlinePoints } from "./shapeToLine";
import { isLineElement, isValidPolygon } from "./typeChecks";

import type { Polygon } from "polygon-clipping";

import type {
  ExcalidrawElement,
  ExcalidrawLineElement,
  NonDeleted,
} from "./types";

type BooleanShape =
  | Extract<ExcalidrawElement, { type: "rectangle" | "ellipse" | "diamond" }>
  | ExcalidrawLineElement;

export const isBooleanShape = <T extends ExcalidrawElement>(
  element: T,
): element is T & BooleanShape =>
  [element.x, element.y, element.angle, element.width, element.height].every(
    Number.isFinite,
  ) &&
  (canConvertShapeToLine(element) ||
    (isLineElement(element) &&
      !element.locked &&
      !element.isDeleted &&
      element.polygon &&
      isValidPolygon(element.points) &&
      !element.roundness &&
      !element.boundElements?.length &&
      !element.startArrowhead &&
      !element.endArrowhead));

export const canBooleanShapes = (elements: readonly ExcalidrawElement[]) =>
  elements.length >= 2 &&
  elements.every(isBooleanShape) &&
  elements.every((element) => element.frameId === elements[0].frameId);

// Retain the existing union API for callers. All four operations share inputs.
export const canUnionShapes = canBooleanShapes;

export type BooleanShapeOperation =
  | "union"
  | "intersection"
  | "difference"
  | "xor";

const MAX_POINTS = 5000;

/** Ideal contours, without roughjs jitter or zoom-dependent sampling. */
export const getBooleanShapePoints = (element: BooleanShape): GlobalPoint[] => {
  if (element.type !== "line") {
    return getShapeOutlinePoints(element);
  }
  const [minX, minY, maxX, maxY] = getBoundsFromPoints(element.points);
  const center = pointFrom<LocalPoint>((minX + maxX) / 2, (minY + maxY) / 2);
  return element.points.map((point) => {
    const rotated = pointRotateRads(point, center, element.angle);
    return pointFrom<GlobalPoint>(
      element.x + rotated[0],
      element.y + rotated[1],
    );
  });
};

const samePoint = (a: GlobalPoint, b: GlobalPoint) =>
  a[0] === b[0] && a[1] === b[1];
const orientation = (a: GlobalPoint, b: GlobalPoint, c: GlobalPoint) =>
  Math.sign(orient2d(a[0], a[1], b[0], b[1], c[0], c[1]));
const onSegment = (point: GlobalPoint, a: GlobalPoint, b: GlobalPoint) =>
  orientation(a, b, point) === 0 &&
  point[0] >= Math.min(a[0], b[0]) &&
  point[0] <= Math.max(a[0], b[0]) &&
  point[1] >= Math.min(a[1], b[1]) &&
  point[1] <= Math.max(a[1], b[1]);
const segmentsTouch = (
  a: GlobalPoint,
  b: GlobalPoint,
  c: GlobalPoint,
  d: GlobalPoint,
) => {
  if (
    Math.max(a[0], b[0]) < Math.min(c[0], d[0]) ||
    Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
    Math.max(a[1], b[1]) < Math.min(c[1], d[1]) ||
    Math.max(c[1], d[1]) < Math.min(a[1], b[1])
  ) {
    return false;
  }
  return (
    onSegment(a, c, d) ||
    onSegment(b, c, d) ||
    onSegment(c, a, b) ||
    onSegment(d, a, b) ||
    (orientation(a, b, c) !== orientation(a, b, d) &&
      orientation(c, d, a) !== orientation(c, d, b))
  );
};

/** Native fills use even-odd, while polygon-clipping accepts crossing rings
 * under nonzero winding. Reject crossings, retraced edges and keyhole bridges
 * instead of silently changing the interpreted area of those inputs.
 */
export const isSimpleBooleanRing = (points: readonly GlobalPoint[]) => {
  const ring = points.filter(
    (point, i) => i === 0 || !samePoint(point, points[i - 1]),
  );
  if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) {
    ring.pop();
  }
  if (
    ring.length < 3 ||
    !ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  ) {
    return false;
  }
  // Translate before summing area to avoid cancellation far from the origin.
  if (
    polygonSignedArea(
      ring.map(([x, y]) =>
        pointFrom<GlobalPoint>(x - ring[0][0], y - ring[0][1]),
      ),
      0,
    ) === 0
  ) {
    return false;
  }
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const c = ring[(i + 2) % ring.length];
    if (
      orientation(a, b, c) === 0 &&
      (onSegment(a, b, c) || onSegment(c, a, b))
    ) {
      return false;
    }
    for (let j = i + 2; j < ring.length; j++) {
      if (i === 0 && j === ring.length - 1) {
        continue;
      }
      if (segmentsTouch(a, b, ring[j], ring[(j + 1) % ring.length])) {
        return false;
      }
    }
  }
  return true;
};

export type ShapeBooleanResult =
  | { ok: true; elements: NonDeleted<ExcalidrawLineElement>[] }
  | {
      ok: false;
      reason: "invalid" | "holes" | "tooComplex" | "empty" | "failed";
    };

/** Inputs are in scene/layer order. Difference subtracts every later input
 * from the bottommost input and keeps that base's style and group hierarchy.
 * The other operations use the topmost style and shared outer groups.
 */
export const booleanShapes = (
  elements: readonly ExcalidrawElement[],
  operation: BooleanShapeOperation,
): ShapeBooleanResult => {
  if (!canBooleanShapes(elements) || !elements.every(isBooleanShape)) {
    return { ok: false, reason: "invalid" };
  }
  // Preflight before sampling very large ellipses or quadratic validation.
  if (
    elements.length > 100 ||
    elements.some(
      (element) =>
        Math.max(element.width, element.height) > 1e6 ||
        (isLineElement(element) && element.points.length > MAX_POINTS),
    )
  ) {
    return { ok: false, reason: "tooComplex" };
  }
  const rings = elements.map(getBooleanShapePoints);
  if (rings.reduce((count, ring) => count + ring.length, 0) > MAX_POINTS) {
    return { ok: false, reason: "tooComplex" };
  }
  if (!rings.every(isSimpleBooleanRing)) {
    return { ok: false, reason: "invalid" };
  }
  const polygons: Polygon[] = rings.map((ring) => [
    ring.map(([x, y]) => [x, y]),
  ]);
  let result: ReturnType<typeof polygonClipping.union>;
  try {
    result = polygonClipping[operation](polygons[0], ...polygons.slice(1));
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (!result.length && operation === "union") {
    return { ok: false, reason: "empty" };
  }
  if (result.some((polygon) => polygon.length > 1)) {
    return { ok: false, reason: "holes" };
  }
  if (
    result.reduce((count, polygon) => count + polygon[0].length, 0) > MAX_POINTS
  ) {
    return { ok: false, reason: "tooComplex" };
  }
  const source =
    operation === "difference" ? elements[0] : elements[elements.length - 1];
  // Groups are innermost first: preserve only the shared outer hierarchy.
  const groupIds: string[] = [];
  for (let i = source.groupIds.length - 1; i >= 0; i--) {
    const offset = source.groupIds.length - i;
    if (
      !elements.every(
        (element) =>
          element.groupIds[element.groupIds.length - offset] ===
          source.groupIds[i],
      )
    ) {
      break;
    }
    groupIds.unshift(source.groupIds[i]);
  }
  const lines = result.map(([ring]) => {
    const origin = ring[0];
    const points = ring.map(([x, y]) =>
      pointFrom<LocalPoint>(x - origin[0], y - origin[1]),
    );
    const line = newLinearElement({
      ...source,
      type: "line",
      x: origin[0],
      y: origin[1],
      ...getSizeFromPoints(points),
      angle: 0 as Radians,
      points,
      polygon: true,
      roundness: null,
      groupIds: operation === "difference" ? [...source.groupIds] : groupIds,
      boundElements: null,
      customData: undefined,
      index: null,
      version: 1,
      versionNonce: 0,
      created: getUpdatedTimestamp(),
    });
    return { ...line, id: randomId(), type: "line" as const, polygon: true };
  });
  return { ok: true, elements: lines };
};

export type ShapeUnionResult = ShapeBooleanResult;
export const unionShapes = (elements: readonly ExcalidrawElement[]) =>
  booleanShapes(elements, "union");
export const intersectionShapes = (elements: readonly ExcalidrawElement[]) =>
  booleanShapes(elements, "intersection");
export const differenceShapes = (elements: readonly ExcalidrawElement[]) =>
  booleanShapes(elements, "difference");
export const xorShapes = (elements: readonly ExcalidrawElement[]) =>
  booleanShapes(elements, "xor");

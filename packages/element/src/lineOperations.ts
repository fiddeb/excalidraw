import { pointsOnBezierCurves } from "points-on-curve";

import {
  getSizeFromPoints,
  getUpdatedTimestamp,
  randomId,
} from "@excalidraw/common";
import { pointFrom, pointDistance, pointsEqual } from "@excalidraw/math";

import type { GlobalPoint, LocalPoint, Radians } from "@excalidraw/math";

import { LinearElementEditor } from "./linearElementEditor";
import { newLinearElement } from "./newElement";
import { generateLinearCollisionShape } from "./shape";
import { isLineElement, isValidPolygon } from "./typeChecks";

import type {
  ElementsMap,
  ExcalidrawElement,
  ExcalidrawLineElement,
} from "./types";

export const isEditableOpenLine = <T extends ExcalidrawElement>(
  element: T,
): element is T & ExcalidrawLineElement =>
  isLineElement(element) &&
  !element.locked &&
  !element.isDeleted &&
  !element.polygon &&
  element.points.length >= 2 &&
  !pointsEqual(element.points[0], element.points[element.points.length - 1]);

export const canJoinLines = (elements: readonly ExcalidrawElement[]) =>
  elements.length >= 2 &&
  elements.every(isEditableOpenLine) &&
  elements.every((element) => element.frameId === elements[0].frameId);

export const MAX_JOIN_LINES = 256;
export const MAX_JOIN_POINTS = 10_000;

export class LineJoinError extends Error {
  constructor(public readonly reason: "tooComplex" | "invalidGeometry") {
    super(`Cannot join lines: ${reason}`);
  }
}

export const canCloseLine = <T extends ExcalidrawElement>(
  element: T,
): element is T & ExcalidrawLineElement =>
  isEditableOpenLine(element) && element.points.length >= 3;

/** Flatten curves without roughness jitter, preserving their scene positions. */
export const getLineOperationPoints = (
  element: ExcalidrawLineElement,
  elementsMap: ElementsMap,
  maxPoints = Infinity,
): GlobalPoint[] => {
  if (!element.roundness || element.points.length < 3) {
    return LinearElementEditor.getPointsGlobalCoordinates(element, elementsMap);
  }
  const points: GlobalPoint[] = [];
  for (const { op, data } of generateLinearCollisionShape(
    element,
    elementsMap,
  )) {
    const toGlobal = (offset: number) =>
      pointFrom<GlobalPoint>(
        element.x + data[offset],
        element.y + data[offset + 1],
      );
    if (op === "move" || op === "lineTo") {
      points.push(toGlobal(0));
    } else if (op === "bcurveTo" && points.length) {
      const curve = [
        points[points.length - 1],
        toGlobal(0),
        toGlobal(2),
        toGlobal(4),
      ];
      if (curve.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
        throw new LineJoinError("invalidGeometry");
      }
      const sampled = pointsOnBezierCurves(curve, 0.5, 0.75) as GlobalPoint[];
      if (points.length + sampled.length - 1 > maxPoints) {
        throw new LineJoinError("tooComplex");
      }
      for (let i = 1; i < sampled.length; i++) {
        points.push(sampled[i]);
      }
    }
    if (points.length > maxPoints) {
      throw new LineJoinError("tooComplex");
    }
  }
  return points;
};

const makeLine = (
  source: ExcalidrawLineElement,
  globalPoints: readonly GlobalPoint[],
) => {
  const origin = globalPoints[0];
  const points = globalPoints.map(([x, y]) =>
    pointFrom<LocalPoint>(x - origin[0], y - origin[1]),
  );
  return newLinearElement({
    ...source,
    x: origin[0],
    y: origin[1],
    ...getSizeFromPoints(points),
    angle: 0 as Radians,
    roundness: null,
    points,
    polygon: isValidPolygon(points),
  });
};

export const closeLine = (
  element: ExcalidrawLineElement,
  elementsMap: ElementsMap,
) => {
  const points = getLineOperationPoints(element, elementsMap);
  return makeLine(element, [...points, points[0]]);
};

/** Extend either end of a chain, reversing inputs when their end is nearer. */
export const joinLines = (
  elements: readonly ExcalidrawLineElement[],
  elementsMap: ElementsMap,
) => {
  if (
    elements.length > MAX_JOIN_LINES ||
    elements.reduce((count, element) => count + element.points.length, 0) >
      MAX_JOIN_POINTS
  ) {
    throw new LineJoinError("tooComplex");
  }
  if (
    elements.length < 2 ||
    elements.some(
      (element) =>
        ![element.x, element.y, element.angle].every(Number.isFinite) ||
        element.points.some(
          ([x, y]) => !Number.isFinite(x) || !Number.isFinite(y),
        ),
    )
  ) {
    throw new LineJoinError("invalidGeometry");
  }
  let pointCount = 0;
  const remaining = elements.map((element) => {
    const points = getLineOperationPoints(
      {
        ...element,
        points: element.points.map(([x, y]) => pointFrom<LocalPoint>(x, y)),
      },
      elementsMap,
      MAX_JOIN_POINTS - pointCount,
    );
    if (
      points.length < 2 ||
      points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))
    ) {
      throw new LineJoinError("invalidGeometry");
    }
    pointCount += points.length;
    if (pointCount > MAX_JOIN_POINTS) {
      throw new LineJoinError("tooComplex");
    }
    return points;
  });
  let points = remaining.shift()!;
  while (remaining.length) {
    let best = { index: 0, prepend: false, reverse: false, distance: Infinity };
    for (const [index, candidate] of remaining.entries()) {
      for (const prepend of [false, true]) {
        for (const reverse of [false, true]) {
          const from = prepend ? points[0] : points[points.length - 1];
          const to = candidate[prepend !== reverse ? candidate.length - 1 : 0];
          const distance = pointDistance(from, to);
          if (distance < best.distance) {
            best = { index, prepend, reverse, distance };
          }
        }
      }
    }
    let candidate = remaining.splice(best.index, 1)[0];
    if (best.reverse) {
      candidate = [...candidate].reverse();
    }
    const left = best.prepend ? candidate : points;
    const right = best.prepend ? points : candidate;
    // Only merge coincident endpoints. A gap becomes an explicit segment.
    points = [
      ...left,
      ...(pointsEqual(left[left.length - 1], right[0])
        ? right.slice(1)
        : right),
    ];
  }
  const source = elements[elements.length - 1];
  const line = makeLine(source, points);
  // Groups are stored innermost first. Keep only the shared outer hierarchy.
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
  return {
    ...line,
    id: randomId(),
    groupIds,
    version: 1,
    versionNonce: 0,
    created: getUpdatedTimestamp(),
    backgroundColor: isValidPolygon(line.points)
      ? source.backgroundColor
      : "transparent",
  };
};

export const canReduceLinePoints = <T extends ExcalidrawElement>(
  element: T,
): element is T & ExcalidrawLineElement => {
  if (
    !isLineElement(element) ||
    element.locked ||
    element.isDeleted ||
    element.roundness ||
    element.points.length < 3
  ) {
    return false;
  }
  const closed = pointsEqual(
    element.points[0],
    element.points[element.points.length - 1],
  );
  return element.points.length > (closed ? 4 : 2);
};

/** Remove the least significant bends first, about a quarter per invocation.
 * Work in scene coordinates so normalization cannot move rotated contours.
 * Keep both endpoints (including the duplicated closing point) fixed.
 */
export const reduceLinePoints = (
  element: ExcalidrawLineElement,
  elementsMap: ElementsMap,
) => {
  // roughjs can normalize polygon coordinates while computing bounds. Give
  // that path a private copy so undo retains the exact original point data.
  const points = getLineOperationPoints(
    {
      ...element,
      points: element.points.map(([x, y]) => pointFrom<LocalPoint>(x, y)),
    },
    elementsMap,
  );
  const closed = pointsEqual(points[0], points[points.length - 1]);
  const minimum = closed ? 4 : 2;
  const target = Math.max(
    minimum,
    points.length -
      Math.max(1, Math.floor((points.length - (closed ? 1 : 0)) / 4)),
  );
  while (points.length > target) {
    let bestIndex = 1;
    let bestError = Infinity;
    for (let i = 1; i < points.length - 1; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i + 1];
      const [px, py] = points[i];
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared
        ? Math.max(
            0,
            Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared),
          )
        : 0;
      const error = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      if (error < bestError) {
        bestError = error;
        bestIndex = i;
      }
    }
    points.splice(bestIndex, 1);
  }
  return {
    ...makeLine(element, points),
    type: "line" as const,
    polygon: closed,
  };
};

/** The duplicated closing point and point zero are the same cut location. */
export const getLineSplitIndices = (
  element: ExcalidrawLineElement,
  selectedPoints: readonly number[],
) => {
  const last = element.points.length - 1;
  const closed =
    last > 0 && pointsEqual(element.points[0], element.points[last]);
  return [
    ...new Set(
      selectedPoints
        .filter(
          (index) => Number.isInteger(index) && index >= 0 && index <= last,
        )
        .map((index) => (closed && index === last ? 0 : index))
        .filter((index) => closed || (index > 0 && index < last)),
    ),
  ].sort((a, b) => a - b);
};

export const canSplitLine = <T extends ExcalidrawElement>(
  element: T,
  selectedPoints: readonly number[],
): element is T & ExcalidrawLineElement =>
  isLineElement(element) &&
  !element.locked &&
  !element.isDeleted &&
  !element.roundness &&
  !element.boundElements?.length &&
  !element.startArrowhead &&
  !element.endArrowhead &&
  element.points.length >= 3 &&
  element.points.some((point) => !pointsEqual(point, element.points[0])) &&
  getLineSplitIndices(element, selectedPoints).length > 0;

/** Cut at existing vertices without losing edges or adding closing chords.
 * A single cut on a loop yields independent endpoints at the same position;
 * polygon=false lets the native point editor move them separately.
 */
export const splitLine = (
  element: ExcalidrawLineElement,
  selectedPoints: readonly number[],
  elementsMap: ElementsMap,
) => {
  if (!canSplitLine(element, selectedPoints)) {
    return [];
  }
  const indices = getLineSplitIndices(element, selectedPoints);
  const points = getLineOperationPoints(
    {
      ...element,
      points: element.points.map(([x, y]) => pointFrom<LocalPoint>(x, y)),
    },
    elementsMap,
  );
  const last = points.length - 1;
  const closed = pointsEqual(points[0], points[last]);
  const segments = closed
    ? indices.map((start, index) => {
        const end = indices[(index + 1) % indices.length];
        return end > start
          ? points.slice(start, end + 1)
          : [...points.slice(start, last), ...points.slice(0, end + 1)];
      })
    : [0, ...indices].map((start, index) =>
        points.slice(start, [...indices, last][index] + 1),
      );
  return segments
    .filter((segment) =>
      segment.some((point) => !pointsEqual(point, segment[0])),
    )
    .map((segment) => ({
      ...makeLine(element, segment),
      type: "line" as const,
      id: randomId(),
      polygon: false,
      // An open outline must not acquire an implicit filled closing chord.
      backgroundColor: "transparent",
      boundElements: null,
      version: 1,
      versionNonce: 0,
      created: getUpdatedTimestamp(),
    }));
};

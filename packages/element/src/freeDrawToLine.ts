import { simplify } from "points-on-curve";

import {
  getSizeFromPoints,
  getUpdatedTimestamp,
  randomId,
} from "@excalidraw/common";
import { pointFrom, pointRotateRads } from "@excalidraw/math";

import type { LocalPoint, Radians } from "@excalidraw/math";

import { getBoundsFromPoints } from "./bounds";
import { newLinearElement } from "./newElement";
import { isPathALoop } from "./utils";

import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from "./types";

export const canConvertFreeDrawToLine = <T extends ExcalidrawElement>(
  element: T,
): element is T & ExcalidrawFreeDrawElement =>
  element.type === "freedraw" &&
  !element.isDeleted &&
  !element.locked &&
  element.points.length > 1 &&
  element.points.some(
    (point) =>
      point[0] !== element.points[0][0] || point[1] !== element.points[0][1],
  );

/** Convert the centerline, not the pressure-sensitive stroke outline. */
export const freeDrawToLine = (element: ExcalidrawFreeDrawElement) => {
  // Use scene units so conversion is independent of the current zoom. Copy the
  // input because the simplifier accepts mutable arrays.
  const input = element.points.map(([x, y]) => [x, y] as [number, number]);
  let points = simplify(input, 0.75) as LocalPoint[];
  const closed = isPathALoop(element.points);

  // Don't collapse a small closed contour to a segment.
  if (closed && points.length < 4) {
    points = input as LocalPoint[];
  }
  if (closed) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      points = [...points, first];
    }
  }

  // Bake in rotation around the ORIGINAL bounds. Simplification can change
  // those bounds, and rotating around the new center would move the stroke.
  const [minX, minY, maxX, maxY] = getBoundsFromPoints(element.points);
  const center = pointFrom<LocalPoint>((minX + maxX) / 2, (minY + maxY) / 2);
  points = points.map((point) => pointRotateRads(point, center, element.angle));
  const origin = points[0];
  points = points.map(([x, y]) =>
    pointFrom<LocalPoint>(x - origin[0], y - origin[1]),
  );

  const line = newLinearElement({
    ...element,
    type: "line",
    x: element.x + origin[0],
    y: element.y + origin[1],
    ...getSizeFromPoints(points),
    angle: 0 as Radians,
    points,
    polygon: closed,
    roundness: null,
    roughness: 0,
    // Open strokes must not acquire a fill after simplification.
    backgroundColor: closed ? element.backgroundColor : "transparent",
    version: 1,
    versionNonce: 0,
    created: getUpdatedTimestamp(),
  });

  // A new identity lets undo restore the original stroke and its pressure data
  // without changing an existing element's type during collaboration.
  return { ...line, id: randomId() };
};

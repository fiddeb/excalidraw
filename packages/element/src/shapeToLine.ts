import { pointsOnBezierCurves } from "points-on-curve";

import {
  getSizeFromPoints,
  getUpdatedTimestamp,
  randomId,
} from "@excalidraw/common";
import { pointFrom, pointRotateRads } from "@excalidraw/math";

import type { GlobalPoint, LocalPoint, Radians } from "@excalidraw/math";

import { newLinearElement } from "./newElement";
import { getCornerRadius, getDiamondBaseCorners } from "./utils";

import type { ExcalidrawElement } from "./types";

type OutlineShape = Extract<
  ExcalidrawElement,
  { type: "rectangle" | "ellipse" | "diamond" }
>;

export const canConvertShapeToLine = <T extends ExcalidrawElement>(
  element: T,
): element is T & OutlineShape =>
  (element.type === "rectangle" ||
    element.type === "ellipse" ||
    element.type === "diamond") &&
  !element.isDeleted &&
  !element.locked &&
  Number.isFinite(element.width) &&
  Number.isFinite(element.height) &&
  element.width > 0 &&
  element.height > 0 &&
  // Lines cannot retain text-container or arrow-binding behavior. Reject these
  // shapes rather than leave dangling references or silently detach content.
  !element.boundElements?.length;

/** Ideal geometry, independent of roughjs jitter and the current zoom. */
export const getShapeOutlinePoints = (element: OutlineShape): GlobalPoint[] => {
  const { width: w, height: h } = element;
  const p = (x: number, y: number) => pointFrom<LocalPoint>(x, y);
  let points: LocalPoint[];
  if (element.type === "ellipse") {
    // Sagitta <= 0.75 scene units, using the larger radius as a conservative
    // bound for eccentric ellipses. Multiples of four retain the cardinal points.
    const radius = Math.max(w, h) / 2;
    const count = Math.max(
      12,
      Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.75 / radius)) / 4) * 4,
    );
    points = Array.from({ length: count }, (_, i) => {
      const angle = (i * 2 * Math.PI) / count;
      return p(
        w / 2 + (w / 2) * Math.cos(angle),
        h / 2 + (h / 2) * Math.sin(angle),
      );
    });
  } else if (element.type === "diamond") {
    points = element.roundness
      ? getDiamondBaseCorners(element).flatMap((curve) =>
          (pointsOnBezierCurves(curve, 0.5, 0.75) as GlobalPoint[]).map(
            ([x, y]) => p(x - element.x, y - element.y),
          ),
        )
      : [p(w / 2, 0), p(w, h / 2), p(w / 2, h), p(0, h / 2)];
  } else {
    const r = getCornerRadius(Math.min(w, h), element);
    if (!r) {
      points = [p(0, 0), p(w, 0), p(w, h), p(0, h)];
    } else {
      const corners = [
        [p(w - r, 0), p(w, 0), p(w, r)],
        [p(w, h - r), p(w, h), p(w - r, h)],
        [p(r, h), p(0, h), p(0, h - r)],
        [p(0, r), p(0, 0), p(r, 0)],
      ];
      points = corners.flatMap(
        ([start, control, end]) =>
          pointsOnBezierCurves(
            [
              start,
              p(
                start[0] + (2 / 3) * (control[0] - start[0]),
                start[1] + (2 / 3) * (control[1] - start[1]),
              ),
              p(
                end[0] + (2 / 3) * (control[0] - end[0]),
                end[1] + (2 / 3) * (control[1] - end[1]),
              ),
              end,
            ],
            0.5,
            0.75,
          ) as LocalPoint[],
      );
    }
  }
  points.push(points[0]);
  const center = p(w / 2, h / 2);
  return points.map((point) => {
    const rotated = pointRotateRads(point, center, element.angle);
    return pointFrom<GlobalPoint>(
      element.x + rotated[0],
      element.y + rotated[1],
    );
  });
};

export const shapeToLine = (element: OutlineShape) => {
  const globalPoints = getShapeOutlinePoints(element);
  const origin = globalPoints[0];
  const points = globalPoints.map(([x, y]) =>
    pointFrom<LocalPoint>(x - origin[0], y - origin[1]),
  );
  const line = newLinearElement({
    ...element,
    type: "line",
    x: origin[0],
    y: origin[1],
    ...getSizeFromPoints(points),
    angle: 0 as Radians,
    points,
    polygon: true,
    roundness: null,
    boundElements: null,
    version: 1,
    versionNonce: 0,
    created: getUpdatedTimestamp(),
  });
  return { ...line, id: randomId() };
};

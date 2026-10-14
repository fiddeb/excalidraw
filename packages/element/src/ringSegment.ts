import {
  getSizeFromPoints,
  getUpdatedTimestamp,
  randomId,
} from "@excalidraw/common";
import { pointFrom, pointRotateRads } from "@excalidraw/math";

import type { LocalPoint, Radians, GlobalPoint } from "@excalidraw/math";

import {
  createPolygonElements,
  splitKeyholeContours,
  contoursToEvenOddPolygons,
} from "./polygonContours";

import { newLinearElement } from "./newElement";

import type { ExcalidrawElement, ExcalidrawEllipseElement } from "./types";

export type RingSegmentOptions = {
  outerRadius: number;
  innerRadius: number;
  startAngle: number;
  endAngle: number;
};

export const isValidRingSegment = (options: RingSegmentOptions) => {
  const { outerRadius, innerRadius, startAngle, endAngle } = options;
  const sweep = Math.abs(endAngle - startAngle);
  return (
    Object.values(options).every(Number.isFinite) &&
    outerRadius > 0 &&
    outerRadius <= 10000 &&
    innerRadius >= 0 &&
    innerRadius < outerRadius &&
    sweep >= 0.1 &&
    sweep <= 360 &&
    Math.abs(startAngle) <= 3600 &&
    Math.abs(endAngle) <= 3600
  );
};

export const canCreateRingSegment = <T extends ExcalidrawElement>(
  element: T,
): element is T & ExcalidrawEllipseElement =>
  element.type === "ellipse" &&
  !element.locked &&
  !element.isDeleted &&
  element.width > 0 &&
  element.height > 0 &&
  !element.boundElements?.length;

/** Partial segments are simple contours; full rings use doubled keyhole
 * bridges for the fill and separate visible contours at the element layer.
 * Angles are degrees, clockwise from the right in canvas coordinates.
 */
export const getRingSegmentPoints = (
  options: RingSegmentOptions,
): LocalPoint[] => {
  if (!isValidRingSegment(options)) {
    throw new Error("Invalid ring segment parameters");
  }
  const { outerRadius, innerRadius, startAngle, endAngle } = options;
  const start = (startAngle * Math.PI) / 180;
  const sweep = ((endAngle - startAngle) * Math.PI) / 180;
  const maxStep = Math.min(
    Math.PI / 8,
    2 * Math.acos(Math.max(-1, 1 - 0.75 / outerRadius)),
  );
  const count = Math.max(2, Math.ceil(Math.abs(sweep) / maxStep));
  const arc = (radius: number, reverse: boolean) =>
    Array.from({ length: count + 1 }, (_, i) => {
      const angle = start + (sweep * (reverse ? count - i : i)) / count;
      return pointFrom<LocalPoint>(
        radius * Math.cos(angle),
        radius * Math.sin(angle),
      );
    });
  const outer = arc(outerRadius, false);
  const inner = innerRadius
    ? arc(innerRadius, true)
    : [pointFrom<LocalPoint>(0, 0)];
  const full = Math.abs(endAngle - startAngle) === 360;
  if (full) {
    outer[outer.length - 1] = outer[0];
    if (innerRadius) {
      inner[inner.length - 1] = inner[0];
    }
  }
  const points = full && !innerRadius ? outer : [...outer, ...inner];
  points.push(points[0]);
  return points;
};

export const ellipseToRingSegment = (
  source: ExcalidrawEllipseElement,
  options: RingSegmentOptions,
) => {
  const centerX = source.x + source.width / 2;
  const centerY = source.y + source.height / 2;
  const rotated = getRingSegmentPoints(options).map((point) =>
    pointRotateRads(point, pointFrom<LocalPoint>(0, 0), source.angle),
  );
  const origin = rotated[0];
  const points = rotated.map(([x, y]) =>
    pointFrom<LocalPoint>(x - origin[0], y - origin[1]),
  );
  const line = newLinearElement({
    ...source,
    type: "line",
    x: centerX + origin[0],
    y: centerY + origin[1],
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
  return { ...line, id: randomId(), type: "line" as const, polygon: true };
};

/** Full donuts use grouped fill/boundary lines; partial segments stay one line. */
export const ellipseToRingSegmentElements = (
  source: ExcalidrawEllipseElement,
  options: RingSegmentOptions,
) => {
  if (
    Math.abs(options.endAngle - options.startAngle) !== 360 ||
    !options.innerRadius
  ) {
    return [ellipseToRingSegment(source, options)];
  }
  const line = ellipseToRingSegment(source, options);
  const global = line.points.map(([x, y]) =>
    pointFrom<GlobalPoint>(line.x + x, line.y + y),
  );
  const contours = splitKeyholeContours(global);
  if (!contours) {
    throw new Error("Invalid donut contours");
  }
  return createPolygonElements(source, contoursToEvenOddPolygons(contours));
};

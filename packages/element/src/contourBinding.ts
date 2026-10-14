import {
  lineSegment,
  pointFrom,
  pointDistanceSq,
  polygonIncludesPoint,
  polygon,
} from "@excalidraw/math";

import type { GlobalPoint, LineSegment } from "@excalidraw/math";

import { getLineOperationPoints } from "./lineOperations";

import type { ElementsMap, ExcalidrawLineElement } from "./types";

const geometryCache = new WeakMap<
  ExcalidrawLineElement,
  {
    version: number;
    points: GlobalPoint[];
    segments: LineSegment<GlobalPoint>[];
  }
>();

/** The visible boundary, excluding the doubled bridges used to encode holes. */
const getContourBindingGeometry = (
  element: ExcalidrawLineElement,
  elementsMap: ElementsMap,
) => {
  const cached = geometryCache.get(element);
  if (cached?.version === element.version) {
    return cached;
  }
  const points = getLineOperationPoints(element, elementsMap);
  const segments = new Map<string, LineSegment<GlobalPoint>>();
  const key = (point: GlobalPoint) => `${point[0]},${point[1]}`;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (pointDistanceSq(a, b) < 1e-12) {
      continue;
    }
    const reverse = `${key(b)}>${key(a)}`;
    if (segments.has(reverse)) {
      segments.delete(reverse);
    } else {
      segments.set(`${key(a)}>${key(b)}`, lineSegment(a, b));
    }
  }
  const geometry = {
    version: element.version,
    points,
    segments: [...segments.values()],
  };
  geometryCache.set(element, geometry);
  return geometry;
};

export const getContourBindingSegments = (
  element: ExcalidrawLineElement,
  elementsMap: ElementsMap,
): LineSegment<GlobalPoint>[] =>
  getContourBindingGeometry(element, elementsMap).segments;

export const getNearestContourBindingPoint = (
  element: ExcalidrawLineElement,
  elementsMap: ElementsMap,
  point: GlobalPoint,
): GlobalPoint => {
  let nearest = point;
  let distance = Infinity;
  for (const [a, b] of getContourBindingSegments(element, elementsMap)) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(
        1,
        ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy),
      ),
    );
    const projected = pointFrom<GlobalPoint>(a[0] + dx * t, a[1] + dy * t);
    const nextDistance = pointDistanceSq(point, projected);
    if (nextDistance < distance) {
      nearest = projected;
      distance = nextDistance;
    }
  }
  return nearest;
};

export const isPointInsideContour = (
  element: ExcalidrawLineElement,
  elementsMap: ElementsMap,
  point: GlobalPoint,
): boolean =>
  polygonIncludesPoint(
    point,
    polygon(...getContourBindingGeometry(element, elementsMap).points),
  );

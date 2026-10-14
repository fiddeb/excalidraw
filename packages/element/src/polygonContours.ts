import polygonClipping from "polygon-clipping";

import {
  arrayToMap,
  getSizeFromPoints,
  isTransparent,
  randomId,
} from "@excalidraw/common";
import { pointFrom } from "@excalidraw/math";

import type { GlobalPoint, LocalPoint, Radians } from "@excalidraw/math";

import { spliceHoleIntoRing } from "./bucketFill";
import { getLineOperationPoints } from "./lineOperations";
import { isLineElement } from "./typeChecks";
import { newLinearElement } from "./newElement";

import type { MultiPolygon, Polygon } from "polygon-clipping";

import type {
  ExcalidrawElement,
  ExcalidrawLineElement,
  NonDeleted,
} from "./types";

const key = ([x, y]: readonly number[]) => `${x},${y}`;

/** Recover ordinary rings from exact doubled keyhole edges, without metadata.
 * Reject branching/ambiguous walks; callers still validate ring simplicity.
 */
export const splitKeyholeContours = (
  points: readonly GlobalPoint[],
): GlobalPoint[][] | null => {
  const edges = new Map<string, [GlobalPoint, GlobalPoint]>();
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (key(a) === key(b)) {
      continue;
    }
    const forward = `${key(a)}>${key(b)}`;
    const reverse = `${key(b)}>${key(a)}`;
    if (edges.has(reverse)) {
      edges.delete(reverse);
    } else if (edges.has(forward)) {
      return null;
    } else {
      edges.set(forward, [a, b]);
    }
  }
  const outgoing = new Map<string, [GlobalPoint, GlobalPoint]>();
  for (const edge of edges.values()) {
    if (outgoing.has(key(edge[0]))) {
      return null;
    }
    outgoing.set(key(edge[0]), edge);
  }
  const rings: GlobalPoint[][] = [];
  while (outgoing.size) {
    const first = outgoing.values().next().value!;
    const ring = [first[0]];
    let current = first[0];
    do {
      const edge = outgoing.get(key(current));
      if (!edge) {
        return null;
      }
      outgoing.delete(key(current));
      current = edge[1];
      ring.push(current);
    } while (key(current) !== key(ring[0]));
    if (ring.length < 4) {
      return null;
    }
    rings.push(ring);
  }
  return rings.length ? rings : null;
};

export const contoursToEvenOddPolygons = (
  rings: readonly GlobalPoint[][],
): MultiPolygon => {
  const polygons: Polygon[] = rings.map((ring) => [
    ring.map(([x, y]) => [x, y]),
  ]);
  return polygonClipping.xor(polygons[0], ...polygons.slice(1));
};

/** A fill-only keyhole polygon plus separate boundary lines avoids visible
 * bridge strokes. Every part is a native editable line, including the fill.
 * No customData or background-colored cover is required to render the hole.
 */
export const createPolygonElements = (
  source: ExcalidrawElement,
  polygons: MultiPolygon,
): NonDeleted<ExcalidrawLineElement>[] => {
  const make = (
    ring: readonly (readonly number[])[],
    overrides: Partial<ExcalidrawLineElement> = {},
  ) => {
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
      boundElements: null,
      customData: undefined,
      index: null,
      version: 1,
      versionNonce: 0,
      ...overrides,
    });
    return { ...line, id: randomId(), type: "line" as const, polygon: true };
  };
  return polygons.flatMap((polygon) => {
    if (polygon.length === 1) {
      return [make(polygon[0])];
    }
    const groupIds = [randomId(), ...source.groupIds];
    const rings = polygon.map((ring) =>
      ring.slice(0, -1).map(([x, y]) => pointFrom<GlobalPoint>(x, y)),
    );
    let fillRing = rings[0];
    for (const hole of rings.slice(1)) {
      fillRing = spliceHoleIntoRing(fillRing, hole);
    }
    const paint = make([...fillRing, fillRing[0]], {
      strokeColor: "transparent",
      groupIds,
    });
    const boundaries = polygon.map((ring) =>
      make(ring, { backgroundColor: "transparent", groupIds }),
    );
    // Keep a transparent fill carrier too: the geometry remains usable when
    // a later fill is applied, and can be decoded after native roundtrips.
    return [
      paint,
      ...boundaries.filter(() => !isTransparent(source.strokeColor)),
    ];
  });
};

/** SVG's nonzero winding includes overlapping same/opposite-winding rings. */
export const contoursToNonZeroPolygons = (
  rings: readonly GlobalPoint[][],
): MultiPolygon => {
  let regions = new Map<number, MultiPolygon>();
  for (const ring of rings) {
    let area = 0;
    const origin = ring[0];
    for (let i = 0; i < ring.length - 1; i++) {
      area +=
        (ring[i][0] - origin[0]) * (ring[i + 1][1] - origin[1]) -
        (ring[i + 1][0] - origin[0]) * (ring[i][1] - origin[1]);
    }
    const sign = Math.sign(area);
    if (!sign) {
      continue;
    }
    const polygon: MultiPolygon = [[ring.map(([x, y]) => [x, y])]];
    let outside = polygon;
    const next = new Map<number, MultiPolygon>();
    const add = (winding: number, value: MultiPolygon) => {
      if (!winding || !value.length) {
        return;
      }
      const previous = next.get(winding);
      next.set(
        winding,
        previous ? polygonClipping.union(previous, value) : value,
      );
    };
    for (const [winding, region] of regions) {
      add(winding, polygonClipping.difference(region, polygon));
      add(winding + sign, polygonClipping.intersection(region, polygon));
      outside = polygonClipping.difference(outside, region);
    }
    add(sign, outside);
    regions = next;
  }
  const values = [...regions.values()];
  return values.length
    ? polygonClipping.union(values[0], ...values.slice(1))
    : [];
};

/** Recognize native fill/outline groups without metadata. A structural
 * fallback protects paint roles after independent point edits, but marks the
 * association stale so boolean operations cannot silently reinterpret it.
 */
export const getCompoundPolygonGroups = (
  elements: readonly ExcalidrawElement[],
) => {
  const groups = new Map<
    string,
    {
      contours: GlobalPoint[][];
      boundaries: ExcalidrawLineElement[];
      stale: boolean;
    }
  >();
  const map = arrayToMap(elements);
  // Most traced SVG paths are filled shapes without separate outlines. Index
  // eligible outline siblings once instead of scanning the selection per fill.
  const outlinesByGroup = new Map<string, ExcalidrawLineElement[]>();
  for (const element of elements) {
    if (
      !isLineElement(element) ||
      element.roundness ||
      !element.groupIds[0] ||
      !isTransparent(element.backgroundColor) ||
      isTransparent(element.strokeColor)
    ) {
      continue;
    }
    const siblings = outlinesByGroup.get(element.groupIds[0]) ?? [];
    siblings.push(element);
    outlinesByGroup.set(element.groupIds[0], siblings);
  }
  for (const carrier of elements) {
    if (
      !isLineElement(carrier) ||
      carrier.roundness ||
      !carrier.groupIds.length ||
      !isTransparent(carrier.strokeColor) ||
      carrier.points.length > 5000
    ) {
      continue;
    }
    const candidates = carrier.groupIds.flatMap(
      (id) => outlinesByGroup.get(id) ?? [],
    );
    if (!candidates.length) {
      continue;
    }
    const contours = splitKeyholeContours(getLineOperationPoints(carrier, map));
    if (!contours || contours.length < 1) {
      continue;
    }
    const epsilon = Math.max(1, carrier.width, carrier.height) * 1e-8;
    const boundaries = candidates.filter(
      (element): element is ExcalidrawLineElement => {
        if (
          !isLineElement(element) ||
          element.id === carrier.id ||
          element.roundness ||
          !isTransparent(element.backgroundColor) ||
          isTransparent(element.strokeColor) ||
          !element.groupIds[0] ||
          !carrier.groupIds.includes(element.groupIds[0])
        ) {
          return false;
        }
        const ring = getLineOperationPoints(element, map);
        const onPath = (point: GlobalPoint, path: GlobalPoint[]) => {
          for (let i = 0; i < path.length - 1; i++) {
            const a = path[i];
            const b = path[i + 1];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const length = dx * dx + dy * dy;
            const t = length
              ? Math.max(
                  0,
                  Math.min(
                    1,
                    ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length,
                  ),
                )
              : 0;
            if (
              Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy) <
              epsilon
            ) {
              return true;
            }
          }
          return false;
        };
        return contours.some(
          (contour) =>
            ring.every((point) => onPath(point, contour)) &&
            contour.every((point) => onPath(point, ring)),
        );
      },
    );
    if (boundaries.length >= contours.length) {
      groups.set(carrier.id, { contours, boundaries, stale: false });
      continue;
    }
    // Use the nearest shared subgroup, never unrelated siblings in a broader
    // outer group, and require the expected number of boundary parts.
    for (const groupId of carrier.groupIds.slice(0, 2)) {
      const siblings = (outlinesByGroup.get(groupId) ?? []).filter(
        (element): element is ExcalidrawLineElement =>
          isLineElement(element) &&
          element.id !== carrier.id &&
          element.groupIds[0] === groupId &&
          isTransparent(element.backgroundColor) &&
          !isTransparent(element.strokeColor),
      );
      if (siblings.length >= contours.length) {
        groups.set(carrier.id, { contours, boundaries: siblings, stale: true });
        break;
      }
    }
  }
  return groups;
};

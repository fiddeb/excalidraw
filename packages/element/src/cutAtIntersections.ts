import { getSizeFromPoints, randomId } from "@excalidraw/common";
import { pointFrom, pointsEqual } from "@excalidraw/math";

import type { GlobalPoint, LocalPoint, Radians } from "@excalidraw/math";

import { getBooleanShapePoints, isBooleanShape } from "./booleanOperations";
import { getLineOperationPoints } from "./lineOperations";
import { getCompoundPolygonGroups } from "./polygonContours";
import { newLinearElement } from "./newElement";
import { isLineElement } from "./typeChecks";

import type {
  ElementsMap,
  ExcalidrawElement,
  ExcalidrawLineElement,
} from "./types";

export const canCutAtIntersections = (elements: readonly ExcalidrawElement[]) =>
  elements.length >= 2 &&
  elements.every(
    (element) =>
      !element.locked &&
      !element.isDeleted &&
      !element.boundElements?.length &&
      (isBooleanShape(element) ||
        (isLineElement(element) &&
          !element.startArrowhead &&
          !element.endArrowhead &&
          !element.startBinding &&
          !element.endBinding &&
          element.points.length >= 2)),
  ) &&
  elements.every((element) => element.frameId === elements[0].frameId);

type CutResult =
  | { ok: true; replacements: Map<string, ExcalidrawLineElement[]> }
  | { ok: false; reason: "invalid" | "tooComplex" | "overlap" | "none" };

/** Split every selected outline at its intersections with other selections.
 * The pieces are open strokes; splitting a filled boundary removes its fill.
 */
export const cutAtIntersections = (
  elements: readonly ExcalidrawElement[],
  elementsMap: ElementsMap,
): CutResult => {
  if (!canCutAtIntersections(elements)) {
    return { ok: false, reason: "invalid" };
  }
  if (
    elements.length > 100 ||
    elements.some(
      (element) =>
        ![
          element.x,
          element.y,
          element.width,
          element.height,
          element.angle,
        ].every(Number.isFinite) ||
        Math.max(element.width, element.height) > 1e6 ||
        (isLineElement(element) && element.points.length > 2000),
    )
  ) {
    return { ok: false, reason: "tooComplex" };
  }
  const compoundGroups = getCompoundPolygonGroups(elements);
  const sources = elements.filter(({ id }) => !compoundGroups.has(id));
  const paths = sources.map((element) =>
    isLineElement(element)
      ? getLineOperationPoints(element, elementsMap)
      : getBooleanShapePoints(
          element as Parameters<typeof getBooleanShapePoints>[0],
        ),
  );
  if (
    paths.reduce((sum, path) => sum + path.length, 0) > 2000 ||
    paths.some((path) =>
      path.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y)),
    )
  ) {
    return { ok: false, reason: "tooComplex" };
  }
  const cuts = paths.map(() => new Map<number, GlobalPoint>());
  const epsilon = 1e-8;
  for (let a = 0; a < paths.length; a++) {
    for (let b = a + 1; b < paths.length; b++) {
      for (let i = 0; i < paths[a].length - 1; i++) {
        for (let j = 0; j < paths[b].length - 1; j++) {
          const p = paths[a][i];
          const q = paths[b][j];
          const r = [paths[a][i + 1][0] - p[0], paths[a][i + 1][1] - p[1]];
          const s = [paths[b][j + 1][0] - q[0], paths[b][j + 1][1] - q[1]];
          const cross = (u: number[], v: number[]) => u[0] * v[1] - u[1] * v[0];
          const delta = [q[0] - p[0], q[1] - p[1]];
          const denominator = cross(r, s);
          if (!denominator) {
            if (!cross(delta, r) && (r[0] || r[1]) && (s[0] || s[1])) {
              const axis = Math.abs(r[0]) > Math.abs(r[1]) ? 0 : 1;
              const t0 = delta[axis] / r[axis];
              const t1 = (delta[axis] + s[axis]) / r[axis];
              if (
                Math.min(1, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) >
                epsilon
              ) {
                return { ok: false, reason: "overlap" };
              }
            }
            continue;
          }
          const t = cross(delta, s) / denominator;
          const u = cross(delta, r) / denominator;
          if (
            t < -epsilon ||
            t > 1 + epsilon ||
            u < -epsilon ||
            u > 1 + epsilon
          ) {
            continue;
          }
          const point = pointFrom<GlobalPoint>(
            p[0] + Math.max(0, Math.min(1, t)) * r[0],
            p[1] + Math.max(0, Math.min(1, t)) * r[1],
          );
          for (const [index, position] of [
            [a, i + Math.max(0, Math.min(1, t))],
            [b, j + Math.max(0, Math.min(1, u))],
          ]) {
            const path = paths[index];
            const closed = pointsEqual(path[0], path[path.length - 1]);
            let normalized =
              Math.abs(position - Math.round(position)) < epsilon
                ? Math.round(position)
                : position;
            if (closed && normalized === path.length - 1) {
              normalized = 0;
            }
            if (
              closed ||
              (normalized > epsilon && normalized < path.length - 1 - epsilon)
            ) {
              cuts[index].set(normalized, point);
            }
          }
        }
      }
    }
  }
  const replacements = new Map<string, ExcalidrawLineElement[]>();
  paths.forEach((path, index) => {
    const entries = [...cuts[index]].sort(([a], [b]) => a - b);
    if (!entries.length) {
      return;
    }
    const closed = pointsEqual(path[0], path[path.length - 1]);
    if (closed && entries.length < 2) {
      return;
    }
    const end = path.length - 1;
    const positions: [number, GlobalPoint][] = closed
      ? [...entries, [entries[0][0] + end, entries[0][1]]]
      : [[0, path[0]], ...entries, [end, path[end]]];
    const source = sources[index];
    const parts: ExcalidrawLineElement[] = [];
    for (let k = 0; k < positions.length - 1; k++) {
      const [start, first] = positions[k];
      const [stop, last] = positions[k + 1];
      if (stop - start < epsilon) {
        continue;
      }
      const global = [first];
      for (let n = Math.floor(start) + 1; n < stop - epsilon; n++) {
        global.push(path[n % end]);
      }
      global.push(last);
      const points = global.map(([x, y]) =>
        pointFrom<LocalPoint>(x - first[0], y - first[1]),
      );
      const part = newLinearElement({
        ...source,
        type: "line",
        x: first[0],
        y: first[1],
        ...getSizeFromPoints(points),
        points,
        angle: 0 as Radians,
        roundness: null,
        polygon: false,
        backgroundColor: "transparent",
        boundElements: null,
        customData: undefined,
        index: null,
        version: 1,
        versionNonce: 0,
      });
      parts.push({ ...part, id: randomId(), type: "line", polygon: false });
    }
    replacements.set(source.id, parts);
  });
  // Cutting any visible boundary opens that filled shape: remove its fill
  // carrier too, rather than leaving paint behind the newly open strokes.
  for (const [carrierId, { boundaries }] of compoundGroups) {
    if (boundaries.some(({ id }) => replacements.has(id))) {
      replacements.set(carrierId, []);
    }
  }
  return replacements.size
    ? { ok: true, replacements }
    : { ok: false, reason: "none" };
};

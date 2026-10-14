import {
  pointFrom,
  pointFromPair,
  type GlobalPoint,
  type LocalPoint,
} from "@excalidraw/math";

import type { NullableGridSize } from "@excalidraw/excalidraw/types";

export const getSizeFromPoints = (
  points: readonly (GlobalPoint | LocalPoint)[],
) => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  // Avoid passing a point per argument: large imported paths exceed the
  // engine's argument limit even though the calculation itself is cheap.
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return {
    width: maxX - minX,
    height: maxY - minY,
  };
};

/** @arg dimension, 0 for rescaling only x, 1 for y */
export const rescalePoints = <Point extends GlobalPoint | LocalPoint>(
  dimension: 0 | 1,
  newSize: number,
  points: readonly Point[],
  normalize: boolean,
): Point[] => {
  const coordinates = points.map((point) => point[dimension]);
  const maxCoordinate = Math.max(...coordinates);
  const minCoordinate = Math.min(...coordinates);
  const size = maxCoordinate - minCoordinate;
  const scale = size === 0 ? 1 : newSize / size;

  let nextMinCoordinate = Infinity;

  const scaledPoints = points.map((point): Point => {
    const newCoordinate = point[dimension] * scale;
    const newPoint = [...point];
    newPoint[dimension] = newCoordinate;
    if (newCoordinate < nextMinCoordinate) {
      nextMinCoordinate = newCoordinate;
    }
    return newPoint as Point;
  });

  if (!normalize) {
    return scaledPoints;
  }

  if (scaledPoints.length === 2) {
    // we don't translate two-point lines
    return scaledPoints;
  }

  const translation = minCoordinate - nextMinCoordinate;

  const nextPoints = scaledPoints.map((scaledPoint) =>
    pointFromPair<Point>(
      scaledPoint.map((value, currentDimension) => {
        return currentDimension === dimension ? value + translation : value;
      }) as [number, number],
    ),
  );

  return nextPoints;
};

// TODO: Rounding this point causes some shake when free drawing
export const getGridPoint = (
  x: number,
  y: number,
  gridSize: NullableGridSize,
): GlobalPoint => {
  if (gridSize) {
    return pointFrom<GlobalPoint>(
      Math.round(x / gridSize) * gridSize,
      Math.round(y / gridSize) * gridSize,
    );
  }
  return pointFrom<GlobalPoint>(x, y);
};

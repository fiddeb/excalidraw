import { parsePath } from "path-data-parser";
import { pointsOnPath } from "points-on-path";

import {
  colorToHex,
  getSizeFromPoints,
  isTransparent,
  randomId,
} from "@excalidraw/common";
import { newElement, newLinearElement } from "@excalidraw/element";
import { isSimpleBooleanRing } from "@excalidraw/element/booleanOperations";
import {
  contoursToEvenOddPolygons,
  contoursToNonZeroPolygons,
  createPolygonElements,
} from "@excalidraw/element/polygonContours";
import { pointFrom } from "@excalidraw/math";

import type { GlobalPoint, LocalPoint, Radians } from "@excalidraw/math";
import type { ExcalidrawElement, NonDeleted } from "@excalidraw/element/types";

type Matrix = [number, number, number, number, number, number];
const identity: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const transformPoint = (point: readonly number[], m: Matrix) =>
  pointFrom<GlobalPoint>(
    m[0] * point[0] + m[2] * point[1] + m[4],
    m[1] * point[0] + m[3] * point[1] + m[5],
  );
const numbers = (input: string) => {
  const matches =
    input.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || [];
  if (
    input
      .replace(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g, "")
      .replace(/[\s,]/g, "")
  ) {
    throw new Error("Invalid numeric list");
  }
  const result = matches.map(Number);
  if (!result.every(Number.isFinite)) {
    throw new Error("Non-finite coordinates");
  }
  return result;
};
const parseTransform = (input: string): Matrix => {
  let matrix = identity;
  const pattern = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let consumed = "";
  for (const match of input.matchAll(pattern)) {
    consumed += match[0];
    const values = numbers(match[2]);
    const [a = 0, b = 0] = values;
    let next: Matrix;
    const radians = (a * Math.PI) / 180;
    switch (match[1]) {
      case "matrix":
        if (values.length !== 6) {
          throw new Error("Invalid matrix");
        }
        next = values as Matrix;
        break;
      case "translate":
        if (values.length < 1 || values.length > 2) {
          throw new Error("Invalid translate");
        }
        next = [1, 0, 0, 1, a, b];
        break;
      case "scale":
        if (values.length < 1 || values.length > 2) {
          throw new Error("Invalid scale");
        }
        next = [a, 0, 0, values[1] ?? a, 0, 0];
        break;
      case "rotate": {
        if (values.length !== 1 && values.length !== 3) {
          throw new Error("Invalid rotate");
        }
        next = [
          Math.cos(radians),
          Math.sin(radians),
          -Math.sin(radians),
          Math.cos(radians),
          0,
          0,
        ];
        if (values.length === 3) {
          next = multiply(multiply([1, 0, 0, 1, b, values[2]], next), [
            1,
            0,
            0,
            1,
            -b,
            -values[2],
          ]);
        }
        break;
      }
      case "skewX":
      case "skewY":
        if (values.length !== 1) {
          throw new Error("Invalid skew");
        }
        next =
          match[1] === "skewX"
            ? [1, 0, Math.tan(radians), 1, 0, 0]
            : [1, Math.tan(radians), 0, 1, 0, 0];
        break;
      default:
        throw new Error("Unsupported transform");
    }
    matrix = multiply(matrix, next);
  }
  if (input.replace(pattern, "").trim() || (!consumed && input.trim())) {
    throw new Error("Invalid transform");
  }
  return matrix;
};

type Style = Record<string, string>;
export type EditableSvgResult = {
  elements: NonDeleted<ExcalidrawElement>[];
  warnings: string[];
};
export const MAX_EDITABLE_SVG_SIZE = 5_000_000;
const MAX_NODES = 10000;
const MAX_ELEMENTS = 10000;
const MAX_POINTS = 200000;

/** Parse inert XML only, never mount/import SVG nodes or resolve resources.
 * DOMParser comes from the editor's owner window, including embedded editors.
 */
export const importEditableSvg = (
  input: string,
  Parser: typeof DOMParser,
): EditableSvgResult => {
  if (input.length > MAX_EDITABLE_SVG_SIZE) {
    throw new Error("SVG exceeds the 5 MB size limit");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(input)) {
    throw new Error("SVG declares unsupported XML entities or a DOCTYPE");
  }
  const document = new Parser().parseFromString(input, "image/svg+xml");
  const root = document.documentElement;
  if (
    document.querySelector("parsererror") ||
    root.localName !== "svg" ||
    (root.namespaceURI && root.namespaceURI !== "http://www.w3.org/2000/svg")
  ) {
    throw new Error("Invalid SVG document");
  }
  if (document.querySelectorAll("*").length > MAX_NODES) {
    throw new Error(`SVG contains more than ${MAX_NODES} nodes`);
  }
  const elements: NonDeleted<ExcalidrawElement>[] = [];
  const warnings = new Set<string>();
  let pointCount = 0;
  let skippedGeometryCount = 0;
  const number = (node: Element, attribute: string, fallback = 0) => {
    const value = node.getAttribute(attribute);
    if (value === null) {
      return fallback;
    }
    if (
      !/^[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?(?:px)?$/.test(
        value.trim(),
      )
    ) {
      throw new Error(`Unsupported ${attribute} unit`);
    }
    const parsed = Number(value.replace(/px$/, ""));
    if (!Number.isFinite(parsed) || Math.abs(parsed) > 1e6) {
      throw new Error("Coordinates out of range");
    }
    return parsed;
  };
  const push = (...items: NonDeleted<ExcalidrawElement>[]) => {
    pointCount += items.reduce(
      (sum, item) => sum + (item.type === "line" ? item.points.length : 4),
      0,
    );
    if (
      pointCount > MAX_POINTS ||
      elements.length + items.length > MAX_ELEMENTS
    ) {
      throw new Error("Converted SVG is too complex");
    }
    if (
      items.some(
        (item) =>
          ![item.x, item.y, item.width, item.height, item.strokeWidth].every(
            Number.isFinite,
          ) ||
          Math.max(
            Math.abs(item.x),
            Math.abs(item.y),
            item.width,
            item.height,
          ) > 1e6,
      )
    ) {
      throw new Error("Transformed geometry is out of range");
    }
    elements.push(...items);
  };
  const rootGroup = randomId();
  const visit = (
    node: Element,
    parent: Matrix,
    inherited: Style,
    groups: string[],
    depth: number,
  ) => {
    if (depth > 32) {
      throw new Error("SVG nesting is too deep");
    }
    const tag = node.localName;
    if (["defs", "title", "desc", "metadata"].includes(tag)) {
      return;
    }
    if (node.namespaceURI !== root.namespaceURI) {
      warnings.add(`Skipped <${tag}>`);
      return;
    }
    const style = { ...inherited };
    const own: Style = {};
    for (const name of [
      "fill",
      "stroke",
      "color",
      "stroke-width",
      "fill-rule",
      "fill-opacity",
      "stroke-opacity",
      "display",
      "visibility",
      "opacity",
      "vector-effect",
      "stroke-dasharray",
      "stroke-linecap",
      "stroke-linejoin",
      "clip-path",
      "mask",
      "filter",
      "marker-start",
      "marker-mid",
      "marker-end",
    ]) {
      const value = node.getAttribute(name);
      if (value !== null) {
        own[name] = value;
      }
    }
    for (const declaration of (node.getAttribute("style") || "").split(";")) {
      const colon = declaration.indexOf(":");
      if (colon >= 0) {
        own[declaration.slice(0, colon).trim()] = declaration
          .slice(colon + 1)
          .trim();
      }
    }
    Object.assign(style, own);
    if (style.display === "none" || style.visibility === "hidden") {
      return;
    }
    if (
      [
        "clip-path",
        "mask",
        "filter",
        "marker-start",
        "marker-mid",
        "marker-end",
      ].some((name) => style[name] && style[name] !== "none")
    ) {
      warnings.add(`Skipped <${tag}> with clipping, mask, filter or markers`);
      return;
    }
    if (node.hasAttribute("class")) {
      warnings.add("CSS classes/stylesheets are not applied");
    }
    const knownStyles = new Set([
      "fill",
      "stroke",
      "color",
      "stroke-width",
      "fill-rule",
      "fill-opacity",
      "stroke-opacity",
      "display",
      "visibility",
      "opacity",
      "vector-effect",
      "stroke-dasharray",
      "stroke-linecap",
      "stroke-linejoin",
    ]);
    for (const property of Object.keys(own)) {
      if (!knownStyles.has(property)) {
        warnings.add(`Unsupported style: ${property}`);
      }
    }
    let matrix: Matrix;
    try {
      matrix = multiply(
        parent,
        parseTransform(node.getAttribute("transform") || ""),
      );
    } catch {
      warnings.add(`Skipped <${tag}> with invalid transform`);
      return;
    }
    if (!matrix.every(Number.isFinite)) {
      warnings.add(`Skipped <${tag}> with non-finite transform`);
      return;
    }
    if (tag === "svg") {
      if (node !== root) {
        warnings.add("Nested SVG viewports are not supported");
        return;
      }
      const viewBox = node.getAttribute("viewBox");
      if (viewBox) {
        const box = numbers(viewBox);
        if (box.length !== 4 || box[2] <= 0 || box[3] <= 0) {
          throw new Error("Invalid viewBox");
        }
        const width = number(node, "width", box[2]);
        const height = number(node, "height", box[3]);
        if (width <= 0 || height <= 0) {
          throw new Error("Invalid viewport");
        }
        const aspect = (
          node.getAttribute("preserveAspectRatio") || "xMidYMid meet"
        ).trim();
        let sx = width / box[2];
        let sy = height / box[3];
        let dx = 0;
        let dy = 0;
        if (aspect !== "none") {
          const match = aspect.match(
            /^(xMin|xMid|xMax)(YMin|YMid|YMax)(?:\s+(meet|slice))?$/,
          );
          if (!match) {
            throw new Error("Unsupported preserveAspectRatio");
          }
          if (match[3] === "slice") {
            throw new Error("Clipped slice viewport is not supported");
          }
          sx = sy = Math.min(sx, sy);
          dx =
            (width - box[2] * sx) *
            (match[1] === "xMin" ? 0 : match[1] === "xMid" ? 0.5 : 1);
          dy =
            (height - box[3] * sy) *
            (match[2] === "YMin" ? 0 : match[2] === "YMid" ? 0.5 : 1);
        }
        matrix = multiply(matrix, [
          sx,
          0,
          0,
          sy,
          dx - box[0] * sx,
          dy - box[1] * sy,
        ]);
      }
    }
    if (tag === "svg" || tag === "g") {
      if (own.opacity && Number(own.opacity) !== 1) {
        warnings.add(
          `Skipped <${tag}> with group opacity (compositing is not preserved)`,
        );
        return;
      }
      const nextGroups = tag === "g" ? [randomId(), ...groups] : groups;
      for (const child of Array.from(node.children)) {
        visit(child, matrix, style, nextGroups, depth + 1);
      }
      return;
    }
    if (
      ![
        "rect",
        "ellipse",
        "circle",
        "line",
        "polyline",
        "polygon",
        "path",
      ].includes(tag)
    ) {
      warnings.add(`Skipped <${tag}>`);
      return;
    }
    const elementStart = elements.length;
    const pointsStart = pointCount;
    try {
      const opacity = Number(own.opacity ?? "1");
      const paint = (value: string, alpha: string) => {
        if (value === "none") {
          return "transparent";
        }
        const hex = colorToHex(
          value === "currentColor" ? style.color || "black" : value,
        );
        const factor = Number(alpha);
        if (!hex || !Number.isFinite(factor) || factor < 0 || factor > 1) {
          throw new Error(
            "Unsupported paint (gradients/patterns are not converted)",
          );
        }
        const existingAlpha =
          hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
        const a = Math.round(existingAlpha * factor * 255);
        return a === 255
          ? hex.slice(0, 7)
          : `${hex.slice(0, 7)}${a.toString(16).padStart(2, "0")}`;
      };
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
        throw new Error("Invalid opacity");
      }
      const fill = paint(style.fill || "black", style["fill-opacity"] || "1");
      const stroke = paint(
        style.stroke || "none",
        style["stroke-opacity"] || "1",
      );
      const width = Number((style["stroke-width"] || "1").replace(/px$/, ""));
      if (!Number.isFinite(width) || width < 0 || width > 10000) {
        throw new Error("Unsupported stroke width");
      }
      const scaleX = Math.hypot(matrix[0], matrix[1]);
      const scaleY = Math.hypot(matrix[2], matrix[3]);
      if (Math.abs(scaleX - scaleY) > 1e-6 && !isTransparent(stroke)) {
        warnings.add(
          "Stroke width under nonuniform transforms is approximated",
        );
      }
      if (style["stroke-dasharray"] && style["stroke-dasharray"] !== "none") {
        warnings.add("Custom dash arrays are approximated as dashed strokes");
      }
      if (
        (style["stroke-linecap"] && style["stroke-linecap"] !== "round") ||
        (style["stroke-linejoin"] && style["stroke-linejoin"] !== "round")
      ) {
        warnings.add("Stroke caps/joins use Excalidraw's native rendering");
      }
      let carrier = newLinearElement({
        type: "line",
        x: 0,
        y: 0,
        strokeColor: width ? stroke : "transparent",
        backgroundColor: fill,
        strokeWidth:
          width *
          (style["vector-effect"] === "non-scaling-stroke"
            ? 1
            : Math.sqrt(scaleX * scaleY)),
        strokeStyle:
          style["stroke-dasharray"] && style["stroke-dasharray"] !== "none"
            ? "dashed"
            : "solid",
        fillStyle: "solid",
        roughness: 0,
        opacity: opacity * 100,
        groupIds: groups,
      });
      const makeLine = (path: GlobalPoint[], closed: boolean) => {
        const first = path[0];
        const points = path.map(([x, y]) =>
          pointFrom<LocalPoint>(x - first[0], y - first[1]),
        );
        const line = newLinearElement({
          ...carrier,
          type: "line",
          x: first[0],
          y: first[1],
          ...getSizeFromPoints(points),
          points,
          polygon: closed,
          backgroundColor: "transparent",
        });
        return {
          ...line,
          id: randomId(),
          type: "line" as const,
          polygon: closed,
        };
      };
      let paths: GlobalPoint[][] = [];
      let closed: boolean[] = [];
      if (tag === "rect" || tag === "ellipse" || tag === "circle") {
        const x = tag === "rect" ? number(node, "x") : number(node, "cx");
        const y = tag === "rect" ? number(node, "y") : number(node, "cy");
        const w =
          tag === "rect"
            ? number(node, "width")
            : 2 * number(node, tag === "circle" ? "r" : "rx");
        const h =
          tag === "rect"
            ? number(node, "height")
            : 2 * number(node, tag === "circle" ? "r" : "ry");
        if (w <= 0 || h <= 0) {
          return;
        }
        const rx = tag === "rect" ? number(node, "rx", number(node, "ry")) : 0;
        const ry = tag === "rect" ? number(node, "ry", rx) : 0;
        const orthogonal =
          Math.abs(matrix[0] * matrix[2] + matrix[1] * matrix[3]) <
          1e-8 * Math.max(1, scaleX * scaleY);
        if (orthogonal && !rx && !ry) {
          const center = transformPoint(
            tag === "rect" ? [x + w / 2, y + h / 2] : [x, y],
            matrix,
          );
          const primitive = newElement({
            ...carrier,
            type: tag === "rect" ? "rectangle" : "ellipse",
            x: center[0] - (w * scaleX) / 2,
            y: center[1] - (h * scaleY) / 2,
            width: w * scaleX,
            height: h * scaleY,
            angle: Math.atan2(matrix[1], matrix[0]) as Radians,
          });
          push({ ...primitive, id: randomId() });
          return;
        }
        if (rx || ry) {
          const rX = Math.min(w / 2, rx);
          const rY = Math.min(h / 2, ry);
          if (rX < 0 || rY < 0) {
            throw new Error("Negative corner radius");
          }
          const d = `M${x + rX},${y} H${x + w - rX} A${rX},${rY} 0 0 1 ${
            x + w
          },${y + rY} V${y + h - rY} A${rX},${rY} 0 0 1 ${x + w - rX},${
            y + h
          } H${x + rX} A${rX},${rY} 0 0 1 ${x},${y + h - rY} V${
            y + rY
          } A${rX},${rY} 0 0 1 ${x + rX},${y} Z`;
          paths = pointsOnPath(d, 0.5, 0.5).map((path) =>
            path.map((point) => transformPoint(point, matrix)),
          );
        } else if (tag === "rect") {
          paths = [
            [
              [x, y],
              [x + w, y],
              [x + w, y + h],
              [x, y + h],
              [x, y],
            ].map((point) => transformPoint(point, matrix)),
          ];
        } else {
          const count = Math.max(
            24,
            Math.min(
              1024,
              Math.ceil(
                Math.PI /
                  Math.acos(
                    Math.max(-1, 1 - 0.5 / Math.max(w * scaleX, h * scaleY)),
                  ),
              ),
            ),
          );
          paths = [
            Array.from({ length: count }, (_, i) =>
              transformPoint(
                [
                  x + (w / 2) * Math.cos((i * Math.PI * 2) / count),
                  y + (h / 2) * Math.sin((i * Math.PI * 2) / count),
                ],
                matrix,
              ),
            ),
          ];
          paths[0].push(paths[0][0]);
        }
        closed = [true];
      } else if (tag === "line") {
        paths = [
          [
            transformPoint([number(node, "x1"), number(node, "y1")], matrix),
            transformPoint([number(node, "x2"), number(node, "y2")], matrix),
          ],
        ];
        closed = [false];
      } else if (tag === "path") {
        const d = node.getAttribute("d") || "";
        // The dependency loops on a number following Z: validate command
        // arities before invoking it on untrusted input.
        if (
          d.length > 20000 ||
          !/^\s*[Mm]/.test(d) ||
          /[zZ][\s,]*[-+.\d]/.test(d)
        ) {
          throw new Error("Invalid or excessive path data");
        }
        const segments = parsePath(d);
        if (
          segments.some(
            ({ key, data }) =>
              key.toUpperCase() === "A" &&
              (data[0] < 0 ||
                data[1] < 0 ||
                ![0, 1].includes(data[3]) ||
                ![0, 1].includes(data[4])),
          )
        ) {
          throw new Error("Invalid arc parameters");
        }
        if (
          !segments.length ||
          segments.length > 500 ||
          segments.some(({ data }) =>
            data.some(
              (value) => !Number.isFinite(value) || Math.abs(value) > 1e6,
            ),
          )
        ) {
          throw new Error("Invalid path coordinates");
        }
        const chunks: string[] = [];
        let chunk = "";
        for (const segment of segments) {
          if (segment.key.toUpperCase() === "M" && chunk) {
            chunks.push(chunk);
            chunk = "";
          }
          chunk += `${segment.key}${segment.data.join(" ")} `;
        }
        if (chunk) {
          chunks.push(chunk);
        }
        if (chunks.length > 32) {
          throw new Error("Too many subpaths");
        }
        // Sample the complete path so relative moveto between subpaths keeps
        // its previous current point. This also handles arcs and smooth curves.
        paths = pointsOnPath(d, 0.5, 0.5 / Math.max(scaleX, scaleY, 1)).map(
          (path) => path.map((point) => transformPoint(point, matrix)),
        );
        closed = chunks.map((part) => /[zZ]\s*$/.test(part));
      } else {
        const values = numbers(node.getAttribute("points") || "");
        if (values.length < 4 || values.length % 2 || values.length > 4000) {
          throw new Error("Invalid point list");
        }
        paths = [
          Array.from({ length: values.length / 2 }, (_, i) =>
            transformPoint(values.slice(i * 2, i * 2 + 2), matrix),
          ),
        ];
        closed = [tag === "polygon"];
        if (closed[0]) {
          paths[0].push(paths[0][0]);
        }
      }
      if (
        paths.some(
          (path) =>
            path.length > 5000 ||
            path.some(
              ([x, y]) =>
                !Number.isFinite(x) ||
                !Number.isFinite(y) ||
                Math.abs(x) > 1e6 ||
                Math.abs(y) > 1e6,
            ),
        )
      ) {
        throw new Error("Converted path is too complex or out of range");
      }
      const meaningful = paths
        .map((path, i) => ({ path, closed: closed[i] }))
        .filter(({ path }) => path.length >= 2);
      if (tag !== "line" && !isTransparent(fill)) {
        const rings = meaningful
          .filter(({ path }) => path.length >= 3)
          .map(({ path }) =>
            path[0][0] === path[path.length - 1][0] &&
            path[0][1] === path[path.length - 1][1]
              ? path
              : [...path, path[0]],
          );
        if (rings.some((ring) => !isSimpleBooleanRing(ring))) {
          throw new Error("Self-crossing fills are not supported");
        }
        if (rings.length) {
          const polygons =
            style["fill-rule"] === "evenodd"
              ? contoursToEvenOddPolygons(rings)
              : contoursToNonZeroPolygons(rings);
          const fillCarrier = {
            ...carrier,
            strokeColor: "transparent",
            groupIds: [randomId(), ...groups],
          };
          push(...createPolygonElements(fillCarrier, polygons));
          carrier = { ...carrier, groupIds: fillCarrier.groupIds };
        }
      }
      if (!isTransparent(stroke) && width) {
        push(...meaningful.map(({ path, closed }) => makeLine(path, closed)));
      }
    } catch (error) {
      elements.splice(elementStart);
      pointCount = pointsStart;
      skippedGeometryCount++;
      warnings.add(
        `Skipped <${tag}>: ${
          error instanceof Error ? error.message : "conversion failed"
        }`,
      );
    }
  };
  visit(root, identity, {}, [rootGroup], 0);
  if (skippedGeometryCount) {
    warnings.add(
      `${skippedGeometryCount} geometric SVG nodes could not be converted`,
    );
  }
  return { elements, warnings: [...warnings] };
};

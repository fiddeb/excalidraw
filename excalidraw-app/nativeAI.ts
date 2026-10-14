import { deepCopyElement } from "@excalidraw/element/duplicate";
import { newElementWith } from "@excalidraw/element/mutateElement";
import {
  newArrowElement,
  newElement,
  newLinearElement,
  newTextElement,
} from "@excalidraw/element/newElement";
import {
  bindBindingElement,
  updateBoundElements,
} from "@excalidraw/element/binding";
import {
  isArrowElement,
  isBindableElement,
  isLineElement,
} from "@excalidraw/element/typeChecks";
import { Scene } from "@excalidraw/element/Scene";
import { syncInvalidIndices } from "@excalidraw/element/fractionalIndex";
import { pointFrom } from "@excalidraw/math";

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type { LocalPoint } from "@excalidraw/math";
import type { AppState } from "@excalidraw/excalidraw/types";

const types = [
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "line",
  "arrow",
  "polygon",
] as const;
type NativeType = typeof types[number];
type Spec = {
  action: "create" | "update";
  targetId?: string;
  ref?: string;
  startTarget?: string;
  endTarget?: string;
  type: NativeType;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  points?: [number, number][];
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  fontSize?: number;
};
const keys = new Set([
  "ref",
  "startTarget",
  "endTarget",
  "action",
  "targetId",
  "type",
  "x",
  "y",
  "width",
  "height",
  "text",
  "points",
  "strokeColor",
  "backgroundColor",
  "strokeWidth",
  "roughness",
  "opacity",
  "fontSize",
]);
const number = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;

export const describeNativeSelection = (
  elements: readonly NonDeletedExcalidrawElement[],
) =>
  elements.map((element) => ({
    id: element.id,
    type: isLineElement(element) && element.polygon ? "polygon" : element.type,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    angle: element.angle,
    locked: element.locked,
    strokeColor: element.strokeColor,
    backgroundColor: element.backgroundColor,
    strokeWidth: element.strokeWidth,
    roughness: element.roughness,
    opacity: element.opacity,
    ...(element.type === "text"
      ? { text: element.text, fontSize: element.fontSize }
      : {}),
    ...(element.type === "line" || element.type === "arrow"
      ? { points: element.points }
      : {}),
  }));

export function prepareNativeProposal(
  source: string,
  original: readonly ExcalidrawElement[],
  selectedIds: ReadonlySet<string>,
) {
  const data = JSON.parse(source);
  if (
    !data ||
    Object.keys(data).some((key) => key !== "operations") ||
    !Array.isArray(data.operations) ||
    !data.operations.length ||
    data.operations.length > 80
  ) {
    throw new Error("Expected 1–80 native operations");
  }
  const originals = new Map(original.map((element) => [element.id, element]));
  const updated = new Map<string, NonDeletedExcalidrawElement>();
  const created: NonDeletedExcalidrawElement[] = [];
  const references = new Map([...selectedIds].map((id) => [id, id]));
  const connectorTargets = new Map<string, { start?: string; end?: string }>();
  for (const spec of data.operations as Spec[]) {
    if (
      !spec ||
      Object.keys(spec).some((key) => !keys.has(key)) ||
      !types.includes(spec.type) ||
      !["create", "update"].includes(spec.action)
    ) {
      throw new Error("Unsupported native operation");
    }
    const candidate =
      spec.action === "update" ? originals.get(spec.targetId || "") : undefined;
    const previous =
      candidate && !candidate.isDeleted
        ? (candidate as NonDeletedExcalidrawElement)
        : undefined;
    if (
      spec.action === "update" &&
      (!previous ||
        previous.isDeleted ||
        previous.locked ||
        !selectedIds.has(previous.id) ||
        updated.has(previous.id))
    ) {
      throw new Error(
        "AI can only edit selected, unlocked objects once per proposal",
      );
    }
    if (spec.action === "create" && spec.targetId) {
      throw new Error("New objects cannot overwrite IDs");
    }
    const type = spec.type === "polygon" ? "line" : spec.type;
    if (previous?.customData?.ringSegment) {
      throw new Error("Editing ring segment metadata is not supported yet");
    }
    for (const key of ["startTarget", "endTarget"] as const) {
      if (
        spec[key] !== undefined &&
        (typeof spec[key] !== "string" || !spec[key] || spec[key]!.length > 128)
      ) {
        throw new Error("Invalid arrow reference");
      }
    }
    if ((spec.startTarget || spec.endTarget) && type !== "arrow") {
      throw new Error("Only arrows can have connection targets");
    }
    if (
      spec.ref !== undefined &&
      (spec.action !== "create" ||
        !/^[a-z0-9_-]{1,64}$/i.test(spec.ref) ||
        references.has(spec.ref))
    ) {
      throw new Error("Invalid or duplicate object reference");
    }
    if (previous && previous.type !== type) {
      throw new Error("AI cannot change an existing object's type");
    }
    for (const key of ["x", "y"] as const) {
      if (!number(spec[key], -100000, 100000)) {
        throw new Error("Invalid position");
      }
    }
    for (const key of ["width", "height"] as const) {
      if (!number(spec[key], 0, 10000)) {
        throw new Error("Invalid dimensions");
      }
    }
    if (!spec.width && !spec.height) {
      throw new Error("Empty geometry");
    }
    for (const key of ["strokeColor", "backgroundColor"] as const) {
      if (
        spec[key] !== undefined &&
        !/^(#[0-9a-f]{6}|transparent)$/i.test(spec[key]!)
      ) {
        throw new Error("Colors must be hex values or transparent");
      }
    }
    for (const [key, min, max] of [
      ["strokeWidth", 1, 10],
      ["roughness", 0, 2],
      ["opacity", 0, 100],
      ["fontSize", 8, 120],
    ] as const) {
      if (spec[key] !== undefined && !number(spec[key], min, max)) {
        throw new Error("Invalid style value");
      }
    }
    const style = {
      strokeColor: spec.strokeColor ?? previous?.strokeColor ?? "#1e1e1e",
      backgroundColor:
        spec.backgroundColor ?? previous?.backgroundColor ?? "transparent",
      strokeWidth: spec.strokeWidth ?? previous?.strokeWidth ?? 2,
      roughness: spec.roughness ?? previous?.roughness ?? 1,
      opacity: spec.opacity ?? previous?.opacity ?? 100,
      fillStyle: previous?.fillStyle ?? ("solid" as const),
    };
    const geometry = {
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: spec.height,
    };
    let next: NonDeletedExcalidrawElement;
    if (type === "text") {
      if (
        typeof spec.text !== "string" ||
        !spec.text.trim() ||
        spec.text.length > 10000
      ) {
        throw new Error("Invalid native text");
      }
      next = newTextElement({
        ...geometry,
        ...style,
        text: spec.text,
        fontSize:
          spec.fontSize ?? (previous?.type === "text" ? previous.fontSize : 20),
        ...(previous?.type === "text"
          ? { fontFamily: previous.fontFamily }
          : {}),
      });

      if (previous?.type === "text") {
        next = newElementWith(deepCopyElement(previous), {
          ...geometry,
          ...style,
          text: next.text,
          originalText: next.originalText,
          fontSize: next.fontSize,
          width: next.width,
          height: next.height,
        });
      }
    } else if (type === "line" || type === "arrow") {
      if (
        !Array.isArray(spec.points) ||
        spec.points.length < 2 ||
        spec.points.length > 500 ||
        spec.points.some(
          (point) =>
            !Array.isArray(point) ||
            point.length !== 2 ||
            !point.every((value) => number(value, -10000, 10000)),
        ) ||
        spec.points[0][0] !== 0 ||
        spec.points[0][1] !== 0
      ) {
        throw new Error("Invalid editable contour points");
      }
      const points = spec.points.map(([x, y]) => pointFrom<LocalPoint>(x, y));
      if (spec.type === "polygon") {
        if (new Set(points.map((point) => point.join(","))).size < 3) {
          throw new Error("Polygon needs at least three vertices");
        }
        if (points.at(-1)![0] !== 0 || points.at(-1)![1] !== 0) {
          points.push(pointFrom<LocalPoint>(0, 0));
        }
      }
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      geometry.width = Math.max(...xs) - Math.min(...xs);
      geometry.height = Math.max(...ys) - Math.min(...ys);
      if (!geometry.width && !geometry.height) {
        throw new Error("Empty contour");
      }
      next =
        type === "arrow"
          ? newArrowElement({
              ...geometry,
              ...style,
              type,
              points,
              endArrowhead: "arrow",
            })
          : newLinearElement({
              ...geometry,
              ...style,
              type,
              points,
              polygon: spec.type === "polygon",
            });
      if (previous && isLineElement(previous)) {
        next = newElementWith(deepCopyElement(previous), {
          ...geometry,
          ...style,
          points,
          polygon: spec.type === "polygon",
        });
      }
      if (previous && isArrowElement(previous)) {
        if (previous.elbowed) {
          throw new Error("Editing elbow arrows is not supported yet");
        }
        next = newElementWith(deepCopyElement(previous), {
          ...geometry,
          ...style,
          points,
        });
      }
    } else {
      if (!spec.width || !spec.height) {
        throw new Error("Shape needs width and height");
      }
      next = newElement({ ...geometry, ...style, type });
      if (previous) {
        next = newElementWith(deepCopyElement(previous), {
          ...geometry,
          ...style,
        }) as NonDeletedExcalidrawElement;
      }
    }
    if (spec.ref) {
      references.set(spec.ref, next.id);
    }
    if (type === "arrow") {
      connectorTargets.set(next.id, {
        start: spec.startTarget,
        end: spec.endTarget,
      });
    }
    if (previous) {
      updated.set(previous.id, next);
    } else {
      created.push(next);
    }
  }
  const elements = original.map(
    (element) => updated.get(element.id) ?? deepCopyElement(element),
  );
  elements.push(...created);
  const scene = new Scene(syncInvalidIndices(elements));
  try {
    for (const element of updated.values()) {
      updateBoundElements(element, scene, {
        simultaneouslyUpdated: [...updated.values()],
      });
    }
    for (const [id, targets] of connectorTargets) {
      const arrow = scene.getNonDeletedElementsMap().get(id);
      if (!arrow || !isArrowElement(arrow)) {
        continue;
      }
      for (const side of ["start", "end"] as const) {
        const requested = targets[side];
        const targetId = requested
          ? references.get(requested)
          : arrow[side === "start" ? "startBinding" : "endBinding"]?.elementId;
        if (requested && !targetId) {
          throw new Error("Unknown arrow target");
        }
        if (!targetId) {
          continue;
        }
        const target = scene.getNonDeletedElementsMap().get(targetId);
        if (!target || !isBindableElement(target)) {
          throw new Error("Arrow target cannot accept bindings");
        }
        bindBindingElement(arrow, target, "orbit", side, scene, {
          value: 1 as AppState["zoom"]["value"],
        });
      }
    }
    const result = [...scene.getElementsIncludingDeleted()];
    const changed = result.filter(
      (element) =>
        !element.isDeleted &&
        (updated.has(element.id) ||
          created.some((createdElement) => createdElement.id === element.id) ||
          originals.get(element.id)?.version !== element.version),
    ) as NonDeletedExcalidrawElement[];
    return {
      elements: result,
      changed,
      createdCount: created.length,
      updatedCount: updated.size,
    };
  } finally {
    scene.destroy();
  }
}

export const nativeProposalCanApply = (
  baseline: readonly ExcalidrawElement[],
  current: readonly ExcalidrawElement[],
) => {
  const map = new Map(current.map((element) => [element.id, element]));
  return baseline.every((element) => {
    const latest = map.get(element.id);
    return (
      latest &&
      latest.version === element.version &&
      latest.versionNonce === element.versionNonce &&
      latest.isDeleted === element.isDeleted
    );
  });
};

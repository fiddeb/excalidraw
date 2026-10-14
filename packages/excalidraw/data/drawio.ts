import { deflateRaw } from "pako";

import { arrayToMap, isTransparent } from "@excalidraw/common";
import { getGlobalFixedPointForBindableElement } from "@excalidraw/element/binding";

import { getCommonBounds } from "@excalidraw/element/bounds";
import { LinearElementEditor } from "@excalidraw/element/linearElementEditor";
import {
  isLineElement,
  isArrowElement,
  isBindableContour,
} from "@excalidraw/element/typeChecks";
import { getLineOperationPoints } from "@excalidraw/element/lineOperations";

import type {
  ExcalidrawElement,
  AnyArrowhead,
} from "@excalidraw/element/types";

import type { BinaryFiles } from "../types";

export type DrawioWarning =
  | "appearance"
  | "fonts"
  | "contours"
  | "freedraw"
  | "frames"
  | "boundText"
  | "groups"
  | "unsupported"
  | "images"
  | "bindings";

const xml = (value: string) =>
  value
    // XML 1.0 excludes these control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
const number = (value: number) => {
  if (!Number.isFinite(value)) {
    throw new Error("Invalid drawing coordinates");
  }
  return String(Math.round(value * 1000) / 1000);
};
const point = (x: number, y: number, as?: string) =>
  `<mxPoint x="${number(x)}" y="${number(y)}"${as ? ` as="${as}"` : ""}/>`;

const marker = (head: AnyArrowhead | null) => {
  switch (head) {
    case "arrow":
      return ["open", 0];
    case "bar":
      return ["dash", 0];
    case "circle":
    case "dot":
      return ["oval", 1];
    case "circle_outline":
      return ["oval", 0];
    case "triangle":
      return ["block", 1];
    case "triangle_outline":
      return ["block", 0];
    case "diamond":
      return ["diamond", 1];
    case "diamond_outline":
      return ["diamond", 0];
    case "cardinality_one":
    case "crowfoot_one":
      return ["ERone", 0];
    case "cardinality_many":
    case "crowfoot_many":
      return ["ERmany", 0];
    case "cardinality_one_or_many":
    case "crowfoot_one_or_many":
      return ["ERoneToMany", 0];
    case "cardinality_exactly_one":
      return ["ERmandOne", 0];
    case "cardinality_zero_or_one":
      return ["ERzeroToOne", 0];
    case "cardinality_zero_or_many":
      return ["ERzeroToMany", 0];
    default:
      return ["none", 0];
  }
};

/** Native mxGraph cells. No drawing data is sent to a conversion service. */
export const exportToDrawio = (
  source: readonly ExcalidrawElement[],
  files: BinaryFiles,
  options: { name: string; encodeBase64: (binary: string) => string },
) => {
  const warnings = new Set<DrawioWarning>();
  let skipped = 0;
  const elements = source.filter((element) => {
    if (element.isDeleted) {
      return false;
    }
    if (
      ["embeddable", "iframe", "magicframe", "selection"].includes(element.type)
    ) {
      warnings.add("unsupported");
      skipped++;
      return false;
    }
    if (
      element.type === "image" &&
      (element.crop ||
        !element.fileId ||
        !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(
          files[element.fileId]?.dataURL || "",
        ))
    ) {
      warnings.add("images");
      skipped++;
      return false;
    }
    return true;
  });
  const ids = new Map(elements.map((element, i) => [element.id, `e${i}`]));
  const elementsMap = arrayToMap(elements);
  const cells: string[] = ['<mxCell id="0"/><mxCell id="1" parent="0"/>'];
  const bounds = elements.length ? getCommonBounds(elements) : [0, 0, 0, 0];
  const origin = [bounds[0] - 20, bounds[1] - 20];
  const groups = new Map<string, { id: string; x: number; y: number }>();
  const ensureGroup = (groupIds: readonly string[]): string => {
    const key = groupIds[0];
    if (!key) {
      return "1";
    }
    const cached = groups.get(key);
    if (cached) {
      return cached.id;
    }
    const parent = ensureGroup(groupIds.slice(1));
    const members = elements.filter((element) =>
      element.groupIds.includes(key),
    );
    const [x, y, right, bottom] = getCommonBounds(members);
    const parentOrigin = groups.get(groupIds[1]) || {
      x: origin[0],
      y: origin[1],
    };
    const group = { id: `g${groups.size}`, x, y };
    groups.set(key, group);
    cells.push(
      `<mxCell id="${
        group.id
      }" value="" style="group;" vertex="1" connectable="0" parent="${parent}"><mxGeometry x="${number(
        x - parentOrigin.x,
      )}" y="${number(y - parentOrigin.y)}" width="${number(
        right - x,
      )}" height="${number(bottom - y)}" as="geometry"/></mxCell>`,
    );
    return group.id;
  };
  const color = (value: string, kind: "fill" | "stroke") => {
    if (isTransparent(value)) {
      return `${kind}Color=none;`;
    }
    if (/^#[\da-f]{8}$/i.test(value)) {
      return `${kind}Color=${value.slice(0, 7)};${kind}Opacity=${number(
        (parseInt(value.slice(7), 16) / 255) * 100,
      )};`;
    }
    // Do not allow color values to inject additional mxGraph style entries.
    return `${kind}Color=${
      /^#[\da-f]{3,6}$/i.test(value) || /^[a-z]+$/i.test(value) ? value : "none"
    };`;
  };
  for (const element of elements) {
    const parent = ensureGroup(element.groupIds);
    const offset = groups.get(element.groupIds[0]) || {
      x: origin[0],
      y: origin[1],
    };
    if (element.groupIds.length) {
      warnings.add("groups");
    }
    if (
      element.roughness ||
      (!isTransparent(element.backgroundColor) && element.fillStyle !== "solid")
    ) {
      warnings.add("appearance");
    }
    let style = `${color(element.strokeColor, "stroke")}${color(
      element.backgroundColor,
      "fill",
    )}strokeWidth=${number(element.strokeWidth)};opacity=${number(
      element.opacity,
    )};html=0;whiteSpace=wrap;`;
    if (element.strokeStyle !== "solid") {
      style += `dashed=1;dashPattern=${
        element.strokeStyle === "dotted" ? "1 3" : "8 8"
      };`;
    }
    let value = "";
    let edge = false;
    let terminals = "";
    let geometry = `<mxGeometry x="${number(element.x - offset.x)}" y="${number(
      element.y - offset.y,
    )}" width="${number(element.width)}" height="${number(
      element.height,
    )}" as="geometry"/>`;
    if (
      isLineElement(element) ||
      isArrowElement(element) ||
      element.type === "freedraw"
    ) {
      const points =
        element.type === "freedraw"
          ? element.points.map(([x, y]) => {
              const cx = element.width / 2;
              const cy = element.height / 2;
              return [
                element.x +
                  cx +
                  (x - cx) * Math.cos(element.angle) -
                  (y - cy) * Math.sin(element.angle),
                element.y +
                  cy +
                  (x - cx) * Math.sin(element.angle) +
                  (y - cy) * Math.cos(element.angle),
              ];
            })
          : isLineElement(element)
          ? getLineOperationPoints(element, elementsMap)
          : LinearElementEditor.getPointsGlobalCoordinates(
              element,
              elementsMap,
            );
      if (!points.length) {
        throw new Error("Empty path");
      }
      if (element.type === "freedraw") {
        warnings.add("freedraw");
      }
      const closed =
        isLineElement(element) &&
        (element.polygon ||
          (points.length > 2 &&
            points[0][0] === points[points.length - 1][0] &&
            points[0][1] === points[points.length - 1][1]));
      if (closed) {
        warnings.add("contours");
        const minX = Math.min(...points.map((p) => p[0]));
        const minY = Math.min(...points.map((p) => p[1]));
        const width = Math.max(
          0.001,
          Math.max(...points.map((p) => p[0])) - minX,
        );
        const height = Math.max(
          0.001,
          Math.max(...points.map((p) => p[1])) - minY,
        );
        const path = points
          .map(
            ([x, y], i) =>
              `<${i ? "line" : "move"} x="${number(
                ((x - minX) / width) * 100,
              )}" y="${number(((y - minY) / height) * 100)}"/>`,
          )
          .join("");
        const stencil = `<shape w="100" h="100" aspect="variable" strokewidth="inherit"><foreground><path>${path}<close/></path><fillstroke/></foreground></shape>`;
        const binary = Array.from(
          deflateRaw(encodeURIComponent(stencil)),
          (byte) => String.fromCharCode(byte),
        ).join("");
        style += `shape=stencil(${options.encodeBase64(binary)});`;
        geometry = `<mxGeometry x="${number(minX - offset.x)}" y="${number(
          minY - offset.y,
        )}" width="${number(width)}" height="${number(
          height,
        )}" as="geometry"/>`;
      } else {
        edge = true;
        style += "edgeStyle=none;rounded=0;fillColor=none;";
        const start = marker(
          isArrowElement(element) ? element.startArrowhead : null,
        );
        const end = marker(
          isArrowElement(element) ? element.endArrowhead : null,
        );
        style += `startArrow=${start[0]};startFill=${start[1]};endArrow=${end[0]};endFill=${end[1]};`;
        if (isArrowElement(element)) {
          if (element.roundness && !element.elbowed) {
            style += "curved=1;";
          }
          for (const [binding, name, prefix] of [
            [element.startBinding, "source", "exit"],
            [element.endBinding, "target", "entry"],
          ] as const) {
            if (binding && ids.has(binding.elementId)) {
              terminals += ` ${name}="${ids.get(binding.elementId)}"`;
              let [fixedX, fixedY] = binding.fixedPoint;
              const target = elementsMap.get(binding.elementId);
              if (isBindableContour(target)) {
                const anchor = getGlobalFixedPointForBindableElement(
                  binding.fixedPoint,
                  target,
                  elementsMap,
                );
                const points = getLineOperationPoints(target, elementsMap);
                const xs = points.map((point) => point[0]);
                const ys = points.map((point) => point[1]);
                const minX = Math.min(...xs);
                const minY = Math.min(...ys);
                fixedX =
                  (anchor[0] - minX) / Math.max(0.001, Math.max(...xs) - minX);
                fixedY =
                  (anchor[1] - minY) / Math.max(0.001, Math.max(...ys) - minY);
              }
              style += `${prefix}X=${number(fixedX)};${prefix}Y=${number(
                fixedY,
              )};${prefix}Perimeter=0;`;
              warnings.add("bindings");
            }
          }
        }
        geometry = `<mxGeometry relative="1" as="geometry">${point(
          points[0][0] - offset.x,
          points[0][1] - offset.y,
          "sourcePoint",
        )}${point(
          points[points.length - 1][0] - offset.x,
          points[points.length - 1][1] - offset.y,
          "targetPoint",
        )}<Array as="points">${points
          .slice(1, -1)
          .map(([x, y]) => point(x - offset.x, y - offset.y))
          .join("")}</Array></mxGeometry>`;
      }
    } else {
      style += `rotation=${number((element.angle * 180) / Math.PI)};`;
      switch (element.type) {
        case "text":
          warnings.add("fonts");
          if (element.containerId) {
            warnings.add("boundText");
          }
          value = element.text;
          style += `shape=text;strokeColor=none;fillColor=none;fontColor=${
            /^#[\da-f]{3,8}$/i.test(element.strokeColor)
              ? element.strokeColor.slice(0, 7)
              : "#000000"
          };fontSize=${number(element.fontSize)};fontFamily=${
            element.fontFamily === 3 ? "monospace" : "Helvetica"
          };align=${
            element.textAlign
          };verticalAlign=top;spacing=0;overflow=fill;`;
          break;
        case "ellipse":
          style += "shape=ellipse;";
          break;
        case "diamond":
          style += "shape=rhombus;";
          break;
        case "image":
          style += `shape=image;imageAspect=0;aspect=fixed;image=${files[
            element.fileId!
          ].dataURL.replace(";base64", "")};flipH=${
            element.scale[0] < 0 ? 1 : 0
          };flipV=${element.scale[1] < 0 ? 1 : 0};`;
          break;
        case "frame":
          warnings.add("frames");
          value = element.name || "";
          style +=
            "fillColor=none;verticalAlign=top;labelPosition=center;verticalLabelPosition=top;";
          break;
        default:
          style += `rounded=${element.roundness ? 1 : 0};`;
      }
    }
    const cell = `<mxCell${
      element.link ? "" : ` id="${ids.get(element.id)}" value="${xml(value)}"`
    } style="${xml(style)}" ${
      edge ? "edge" : "vertex"
    }="1" parent="${parent}"${terminals}>${geometry}</mxCell>`;
    // Only inert web links are carried across, never active URL schemes.
    cells.push(
      element.link
        ? `<object id="${ids.get(element.id)}" label="${xml(value)}"${
            /^https?:\/\//i.test(element.link)
              ? ` link="${xml(element.link)}"`
              : ""
          }>${cell}</object>`
        : cell,
    );
  }
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?><mxfile host="Excalidraw" compressed="false"><diagram id="page1" name="${xml(
      options.name,
    )}"><mxGraphModel grid="1" page="0"><root>${cells.join(
      "",
    )}</root></mxGraphModel></diagram></mxfile>`,
    count: elements.length,
    skipped,
    warnings: [...warnings],
  };
};

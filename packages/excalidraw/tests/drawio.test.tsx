import fs from "fs";

import { inflateRaw } from "pako";

import { CaptureUpdateAction } from "@excalidraw/element";

import { pointFrom } from "@excalidraw/math";

import { booleanShapes } from "@excalidraw/element/booleanOperations";

import type { LocalPoint, Radians } from "@excalidraw/math";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import * as filesystem from "../data/filesystem";

import { exportToDrawio } from "../data/drawio";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { render, screen, fireEvent, waitFor } from "./test-utils";

import type { BinaryFiles } from "../types";

const convert = (
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles = {},
) =>
  exportToDrawio(elements, files, {
    name: 'Diagram & "åäö"',
    encodeBase64: (value) => window.btoa(value),
  });
const parse = (elements: readonly ExcalidrawElement[], files?: BinaryFiles) => {
  const result = convert(elements, files);
  const document = new DOMParser().parseFromString(
    result.xml,
    "application/xml",
  );
  expect(document.querySelector("parsererror")).toBeNull();
  return { ...result, document };
};
const pts = (...points: [number, number][]) =>
  points.map(([x, y]) => pointFrom<LocalPoint>(x, y));
const rect = (id: string, x = 0, y = 0) =>
  API.createElement({
    id,
    type: "rectangle",
    x,
    y,
    width: 120,
    height: 80,
    backgroundColor: "#a5d8ff",
    fillStyle: "solid",
    roughness: 0,
  });

describe("draw.io export", () => {
  it("exports editable native shapes, escaped multiline text and safe links", () => {
    const rectangle = {
      ...rect("0", -100, -50),
      angle: (Math.PI / 6) as Radians,
    };
    const ellipse = API.createElement({ id: "1", type: "ellipse", x: 200 });
    const diamond = API.createElement({ type: "diamond", x: 400 });
    const text = {
      ...API.createElement({
        type: "text",
        text: '<script> & "Hej åäö"\nNästa rad',
        x: 10,
      }),
      link: "https://example.org/?a=1&b=2",
    };
    const { document } = parse([rectangle, ellipse, diamond, text]);
    expect(
      document.querySelector('mxCell[id="e0"]')?.getAttribute("style"),
    ).toContain("rotation=30;");
    expect(
      document.querySelector('mxCell[id="e1"]')?.getAttribute("style"),
    ).toContain("shape=ellipse;");
    expect(
      document.querySelector('mxCell[id="e2"]')?.getAttribute("style"),
    ).toContain("shape=rhombus;");
    expect(
      document.querySelector('object[id="e3"]')?.getAttribute("label"),
    ).toBe(text.text);
    expect(
      document.querySelector('object[id="e3"]')?.getAttribute("link"),
    ).toBe(text.link);
    expect(document.querySelector("script")).toBeNull();
    expect(
      document.querySelector('mxCell[id="e0"] mxGeometry')?.getAttribute("x"),
    ).toBeDefined();
    const cellIds = [...document.querySelectorAll("[id]")].map(
      (node) => node.id,
    );
    expect(new Set(cellIds).size).toBe(cellIds.length);
    expect(document.querySelector("diagram")?.getAttribute("name")).toBe(
      'Diagram & "åäö"',
    );
  });
  it("retains arrow terminals, markers and waypoints; detaches missing targets", () => {
    const a = rect("a");
    const b = rect("b", 300);
    const arrow = API.createElement({
      type: "arrow",
      x: 120,
      y: 40,
      points: pts([0, 0], [60, 20], [180, 0]),
      startArrowhead: "circle_outline",
      endArrowhead: "triangle",
      startBinding: { elementId: a.id, fixedPoint: [1, 0.5], mode: "orbit" },
      endBinding: { elementId: b.id, fixedPoint: [0, 0.5], mode: "orbit" },
    });
    const { document } = parse([a, b, arrow]);
    const cell = document.querySelector('mxCell[id="e2"]')!;
    expect(cell.getAttribute("source")).toBe("e0");
    expect(cell.getAttribute("target")).toBe("e1");
    expect(cell.getAttribute("style")).toContain("endArrow=block;endFill=1;");
    expect(cell.getAttribute("style")).toContain(
      "startArrow=oval;startFill=0;",
    );
    expect(cell.querySelectorAll('Array[as="points"] mxPoint')).toHaveLength(1);
    const detached = parse([arrow]).document.querySelector('mxCell[id="e0"]')!;
    expect(detached.hasAttribute("source")).toBe(false);
    expect(detached.hasAttribute("target")).toBe(false);
    expect(detached.querySelectorAll('mxPoint[as="sourcePoint"]')).toHaveLength(
      1,
    );
  });
  it("keeps nested group coordinates relative to their parent", () => {
    const a = { ...rect("a", -120, 300), groupIds: ["inner", "outer"] };
    const b = { ...rect("b", 200, 300), groupIds: ["outer"] };
    const { document } = parse([a, b]);
    const parent = document
      .querySelector('mxCell[id="e0"]')!
      .getAttribute("parent");
    const inner = document.querySelector(`mxCell[id="${parent}"]`)!;
    expect(inner.getAttribute("parent")).toBe("g0");
    expect(inner.querySelector("mxGeometry")?.getAttribute("x")).toBe("0");
    expect(
      document.querySelector('mxCell[id="e1"] mxGeometry')?.getAttribute("x"),
    ).toBe("320");
  });
  it("preserves transparent holes as compressed vector stencil paths", () => {
    const result = booleanShapes(
      [
        API.createElement({
          type: "ellipse",
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          backgroundColor: "#ff0000",
          fillStyle: "solid",
        }),
        API.createElement({
          type: "ellipse",
          x: 50,
          y: 50,
          width: 100,
          height: 100,
        }),
      ],
      "difference",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const converted = parse(result.elements);
    expect(converted.count).toBe(3);
    const style = converted.document
      .querySelector('mxCell[id="e0"]')!
      .getAttribute("style")!;
    const encoded = style.match(/shape=stencil\(([^)]+)\)/)![1];
    const stencil = decodeURIComponent(
      inflateRaw(
        Uint8Array.from(window.atob(encoded), (c) => c.charCodeAt(0)),
        { to: "string" },
      ),
    );
    const shape = new DOMParser().parseFromString(stencil, "application/xml");
    expect(shape.querySelector("parsererror")).toBeNull();
    expect(shape.querySelectorAll("line").length).toBeGreaterThan(30);
    expect(shape.querySelector("close")).not.toBeNull();
    expect(style).toContain("strokeColor=none;");
    expect(
      converted.document
        .querySelector('mxCell[id="e1"]')
        ?.getAttribute("style"),
    ).toContain("fillColor=none;");
    expect(converted.warnings).toContain("contours");
  });
  it("embeds supported images without external URLs and reports missing/cropped images", () => {
    const fileId = "image" as FileId;
    const image = API.createElement({ type: "image", fileId });
    const files = {
      [fileId]: {
        id: fileId,
        dataURL: "data:image/png;base64,aGVsbG8=",
        mimeType: "image/png",
        created: 1,
      },
    } as BinaryFiles;
    expect(
      parse([image], files)
        .document.querySelector('mxCell[id="e0"]')
        ?.getAttribute("style"),
    ).toContain("image=data:image/png,aGVsbG8=;");
    const result = convert([image]);
    expect(result.skipped).toBe(1);
    expect(result.warnings).toContain("images");
  });
  it("reports unsupported objects and appearance changes, without touching the scene", () => {
    const elements = [
      rect("a"),
      API.createElement({ type: "embeddable" }),
      API.createElement({ type: "rectangle", isDeleted: true }),
      API.createElement({ type: "freedraw", points: pts([0, 0], [10, 10]) }),
    ];
    const before = JSON.stringify(elements);
    const result = convert(elements);
    expect(result.count).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.warnings).toEqual(
      expect.arrayContaining(["unsupported", "freedraw"]),
    );
    expect(JSON.stringify(elements)).toBe(before);
  });
  it("rejects invalid geometry instead of generating corrupt XML", () => {
    expect(() => convert([{ ...rect("a"), x: NaN }])).toThrow();
  });
  it("exports a public synthetic fixture for the real draw.io compatibility test", () => {
    const a = rect("a");
    const b = API.createElement({
      type: "ellipse",
      x: 300,
      y: 0,
      width: 120,
      height: 80,
      backgroundColor: "#b2f2bb",
      fillStyle: "solid",
      roughness: 0,
    });
    const text = API.createElement({
      type: "text",
      x: 20,
      y: 25,
      text: "Test åäö",
      fontFamily: 2,
      fontSize: 20,
    });
    const arrow = API.createElement({
      type: "arrow",
      x: 120,
      y: 40,
      points: pts([0, 0], [180, 0]),
      endArrowhead: "triangle",
      startBinding: { elementId: a.id, fixedPoint: [1, 0.5], mode: "orbit" },
      endBinding: { elementId: b.id, fixedPoint: [0, 0.5], mode: "orbit" },
      roughness: 0,
    });
    const holes = booleanShapes(
      [
        API.createElement({
          type: "ellipse",
          x: 50,
          y: 180,
          width: 140,
          height: 140,
          backgroundColor: "#ffa8a8",
          fillStyle: "solid",
          roughness: 0,
        }),
        API.createElement({
          type: "ellipse",
          x: 90,
          y: 220,
          width: 60,
          height: 60,
          roughness: 0,
        }),
      ],
      "difference",
    );
    if (!holes.ok) {
      throw new Error("Fixture failed");
    }
    const elements = [a, b, text, arrow, ...holes.elements];
    const result = parse(elements);
    fs.writeFileSync("/private/tmp/excalidraw-drawio-test.drawio", result.xml);
    fs.writeFileSync(
      "/private/tmp/excalidraw-drawio-test.json",
      JSON.stringify({ type: "excalidraw/clipboard", elements, files: {} }),
    );
  });
  it("opens the export dialog and includes the selected container's bound text", async () => {
    expect(CaptureUpdateAction.EVENTUALLY).toBeDefined();
    const a = rect("a");
    const text = API.createElement({
      type: "text",
      text: "Bound",
      containerId: a.id,
    });
    await render(
      <Excalidraw
        initialData={{
          elements: [
            { ...a, boundElements: [{ id: text.id, type: "text" }] },
            text,
          ],
          appState: {
            selectedElementIds: { [a.id]: true },
            openDialog: { name: "drawioExport" },
          },
        }}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("2 elements exported; 0 omitted."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/Bound text becomes/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() =>
      expect(screen.queryByText("Download .drawio")).not.toBeInTheDocument(),
    );
  });
  it("downloads XML with the drawio extension and leaves drawing data intact", async () => {
    const save = vi.spyOn(filesystem, "fileSave").mockResolvedValue(null);
    const a = rect("download-test");
    await render(
      <Excalidraw
        initialData={{
          elements: [a],
          appState: { openDialog: { name: "drawioExport" } },
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Download .drawio")).toBeEnabled(),
    );
    fireEvent.click(screen.getByText("Download .drawio"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [blob, options] = save.mock.calls[0];
    expect(options.extension).toBe("drawio");
    expect(options.mimeTypes).toEqual(["application/xml"]);
    expect(blob).toBeInstanceOf(Blob);
    const contents = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blob as Blob);
    });
    expect(
      new DOMParser()
        .parseFromString(contents, "application/xml")
        .querySelector('mxCell[id="e0"]'),
    ).not.toBeNull();
    await waitFor(() =>
      expect(screen.queryByText("Download .drawio")).not.toBeInTheDocument(),
    );
    expect(window.h.elements).toHaveLength(1);
    expect(window.h.elements[0].id).toBe(a.id);
    save.mockRestore();
  });
});

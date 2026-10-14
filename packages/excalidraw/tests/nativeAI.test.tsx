import { CaptureUpdateAction } from "@excalidraw/element";
import { newElementWith } from "@excalidraw/element/mutateElement";

import {
  nativeProposalCanApply,
  prepareNativeProposal,
} from "../../../excalidraw-app/nativeAI";
import { Excalidraw } from "../index";

import { render, act, waitFor } from "./test-utils";
import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";

const { h } = window;
const source = (operations: unknown[]) => JSON.stringify({ operations });
const rect = (extra = {}) => ({
  action: "create",
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ...extra,
});

describe("native AI proposals", () => {
  it("creates editable custom contours and arrows bound to created shapes", () => {
    const result = prepareNativeProposal(
      source([
        rect({ ref: "box" }),
        {
          action: "create",
          ref: "triangle",
          type: "polygon",
          x: 200,
          y: 0,
          width: 100,
          height: 100,
          points: [
            [0, 0],
            [100, 50],
            [0, 100],
            [0, 0],
          ],
          backgroundColor: "#a5d8ff",
        },
        {
          action: "create",
          type: "arrow",
          x: 100,
          y: 30,
          width: 100,
          height: 20,
          points: [
            [0, 0],
            [100, 20],
          ],
          startTarget: "box",
          endTarget: "triangle",
        },
      ]),
      [],
      new Set(),
    );
    const [box, polygon, arrow] = result.changed;
    expect(polygon.type).toBe("line");
    expect(polygon).toMatchObject({
      polygon: true,
      backgroundColor: "#a5d8ff",
    });
    expect(arrow).toMatchObject({
      type: "arrow",
      startBinding: { elementId: box.id },
      endBinding: { elementId: polygon.id },
    });
    expect(box.boundElements).toContainEqual({ id: arrow.id, type: "arrow" });
  });

  it("updates a selected shape and its attached arrow without mutating the original scene", () => {
    const initial = prepareNativeProposal(
      source([
        rect({ ref: "box" }),
        {
          action: "create",
          type: "arrow",
          x: 100,
          y: 30,
          width: 100,
          height: 0,
          points: [
            [0, 0],
            [100, 0],
          ],
          startTarget: "box",
        },
      ]),
      [],
      new Set(),
    ).elements;
    const box = initial[0];
    const before = JSON.stringify(initial);
    const result = prepareNativeProposal(
      source([
        rect({
          action: "update",
          targetId: box.id,
          x: 40,
          strokeColor: "#ff0000",
        }),
      ]),
      initial,
      new Set([box.id]),
    );
    expect(JSON.stringify(initial)).toBe(before);
    expect(result.elements[0]).toMatchObject({
      id: box.id,
      x: 40,
      strokeColor: "#ff0000",
    });
    expect(result.changed.some((element) => element.type === "arrow")).toBe(
      true,
    );
  });

  it("rejects edits outside selection, locked objects, unsafe fields and invalid geometry", () => {
    const box = API.createElement({
      type: "rectangle",
      width: 100,
      height: 60,
    });
    expect(() =>
      prepareNativeProposal(
        source([rect({ action: "update", targetId: box.id })]),
        [box],
        new Set(),
      ),
    ).toThrow(/selected/);
    expect(() =>
      prepareNativeProposal(
        source([rect({ action: "update", targetId: box.id })]),
        [{ ...box, locked: true }],
        new Set([box.id]),
      ),
    ).toThrow(/unlocked/);
    for (const extra of [
      { link: "https://example.com" },
      { width: -1 },
      { strokeColor: "url(https://example.com)" },
      { action: "delete" },
    ]) {
      expect(() =>
        prepareNativeProposal(source([rect(extra)]), [], new Set()),
      ).toThrow();
    }
    expect(() =>
      prepareNativeProposal(
        source([
          {
            action: "create",
            type: "arrow",
            x: 0,
            y: 0,
            width: 10,
            height: 0,
            points: [
              [0, 0],
              [10, 0],
            ],
            endTarget: "missing",
          },
        ]),
        [],
        new Set(),
      ),
    ).toThrow(/Unknown arrow target/);
  });

  it("refuses stale proposals while permitting unrelated newly created objects", () => {
    const box = API.createElement({ type: "rectangle" });
    expect(
      nativeProposalCanApply(
        [box],
        [box, API.createElement({ type: "ellipse" })],
      ),
    ).toBe(true);
    expect(
      nativeProposalCanApply([box], [newElementWith(box, { x: 100 })]),
    ).toBe(false);
    expect(nativeProposalCanApply([box], [])).toBe(false);
  });

  it("applies native creation as one undoable editor change", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);
    const result = prepareNativeProposal(
      source([
        rect(),
        {
          action: "create",
          type: "text",
          x: 10,
          y: 10,
          width: 80,
          height: 20,
          text: "Native AI",
        },
      ]),
      [],
      new Set(),
    );
    act(() =>
      h.app.updateScene({
        elements: result.elements,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    await waitFor(() =>
      expect(h.elements.filter((element) => !element.isDeleted)).toHaveLength(
        2,
      ),
    );
    Keyboard.undo();
    await waitFor(() =>
      expect(h.elements.filter((element) => !element.isDeleted)).toHaveLength(
        0,
      ),
    );
  });
});

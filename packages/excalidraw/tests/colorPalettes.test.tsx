import { CaptureUpdateAction } from "@excalidraw/element";

import { actionClearCanvas } from "../actions/actionCanvas";
import {
  cleanAppStateForExport,
  clearAppStateForDatabase,
  clearAppStateForLocalStorage,
  getDefaultAppState,
} from "../appState";
import { parsePaletteColors, restoreColorPalettes } from "../colorPalettes";
import { restoreAppState } from "../data/restore";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { fireEvent, render, screen, within, waitFor } from "./test-utils";

const { h } = window;
const link = "https://coolors.co/palette/264653-2a9d8f-e9c46a-f4a261-e76f51";
const palette = {
  id: "coastal",
  name: "Coastal",
  colors: ["#264653", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51"],
};

describe("saved color palettes", () => {
  beforeAll(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterAll(() => vi.unstubAllGlobals());
  it("imports Coolors palette and generator URLs, including shared query parameters", () => {
    expect(parsePaletteColors(link)).toEqual(palette.colors);
    expect(
      parsePaletteColors(`${link.replace("/palette", "")}?ref=share`),
    ).toEqual(palette.colors);
    expect(parsePaletteColors(link.replace("https://", ""))).toEqual(
      palette.colors,
    );
    expect(parsePaletteColors("#ABC, aabbcc; #264653\n#264653")).toEqual([
      "#aabbcc",
      "#264653",
    ]);
  });

  it("rejects discovery pages, unrelated URLs and malformed or excessive colors", () => {
    for (const input of [
      "",
      "https://coolors.co/palettes/trending",
      "https://coolors.co.evil.test/264653-2a9d8f",
      "https://example.com/264653-2a9d8f",
      "#12345 red",
      "https://coolors.co/264653--2a9d8f",
    ]) {
      expect(parsePaletteColors(input)).toBeNull();
    }
    expect(
      parsePaletteColors(
        Array.from({ length: 25 }, (_, i) =>
          i.toString(16).padStart(6, "0"),
        ).join(" "),
      ),
    ).toBeNull();
  });

  it("sanitizes stored palettes and invalid active IDs", () => {
    expect(
      restoreColorPalettes([
        null,
        { ...palette, colors: [42] },
        palette,
        palette,
        { ...palette, id: "invalid", colors: ["oops"] },
      ]),
    ).toEqual([palette]);
    expect(
      restoreAppState(
        { colorPalettes: [palette], activeColorPaletteId: "missing" },
        null,
      ).activeColorPaletteId,
    ).toBeNull();
  });

  it("persists preferences locally and preserves them when importing a drawing", () => {
    const state = {
      ...getDefaultAppState(),
      colorPalettes: [palette],
      activeColorPaletteId: palette.id,
    };
    expect(clearAppStateForLocalStorage(state).colorPalettes).toEqual([
      palette,
    ]);
    expect(cleanAppStateForExport(state)).not.toHaveProperty("colorPalettes");
    expect(cleanAppStateForExport(state)).not.toHaveProperty(
      "activeColorPaletteId",
    );
    expect(clearAppStateForDatabase(state)).not.toHaveProperty("colorPalettes");
    const restored = restoreAppState({ viewBackgroundColor: "#ffffff" }, state);
    expect(restored.colorPalettes).toEqual([palette]);
    expect(restored.activeColorPaletteId).toBe(palette.id);
  });

  it("creates from a link, applies stroke and fill, edits and deletes a palette", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    const rectangle = API.createElement({ type: "rectangle" });
    API.updateScene({
      elements: [rectangle],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([rectangle]);
    API.setAppState({ openPopup: "elementStroke" });
    let section = within(
      screen.getByRole("region", { name: "Saved palettes" }),
    );
    fireEvent.click(section.getByRole("button", { name: "New palette" }));
    fireEvent.change(section.getByLabelText("Palette name"), {
      target: { value: "Coastal" },
    });
    fireEvent.change(
      section.getByLabelText("HEX colors or Coolors palette link"),
      { target: { value: link } },
    );
    fireEvent.click(section.getByRole("button", { name: "Save" }));
    expect(h.state.colorPalettes[0].colors).toEqual(palette.colors);
    fireEvent.click(section.getByRole("button", { name: "#264653" }));
    expect(h.elements[0].strokeColor).toBe("#264653");
    API.setAppState({ openPopup: "elementBackground" });
    section = within(screen.getByRole("region", { name: "Saved palettes" }));
    fireEvent.click(section.getByRole("button", { name: "#e9c46a" }));
    expect(h.elements[0].backgroundColor).toBe("#e9c46a");
    API.setAppState({ openPopup: null });
    Keyboard.undo();
    expect(h.elements[0].backgroundColor).toBe(rectangle.backgroundColor);
    expect(h.state.colorPalettes[0].name).toBe("Coastal");
    Keyboard.redo();
    expect(h.elements[0].backgroundColor).toBe("#e9c46a");
    API.setAppState({ openPopup: "elementBackground" });
    section = within(screen.getByRole("region", { name: "Saved palettes" }));
    fireEvent.click(section.getByRole("button", { name: "Edit" }));
    fireEvent.change(section.getByLabelText("Palette name"), {
      target: { value: "Sunset" },
    });
    fireEvent.change(
      section.getByLabelText("HEX colors or Coolors palette link"),
      { target: { value: "#abc #def" } },
    );
    fireEvent.click(section.getByRole("button", { name: "Save" }));
    expect(h.state.colorPalettes).toEqual([
      {
        id: h.state.activeColorPaletteId,
        name: "Sunset",
        colors: ["#aabbcc", "#ddeeff"],
      },
    ]);
    fireEvent.click(section.getByRole("button", { name: "Delete" }));
    expect(h.state.colorPalettes).toEqual([]);
    expect(h.elements[0].backgroundColor).toBe("#e9c46a");
  });

  it("keeps typed palette hotkeys from changing the drawing and rejects invalid saves", async () => {
    await render(<Excalidraw />);
    API.setAppState({
      openPopup: "elementStroke",
      activeTool: {
        ...h.state.activeTool,
        type: "rectangle",
        customType: null,
      },
    });
    const section = within(
      screen.getByRole("region", { name: "Saved palettes" }),
    );
    fireEvent.click(section.getByRole("button", { name: "New palette" }));
    const input = section.getByLabelText("Palette name");
    const previous = h.state.currentItemStrokeColor;
    fireEvent.keyDown(input, { key: "r" });
    expect(h.state.currentItemStrokeColor).toBe(previous);
    fireEvent.click(section.getByRole("button", { name: "Save" }));
    expect(section.getByRole("alert")).toBeTruthy();
    expect(h.state.colorPalettes).toEqual([]);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(section.queryByLabelText("Palette name")).toBeNull();
    expect(h.state.openPopup).toBe("elementStroke");
  });
  it("keeps palettes when clearing the canvas", async () => {
    await render(<Excalidraw />);
    API.setAppState({
      colorPalettes: [palette],
      activeColorPaletteId: palette.id,
    });
    API.executeAction(actionClearCanvas);
    expect(h.state.colorPalettes).toEqual([palette]);
    expect(h.state.activeColorPaletteId).toBe(palette.id);
  });

  it("offers saved colors in the phone color picker", async () => {
    await render(<Excalidraw UIOptions={{ getFormFactor: () => "phone" }} />);
    fireEvent.resize(window);
    await waitFor(() => expect(h.app.editorInterface.formFactor).toBe("phone"));
    const rectangle = API.createElement({ type: "rectangle" });
    API.setElements([rectangle]);
    API.setSelectedElements([rectangle]);
    API.setAppState({
      colorPalettes: [palette],
      activeColorPaletteId: palette.id,
      openPopup: "elementStroke",
    });
    const section = within(
      screen.getByRole("region", { name: "Saved palettes" }),
    );
    fireEvent.click(section.getByRole("button", { name: "#2a9d8f" }));
    expect(h.elements[0].strokeColor).toBe("#2a9d8f");
  });
  it.each([5, 2, 10])(
    "applies a %i-color palette to both quick-pick rows without recoloring elements",
    async (count) => {
      await render(<Excalidraw />);
      const rectangle = API.createElement({
        type: "rectangle",
        strokeColor: "#123456",
        backgroundColor: "#abcdef",
      });
      const colors = Array.from(
        { length: count },
        (_, i) => `#${(i + 1).toString(16).padStart(6, "0")}`,
      );
      const saved = { ...palette, colors };
      API.setElements([rectangle]);
      API.setSelectedElements([rectangle]);
      API.setAppState({
        colorPalettes: [saved],
        activeColorPaletteId: saved.id,
        openPopup: "elementStroke",
        colorTopPicks: {
          ...h.state.colorTopPicks,
          bucketFill: ["#fedcba"],
          stickyNoteStroke: ["#987654"],
        },
      });
      const section = within(
        screen.getByRole("region", { name: "Saved palettes" }),
      );
      fireEvent.click(
        section.getByRole("button", { name: "Use for Stroke & Background" }),
      );
      const picks = colors.slice(0, 5);
      expect(h.state.colorTopPicks.elementStroke).toEqual(picks);
      expect(h.state.colorTopPicks.elementBackground).toEqual(picks);
      expect(h.state.colorTopPicks.bucketFill).toEqual(["#fedcba"]);
      expect(h.state.colorTopPicks.stickyNoteStroke).toEqual(["#987654"]);
      expect(h.state.colorPalettes[0].colors).toEqual(colors);
      expect(h.elements[0].strokeColor).toBe("#123456");
      expect(h.elements[0].backgroundColor).toBe("#abcdef");
      API.setAppState({ openPopup: null });
      const strips = document.querySelectorAll(".color-picker__top-picks");
      expect(strips.length).toBe(2);
      for (const strip of strips) {
        expect(
          within(strip as HTMLElement)
            .getAllByRole("button")
            .map((button) => button.getAttribute("title")),
        ).toEqual(picks);
      }
      fireEvent.click(
        within(strips[0] as HTMLElement).getByRole("button", {
          name: picks[0],
        }),
      );
      expect(h.elements[0].strokeColor).toBe(picks[0]);
      fireEvent.click(
        within(strips[1] as HTMLElement).getByRole("button", {
          name: picks[1],
        }),
      );
      expect(h.elements[0].backgroundColor).toBe(picks[1]);
      const restored = restoreAppState(
        clearAppStateForLocalStorage(h.state),
        null,
      );
      expect(restored.colorTopPicks.elementStroke).toEqual(picks);
      expect(restored.colorTopPicks.elementBackground).toEqual(picks);
    },
  );
});

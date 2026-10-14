import { getCompoundPolygonGroups } from "@excalidraw/element/polygonContours";
import * as lineOperations from "@excalidraw/element/lineOperations";

import { importEditableSvg, MAX_EDITABLE_SVG_SIZE } from "../data/editableSvg";

describe("large editable SVG imports", () => {
  it("accepts traced files larger than 200 kB with more than 1000 paths", () => {
    const paths = Array.from(
      { length: 1200 },
      (_, index) =>
        `<path transform="translate(${index},0)" d="M0 0 L10 0 L10 10 L0 10 Z" fill="#123456"/>`,
    ).join("");
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><!--${" ".repeat(
      210000,
    )}-->${paths}</svg>`;
    const result = importEditableSvg(source, window.DOMParser);
    expect(result.elements).toHaveLength(1200);
    expect(result.warnings).toEqual([]);
    const geometry = vi.spyOn(lineOperations, "getLineOperationPoints");
    expect(getCompoundPolygonGroups(result.elements).size).toBe(0);
    expect(geometry).not.toHaveBeenCalled();
    geometry.mockRestore();
  });

  it("keeps explicit size and node caps and rejects XML entity declarations", () => {
    expect(() =>
      importEditableSvg(
        " ".repeat(MAX_EDITABLE_SVG_SIZE + 1),
        window.DOMParser,
      ),
    ).toThrow(/5 MB/);
    expect(() =>
      importEditableSvg(
        `<svg xmlns="http://www.w3.org/2000/svg">${"<g/>".repeat(10000)}</svg>`,
        window.DOMParser,
      ),
    ).toThrow(/10000 nodes/);
    expect(() =>
      importEditableSvg(
        '<!DOCTYPE svg SYSTEM "https://example.com"><svg/>',
        window.DOMParser,
      ),
    ).toThrow(/DOCTYPE/);
  });
});

export type SavedColorPalette = {
  id: string;
  name: string;
  colors: string[];
};

export const MAX_SAVED_PALETTES = 20;
export const MAX_PALETTE_COLORS = 24;
export const MAX_PALETTE_NAME_LENGTH = 64;

const normalizeHex = (value: string): string | null => {
  const hex = value.replace(/^#/, "").toLowerCase();
  if (/^[\da-f]{3}$/.test(hex)) {
    return `#${Array.from(hex, (digit) => digit + digit).join("")}`;
  }
  return /^[\da-f]{6}([\da-f]{2})?$/.test(hex) ? `#${hex}` : null;
};

/** Imports concrete Coolors palette/generator links without a network request. */
export const parsePaletteColors = (input: string): string[] | null => {
  let source = input.trim();
  if (!source || source.length > 4096) {
    return null;
  }
  if (/^(?:https?:\/\/|(?:www\.)?coolors\.co\/)/i.test(source)) {
    const match =
      source.match(
        /^https?:\/\/(?:www\.)?coolors\.co\/(?:palette\/)?([\da-f]{6}(?:-[\da-f]{6})*)\/?(?:[?#].*)?$/i,
      ) ||
      source.match(
        /^(?:www\.)?coolors\.co\/(?:palette\/)?([\da-f]{6}(?:-[\da-f]{6})*)\/?(?:[?#].*)?$/i,
      );
    if (!match) {
      return null;
    }
    source = match[1].replace(/-/g, " ");
  }
  const colors = source.split(/[\s,;]+/).map(normalizeHex);
  if (colors.some((color) => color === null)) {
    return null;
  }
  const unique = [...new Set(colors as string[])];
  return unique.length <= MAX_PALETTE_COLORS ? unique : null;
};

export const restoreColorPalettes = (value: unknown): SavedColorPalette[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const palettes: SavedColorPalette[] = [];
  for (const entry of value) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !entry.id ||
      entry.id.length > 128 ||
      palettes.some(({ id }) => id === entry.id) ||
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      !Array.isArray(entry.colors) ||
      !entry.colors.every((color: unknown) => typeof color === "string")
    ) {
      continue;
    }
    const colors = parsePaletteColors(entry.colors.join(" "));
    if (colors) {
      palettes.push({
        id: entry.id,
        name: entry.name.trim().slice(0, MAX_PALETTE_NAME_LENGTH),
        colors,
      });
    }
    if (palettes.length === MAX_SAVED_PALETTES) {
      break;
    }
  }
  return palettes;
};

import clsx from "clsx";
import { useState } from "react";

import {
  applyDarkModeFilter,
  colorToHex,
  COLOR_TOP_PICKS_SLOTS,
  isTransparent,
  randomId,
  THEME,
} from "@excalidraw/common";

import {
  MAX_PALETTE_NAME_LENGTH,
  MAX_SAVED_PALETTES,
  parsePaletteColors,
} from "../../colorPalettes";
import { t } from "../../i18n";
import { useExcalidrawSetAppState } from "../App";

import PickerHeading from "./PickerHeading";
import { useColorPickerDnD } from "./colorTopPicksDnD";

import type { UIAppState } from "../../types";

export const SavedColorPalettes = ({
  appState,
  color,
  onChange,
  excludedColors,
}: {
  appState: UIAppState;
  color: string | null;
  onChange: (color: string) => void;
  excludedColors?: readonly string[];
}) => {
  const setAppState = useExcalidrawSetAppState();
  const dnd = useColorPickerDnD();
  const [draft, setDraft] = useState<{
    id?: string;
    name: string;
    input: string;
  } | null>(null);
  const [error, setError] = useState(false);
  const active = appState.colorPalettes.find(
    ({ id }) => id === appState.activeColorPaletteId,
  );
  const preview = draft ? parsePaletteColors(draft.input) : null;
  const colors = draft ? preview || [] : active?.colors || [];

  const save = () => {
    if (!draft || !preview || !draft.name.trim()) {
      setError(true);
      return;
    }
    const palette = {
      id: draft.id || randomId(),
      name: draft.name.trim(),
      colors: preview,
    };
    setAppState((state) => {
      if (!draft.id && state.colorPalettes.length >= MAX_SAVED_PALETTES) {
        return null;
      }
      return {
        colorPalettes: draft.id
          ? state.colorPalettes.map((entry) =>
              entry.id === draft.id ? palette : entry,
            )
          : [...state.colorPalettes, palette],
        activeColorPaletteId: palette.id,
      };
    });
    setDraft(null);
    setError(false);
  };

  return (
    <section
      className="saved-color-palettes"
      aria-label={t("savedPalettes.title")}
      onKeyDown={(event) => {
        // Keep the picker's color hotkeys from consuming names and URLs.
        if (event.key !== "Escape") {
          event.stopPropagation();
        } else if (draft) {
          event.stopPropagation();
          setDraft(null);
          setError(false);
        }
      }}
    >
      <PickerHeading>{t("savedPalettes.title")}</PickerHeading>
      {!draft && (
        <>
          {!!appState.colorPalettes.length && (
            <select
              aria-label={t("savedPalettes.choose")}
              value={active?.id || ""}
              onChange={(event) =>
                setAppState({
                  activeColorPaletteId: event.target.value || null,
                })
              }
            >
              <option value="">{t("savedPalettes.choose")}</option>
              {appState.colorPalettes.map((palette) => (
                <option key={palette.id} value={palette.id}>
                  {palette.name}
                </option>
              ))}
            </select>
          )}
          <div className="saved-color-palettes__actions">
            <button
              type="button"
              disabled={appState.colorPalettes.length >= MAX_SAVED_PALETTES}
              onClick={() => {
                setError(false);
                setDraft({ name: "", input: "" });
              }}
            >
              {t("savedPalettes.create")}
            </button>
            {active && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setError(false);
                    setDraft({ ...active, input: active.colors.join(" ") });
                  }}
                >
                  {t("savedPalettes.edit")}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setAppState((state) => ({
                      colorPalettes: state.colorPalettes.filter(
                        ({ id }) => id !== active.id,
                      ),
                      activeColorPaletteId: null,
                    }))
                  }
                >
                  {t("savedPalettes.delete")}
                </button>
              </>
            )}
          </div>
          {active && (
            <>
              <div className="saved-color-palettes__actions">
                <button
                  type="button"
                  onClick={() => {
                    const picks = active.colors.slice(0, COLOR_TOP_PICKS_SLOTS);
                    setAppState((state) => ({
                      colorTopPicks: {
                        ...state.colorTopPicks,
                        elementStroke: picks,
                        elementBackground: [...picks],
                      },
                    }));
                  }}
                >
                  {t("savedPalettes.useForBoth")}
                </button>
              </div>
              <p>{t("savedPalettes.topPicksHint")}</p>
            </>
          )}
        </>
      )}
      {draft && (
        <>
          <label>
            {t("savedPalettes.name")}
            <input
              value={draft.name}
              maxLength={MAX_PALETTE_NAME_LENGTH}
              onChange={(event) => {
                setError(false);
                setDraft({ ...draft, name: event.target.value });
              }}
            />
          </label>
          <label>
            {t("savedPalettes.colors")}
            <textarea
              rows={3}
              maxLength={4096}
              placeholder="https://coolors.co/264653-2a9d8f-e9c46a-f4a261-e76f51"
              value={draft.input}
              onChange={(event) => {
                setError(false);
                setDraft({ ...draft, input: event.target.value });
              }}
            />
          </label>
          <div className="saved-color-palettes__actions">
            <button
              type="button"
              disabled={
                !color ||
                !colorToHex(color) ||
                (!!draft.input.trim() && !preview)
              }
              onClick={() => {
                const current = color && colorToHex(color);
                if (current) {
                  setDraft({
                    ...draft,
                    input: [...(preview || []), current].join(" "),
                  });
                  setError(false);
                }
              }}
            >
              {t("savedPalettes.addCurrent")}
            </button>
            <button type="button" onClick={save}>
              {t("savedPalettes.save")}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setError(false);
              }}
            >
              {t("savedPalettes.cancel")}
            </button>
          </div>
          {error && <p role="alert">{t("savedPalettes.invalid")}</p>}
        </>
      )}
      {!!colors.length && (
        <div className="saved-color-palettes__colors">
          {colors.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={swatch}
              aria-pressed={color !== null && colorToHex(color) === swatch}
              disabled={excludedColors?.some(
                (excluded) =>
                  colorToHex(excluded) === swatch ||
                  (isTransparent(excluded) && isTransparent(swatch)),
              )}
              title={swatch}
              className={clsx(
                "color-picker__button color-picker__button--large has-outline",
                {
                  active: color !== null && colorToHex(color) === swatch,
                  "is-transparent": isTransparent(swatch),
                },
              )}
              style={{
                "--swatch-color": applyDarkModeFilter(
                  swatch,
                  appState.theme === THEME.DARK,
                ),
              }}
              onClick={() => onChange(swatch)}
              onPointerDown={
                dnd ? (event) => dnd.startSourceDrag(event, swatch) : undefined
              }
            >
              <div className="color-picker__button-outline" />
            </button>
          ))}
        </div>
      )}
      <a
        href="https://coolors.co/palettes/trending"
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("savedPalettes.coolors")}
      </a>
    </section>
  );
};

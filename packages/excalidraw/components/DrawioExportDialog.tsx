import { useMemo, useState } from "react";

import { exportToDrawio } from "../data/drawio";
import { fileSave } from "../data/filesystem";
import { t } from "../i18n";
import { useUIAppState } from "../context/ui-appState";

import { useApp, useExcalidrawElements } from "./App";
import { Dialog } from "./Dialog";
import DialogActionButton from "./DialogActionButton";

import "./DrawioExportDialog.scss";

export const DrawioExportDialog = ({ onClose }: { onClose: () => void }) => {
  const app = useApp();
  const appState = useUIAppState();
  const elements = useExcalidrawElements();
  const selected = app.scene.getSelectedElements({
    selectedElementIds: appState.selectedElementIds,
    includeBoundTextElement: true,
    includeElementsInFrames: true,
  });
  const [selectionOnly, setSelectionOnly] = useState(!!selected.length);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const result = useMemo(() => {
    try {
      return exportToDrawio(selectionOnly ? selected : elements, app.files, {
        name: app.getName(),
        encodeBase64: (binary) => app.ownerWindow.btoa(binary),
      });
    } catch {
      return null;
    }
  }, [selectionOnly, selected, elements, app]);
  return (
    <Dialog
      title={t("labels.exportDrawio")}
      onCloseRequest={onClose}
      size="regular"
    >
      <div className="DrawioExportDialog">
        <p>{t("drawio.description")}</p>
        <label>
          {t("drawio.scope")}
          <select
            value={selectionOnly ? "selection" : "all"}
            onChange={(event) => {
              setSelectionOnly(event.target.value === "selection");
              setError(false);
            }}
          >
            <option value="all">{t("drawio.all")}</option>
            <option value="selection" disabled={!selected.length}>
              {t("drawio.selection")}
            </option>
          </select>
        </label>
        {result && (
          <div role="status">
            <p>
              {t("drawio.result", {
                count: result.count,
                skipped: result.skipped,
              })}
            </p>
            {!!result.warnings.length && (
              <>
                <p>{t("drawio.changes")}</p>
                <ul>
                  {result.warnings.map((warning) => (
                    <li key={warning}>{t(`drawio.warnings.${warning}`)}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {(!result || error) && <p role="alert">{t("drawio.error")}</p>}
        <p>{t("drawio.instructions")}</p>
        <div className="DrawioExportDialog__buttons">
          <DialogActionButton label={t("buttons.cancel")} onClick={onClose} />
          <DialogActionButton
            label={t("drawio.download")}
            actionType="primary"
            disabled={!result?.count || saving}
            onClick={async () => {
              if (!result) {
                return;
              }
              setSaving(true);
              setError(false);
              try {
                await fileSave(
                  new app.ownerWindow.Blob([result.xml], {
                    type: "application/xml",
                  }),
                  {
                    name: app.getName(),
                    extension: "drawio",
                    mimeTypes: ["application/xml"],
                    description: "draw.io",
                  },
                );
                onClose();
              } catch (error) {
                if (
                  !(
                    error instanceof app.ownerWindow.DOMException &&
                    error.name === "AbortError"
                  )
                ) {
                  setError(true);
                }
              } finally {
                setSaving(false);
              }
            }}
          />
        </div>
      </div>
    </Dialog>
  );
};

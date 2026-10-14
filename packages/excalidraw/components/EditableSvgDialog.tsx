import { useState } from "react";

import { importEditableSvg, MAX_EDITABLE_SVG_SIZE } from "../data/editableSvg";
import { t } from "../i18n";

import { useApp } from "./App";
import { Dialog } from "./Dialog";
import DialogActionButton from "./DialogActionButton";

import "./EditableSvgDialog.scss";

import type { EditableSvgResult } from "../data/editableSvg";

export const EditableSvgDialog = ({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (result: EditableSvgResult) => void;
}) => {
  const app = useApp();
  const [source, setSource] = useState("");
  const [result, setResult] = useState<EditableSvgResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acceptedWarnings, setAcceptedWarnings] = useState(false);
  const [showSource, setShowSource] = useState(true);
  const reset = (value: string, fromFile = false) => {
    setSource(value);
    setResult(null);
    setError(null);
    setAcceptedWarnings(false);
    setShowSource(!fromFile || value.length <= 200000);
  };
  return (
    <Dialog
      title={t("labels.importEditableSvg")}
      onCloseRequest={onClose}
      size="regular"
    >
      <div className="EditableSvgDialog">
        <p>{t("editableSvg.description")}</p>
        <label>
          {t("editableSvg.file")}
          <input
            type="file"
            accept=".svg,image/svg+xml"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) {
                return;
              }
              if (file.size > MAX_EDITABLE_SVG_SIZE) {
                reset("");
                setError(t("editableSvg.tooLarge"));
                setResult(null);
                return;
              }
              try {
                reset(await file.text(), true);
              } catch (error) {
                setError(
                  error instanceof Error
                    ? error.message
                    : t("editableSvg.invalid"),
                );
              }
            }}
          />
        </label>
        <label>
          {t("editableSvg.source")}
          {!showSource && (
            <button type="button" onClick={() => setShowSource(true)}>
              {t("editableSvg.showSource")}
            </button>
          )}
          {showSource && (
            <textarea
              rows={10}
              maxLength={MAX_EDITABLE_SVG_SIZE}
              value={source}
              onChange={(event) => reset(event.target.value)}
              spellCheck={false}
            />
          )}
        </label>
        <DialogActionButton
          label={t("editableSvg.analyze")}
          onClick={() => {
            try {
              const converted = importEditableSvg(
                source,
                app.ownerWindow.DOMParser,
              );
              setResult(converted);
              setError(
                converted.elements.length ? null : t("editableSvg.invalid"),
              );
              setAcceptedWarnings(false);
            } catch (error) {
              setResult(null);
              setError(
                error instanceof Error
                  ? error.message
                  : t("editableSvg.invalid"),
              );
            }
          }}
        />
        {error && <p role="alert">{error}</p>}
        {result && (
          <div role="status">
            <p>{t("editableSvg.result", { count: result.elements.length })}</p>
            {!!result.warnings.length && (
              <>
                <p>{t("editableSvg.warnings")}</p>
                <ul>
                  {result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
                <label className="EditableSvgDialog__acknowledge">
                  <input
                    type="checkbox"
                    checked={acceptedWarnings}
                    onChange={(event) =>
                      setAcceptedWarnings(event.target.checked)
                    }
                  />
                  {t("editableSvg.acceptWarnings")}
                </label>
              </>
            )}
          </div>
        )}
        <div className="EditableSvgDialog__buttons">
          <DialogActionButton label={t("buttons.cancel")} onClick={onClose} />
          <DialogActionButton
            label={t("editableSvg.import")}
            actionType="primary"
            disabled={
              !result?.elements.length ||
              (!!result.warnings.length && !acceptedWarnings)
            }
            onClick={() => result && onSubmit(result)}
          />
        </div>
      </div>
    </Dialog>
  );
};

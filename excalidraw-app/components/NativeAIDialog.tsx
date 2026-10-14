import { useEffect, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  exportToBlob,
  TTDStreamFetch,
} from "@excalidraw/excalidraw";
import { useAtom } from "@excalidraw/excalidraw/editor-jotai";
import { useApp } from "@excalidraw/excalidraw/components/App";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import { deepCopyElement } from "@excalidraw/element/duplicate";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { nativeAIOpenAtom } from "../localAI";
import {
  describeNativeSelection,
  nativeProposalCanApply,
  prepareNativeProposal,
} from "../nativeAI";

import "./LocalAISettings.scss";

export const NativeAIDialog = ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
}) => {
  const [open, setOpen] = useAtom(nativeAIOpenAtom);
  const app = useApp();
  const { t } = useI18n();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState<ReturnType<
    typeof prepareNativeProposal
  > | null>(null);
  const [preview, setPreview] = useState("");
  const baseline = useRef<readonly ExcalidrawElement[]>([]);
  const controller = useRef<AbortController | null>(null);
  const [selectedCount, setSelectedCount] = useState(0);
  useEffect(() => {
    if (open) {
      setSelectedCount(
        excalidrawAPI
          .getSceneElements()
          .filter(
            (element) =>
              excalidrawAPI.getAppState().selectedElementIds[element.id],
          ).length,
      );
    }
    return () => {
      controller.current?.abort();
    };
  }, [open, excalidrawAPI]);
  useEffect(
    () => () => {
      if (preview) {
        app.ownerWindow.URL.revokeObjectURL(preview);
      }
    },
    [preview, app.ownerWindow],
  );

  const close = () => {
    controller.current?.abort();
    setOpen(false);
  };
  const generate = async () => {
    const abort = new app.ownerWindow.AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setProposal(null);
    setPreview("");
    const state = excalidrawAPI.getAppState();
    const original = excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .map(deepCopyElement);
    const selected = original.filter(
      (element) => !element.isDeleted && state.selectedElementIds[element.id],
    ) as ReturnType<ExcalidrawImperativeAPI["getSceneElements"]>;
    baseline.current = original.map((element) => ({ ...element }));
    try {
      const response = await TTDStreamFetch({
        url: `${
          import.meta.env.VITE_APP_AI_BACKEND
        }/v1/ai/native-diagram/chat-streaming`,
        messages: [{ role: "user", content: prompt }],
        body: {
          selection: describeNativeSelection(selected),
          origin: [
            -state.scrollX + 100 / state.zoom.value,
            -state.scrollY + 100 / state.zoom.value,
          ],
        },
        headers: { "X-Excalidraw-AI": "1" },
        signal: abort.signal,
      });
      if (response.error) {
        throw response.error;
      }
      const next = prepareNativeProposal(
        response.generatedResponse,
        original,
        new Set(selected.map((element) => element.id)),
      );
      const blob = await exportToBlob({
        elements: next.changed,
        appState: { ...state, exportBackground: true },
        files: excalidrawAPI.getFiles(),
        mimeType: "image/png",
      });
      abort.signal.throwIfAborted();
      setPreview(app.ownerWindow.URL.createObjectURL(blob));
      setProposal(next);
    } catch (err: any) {
      if (!abort.signal.aborted) {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };
  const apply = () => {
    if (!proposal) {
      return;
    }
    const current = excalidrawAPI.getSceneElementsIncludingDeleted();
    if (!nativeProposalCanApply(baseline.current, current)) {
      setError(t("nativeAI.stale"));
      return;
    }
    const ids = new Set(proposal.elements.map((element) => element.id));
    excalidrawAPI.updateScene({
      elements: [
        ...proposal.elements,
        ...current.filter((element) => !ids.has(element.id)),
      ],
      appState: {
        selectedElementIds: Object.fromEntries(
          proposal.changed.map((element) => [element.id, true]),
        ),
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    setProposal(null);
    close();
  };
  if (!open) {
    return null;
  }
  return (
    <Dialog title={t("nativeAI.title")} size="regular" onCloseRequest={close}>
      <div className="local-ai-settings">
        <p>{t("nativeAI.description", { count: selectedCount })}</p>
        <label>
          {t("nativeAI.prompt")}
          <textarea
            rows={4}
            maxLength={10000}
            value={prompt}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button
          disabled={busy || prompt.trim().length < 3}
          onClick={() => void generate()}
        >
          {busy ? t("nativeAI.generating") : t("nativeAI.generate")}
        </button>
        {busy && (
          <button onClick={() => controller.current?.abort()}>
            {t("buttons.cancel")}
          </button>
        )}
        {proposal && (
          <>
            <p>
              {t("nativeAI.result", {
                created: proposal.createdCount,
                updated: proposal.updatedCount,
              })}
            </p>
            <img
              src={preview}
              alt={t("nativeAI.preview")}
              style={{ maxWidth: "100%", maxHeight: 400, objectFit: "contain" }}
            />
            <button onClick={apply}>{t("nativeAI.apply")}</button>
          </>
        )}
        <button onClick={close}>{t("buttons.close")}</button>
      </div>
    </Dialog>
  );
};

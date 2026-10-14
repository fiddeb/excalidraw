import { useEffect, useState } from "react";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { useApp } from "@excalidraw/excalidraw/components/App";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import "./LocalAISettings.scss";

type AIStatus = {
  connected: boolean;
  models: { id: string; name: string }[];
  model: string | null;
  catalogError?: string;
  login: {
    state: "idle" | "pending" | "complete" | "error";
    url?: string;
    error?: string;
  };
};

const baseUrl = import.meta.env.VITE_APP_AI_BACKEND;

export const LocalAISettings = ({ onClose }: { onClose: () => void }) => {
  const { t } = useI18n();
  const app = useApp();
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");

  useEffect(() => {
    const controller = new app.ownerWindow.AbortController();
    let timer: number;
    const refresh = async () => {
      try {
        const response = await app.ownerWindow.fetch(
          `${baseUrl}/v1/ai/status`,
          {
            signal: controller.signal,
          },
        );
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || t("localAI.unavailable"));
        }
        setStatus(data);
        setError("");
      } catch (err: any) {
        if (!controller.signal.aborted) {
          setError(
            err.message === "Failed to fetch"
              ? t("localAI.unavailable")
              : err.message,
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          timer = app.ownerWindow.setTimeout(refresh, 2000);
        }
      }
    };
    void refresh();
    return () => {
      controller.abort();
      app.ownerWindow.clearTimeout(timer);
    };
  }, [t, app.ownerWindow]);

  const post = async (path: string, payload = {}) => {
    setBusy(true);
    setError("");
    try {
      const response = await app.ownerWindow.fetch(`${baseUrl}/v1/ai/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Excalidraw-AI": "1" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error);
      }
      const next = await app.ownerWindow.fetch(`${baseUrl}/v1/ai/status`);
      const nextStatus = await next.json();
      if (!next.ok) {
        throw new Error(nextStatus.error);
      }
      setStatus(nextStatus);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("localAI.settings")} size="small" onCloseRequest={onClose}>
      <div className="local-ai-settings">
        <p>{t("localAI.description")}</p>
        <p>
          {status?.connected
            ? t("localAI.connected")
            : t("localAI.disconnected")}
        </p>
        {error && <p role="alert">{error}</p>}
        {status?.catalogError && <p role="alert">{status.catalogError}</p>}
        {status?.login.error && <p role="alert">{status.login.error}</p>}
        {!status && (
          <p>
            {t("localAI.startServer")} <code>yarn start:ai</code>
          </p>
        )}
        {status && (
          <>
            <button
              disabled={busy || status.login.state === "pending"}
              onClick={() => void post("login")}
            >
              {t("localAI.login")}
            </button>
            {(status.connected || status.login.state === "pending") && (
              <button disabled={busy} onClick={() => void post("logout")}>
                {status.login.state === "pending"
                  ? t("localAI.cancel")
                  : t("localAI.logout")}
              </button>
            )}
            {status.login.state === "pending" && (
              <>
                <p>{t("localAI.pending")}</p>
                {status.login.url && (
                  <a
                    href={status.login.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("localAI.openLogin")}
                  </a>
                )}
                <details>
                  <summary>{t("localAI.manualCallback")}</summary>
                  <label>
                    {t("localAI.callback")}
                    <input
                      type="text"
                      value={callbackUrl}
                      onChange={(event) => setCallbackUrl(event.target.value)}
                    />
                  </label>
                  <button
                    disabled={busy || !callbackUrl.trim()}
                    onClick={() =>
                      void post("login/callback", { url: callbackUrl })
                    }
                  >
                    {t("localAI.continue")}
                  </button>
                </details>
              </>
            )}
            {status.connected && status.models.length > 0 && (
              <label>
                {t("localAI.model")}
                <select
                  value={status.model ?? ""}
                  disabled={busy}
                  onChange={(event) =>
                    void post("model", { model: event.target.value })
                  }
                >
                  {status.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        <p>{t("localAI.usage")}</p>
        <p>{t("localAI.reasoning")}: Medium</p>
        <button onClick={onClose}>{t("buttons.close")}</button>
      </div>
    </Dialog>
  );
};

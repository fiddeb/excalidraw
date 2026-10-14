import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createPiAdapter } from "./pi.mjs";

const defaultOrigins = ["http://127.0.0.1:3000", "http://localhost:3000"];

export function createAiServer(adapter, { origins = defaultOrigins } = {}) {
  let login = { state: "idle" };
  let loginController;
  let loginTask;
  let pendingPrompt;
  let generating = false;
  const json = (res, status, value) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  async function body(req) {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw new Error("JSON body required");
    let value = "";
    for await (const chunk of req) {
      value += chunk.toString();
      if (Buffer.byteLength(value) > 128 * 1024)
        throw new Error("Request too large");
    }
    return JSON.parse(value);
  }
  const server = createServer(async (req, res) => {
    const host = req.headers.host?.split(":")[0];
    const origin = req.headers.origin;
    if (
      !["localhost", "127.0.0.1"].includes(host) ||
      (origin && !origins.includes(origin))
    ) {
      return json(res, 403, { error: "Origin not allowed" });
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, X-Excalidraw-AI",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const path = req.url?.split("?")[0];
    try {
      if (req.method === "GET" && path === "/v1/ai/status") {
        return json(res, 200, { ...(await adapter.status()), login });
      }
      if (req.method !== "POST")
        return json(res, 404, { error: "Route not found" });
      // The custom header requires browser preflight, including for login/logout.
      if (req.headers["x-excalidraw-ai"] !== "1")
        return json(res, 403, { error: "Missing app header" });
      const payload = await body(req);
      if (path === "/v1/ai/login") {
        if (login.state === "pending")
          return json(res, 409, { error: "Login already pending" });
        loginController = new AbortController();
        const controller = loginController;
        const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
        login = { state: "pending" };
        loginTask = adapter
          .login({
            signal: controller.signal,
            notify(event) {
              if (event.type === "auth_url")
                login = { state: "pending", url: event.url };
            },
            prompt(prompt) {
              return new Promise((resolve, reject) => {
                const signal = prompt.signal ?? controller.signal;
                const abort = () => {
                  pendingPrompt = undefined;
                  reject(new Error("Login cancelled"));
                };
                if (signal.aborted) return abort();
                signal.addEventListener("abort", abort, { once: true });
                pendingPrompt = (value) => {
                  signal.removeEventListener("abort", abort);
                  pendingPrompt = undefined;
                  resolve(value);
                };
              });
            },
          })
          .then(
            () => {
              login = { state: "complete" };
            },
            (error) => {
              login = {
                state: "error",
                error: controller.signal.aborted
                  ? "Login cancelled or timed out"
                  : error.message,
              };
            },
          )
          .finally(() => {
            clearTimeout(timer);
            pendingPrompt = undefined;
          });
        return json(res, 202, { login });
      }
      if (path === "/v1/ai/login/callback") {
        if (!pendingPrompt || typeof payload.url !== "string")
          throw new Error("No callback expected");
        pendingPrompt(payload.url);
        return json(res, 200, { ok: true });
      }
      if (path === "/v1/ai/logout") {
        loginController?.abort();
        await loginTask;
        await adapter.logout();
        login = { state: "idle" };
        return json(res, 200, { ok: true });
      }
      if (path === "/v1/ai/model") {
        await adapter.selectModel(payload.model);
        return json(res, 200, { ok: true });
      }
      const native = path === "/v1/ai/native-diagram/chat-streaming";
      if (!native && path !== "/v1/ai/text-to-diagram/chat-streaming")
        return json(res, 404, {
          error: "This AI feature is not implemented by the local server",
        });
      const messages = payload.messages;
      if (
        native &&
        (!Array.isArray(payload.selection) ||
          payload.selection.length > 80 ||
          !Array.isArray(payload.origin) ||
          payload.origin.length !== 2 ||
          !payload.origin.every(Number.isFinite))
      )
        throw new Error("Invalid native diagram context");
      if (
        !Array.isArray(messages) ||
        !messages.length ||
        messages.length > 100 ||
        messages.some(
          (m) =>
            !m ||
            !["user", "assistant"].includes(m.role) ||
            typeof m.content !== "string" ||
            !m.content.trim(),
        )
      ) {
        throw new Error("Invalid diagram conversation");
      }
      if (generating)
        return json(res, 409, {
          error: "A diagram is already being generated",
        });
      generating = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2 * 60 * 1000);
      const abort = () => controller.abort();
      res.on("close", abort);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      const send = (chunk) => {
        if (!res.destroyed) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };
      try {
        await adapter.generate(
          messages,
          (delta) => send({ type: "content", delta }),
          controller.signal,
          { native, selection: payload.selection, origin: payload.origin },
        );
        send({ type: "done", finishReason: "stop" });
      } catch (error) {
        send({
          type: "error",
          error: { message: error.message || "Generation failed" },
        });
      } finally {
        clearTimeout(timer);
        res.removeListener("close", abort);
        generating = false;
        res.end();
      }
    } catch (error) {
      json(res, 400, { error: error.message || "Request failed" });
    }
  });
  server.on("close", () => loginController?.abort());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stateDir = join(dirname(fileURLToPath(import.meta.url)), ".state");
  const adapter = await createPiAdapter(stateDir);
  const server = createAiServer(adapter, {
    origins: process.env.AI_ALLOWED_ORIGINS?.split(",") ?? defaultOrigins,
  });
  server.listen(3016, "127.0.0.1", () =>
    console.log("Excalidraw AI: http://127.0.0.1:3016"),
  );
}

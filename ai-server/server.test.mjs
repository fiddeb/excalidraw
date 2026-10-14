import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { createAiServer } from "./server.mjs";

async function fixture(t, overrides = {}) {
  const adapter = {
    status: async () => ({ connected: false, models: [], model: null }),
    login: async () => {},
    logout: async () => {},
    selectModel: async () => {},
    generate: async (_messages, onDelta) =>
      onDelta("```mermaid\nflowchart TD\nA --> B\n```"),
    ...overrides,
  };
  const server = createAiServer(adapter);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data = {}, headers = {}) =>
    fetch(`${url}/v1/ai/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Excalidraw-AI": "1",
        ...headers,
      },
      body: JSON.stringify(data),
    });
  return { url, post };
}

test("allows only configured browser origins, app headers and loopback host names", async (t) => {
  const { url, post } = await fixture(t);
  assert.equal(
    (await post("login", {}, { Origin: "https://untrusted.example" })).status,
    403,
  );
  assert.equal(
    (await post("login", {}, { "X-Excalidraw-AI": "" })).status,
    403,
  );
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const req = request(
      `${url}/v1/ai/status`,
      { headers: { Host: "attacker.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(invalidHostStatus, 403);
  const preflight = await fetch(`${url}/v1/ai/login`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:3000" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "http://localhost:3000",
  );
});

test("streams the existing Text to diagram SSE contract", async (t) => {
  const { post } = await fixture(t);
  const response = await post("text-to-diagram/chat-streaming", {
    messages: [{ role: "user", content: "Draw A to B" }],
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.match(events[0].delta, /flowchart TD/);
  assert.deepEqual(events[1], { type: "done", finishReason: "stop" });
});

test("passes explicit native selection context to the generator", async (t) => {
  const { post } = await fixture(t, {
    generate: async (_messages, delta, _signal, options) => {
      assert.equal(options.native, true);
      assert.deepEqual(options.selection, [{ id: "selected-object" }]);
      assert.deepEqual(options.origin, [100, 200]);
      delta('{"operations":[]}');
    },
  });
  const response = await post("native-diagram/chat-streaming", {
    messages: [{ role: "user", content: "Draw" }],
    selection: [{ id: "selected-object" }],
    origin: [100, 200],
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /operations/);
  assert.equal(
    (
      await post("native-diagram/chat-streaming", {
        messages: [{ role: "user", content: "Draw" }],
        selection: [],
        origin: [null, 0],
      })
    ).status,
    400,
  );
});

test("reports failed generation even after partial content", async (t) => {
  const { post } = await fixture(t, {
    generate: async (_messages, delta) => {
      delta("partial");
      throw new Error("Subscription usage limit reached");
    },
  });
  const response = await post("text-to-diagram/chat-streaming", {
    messages: [{ role: "user", content: "Draw" }],
  });
  const text = await response.text();
  assert.match(text, /Subscription usage limit reached/);
  assert.doesNotMatch(text, /"type":"done"/);
});

test("rejects invalid conversations, oversized input and unimplemented AI features", async (t) => {
  const { post } = await fixture(t);
  assert.equal(
    (
      await post("text-to-diagram/chat-streaming", {
        messages: [{ role: "system", content: "x" }],
      })
    ).status,
    400,
  );
  assert.equal(
    (await post("text-to-diagram/chat-streaming", { messages: [] })).status,
    400,
  );
  assert.equal(
    (
      await post("text-to-diagram/chat-streaming", {
        messages: [{ role: "user", content: "x".repeat(140000) }],
      })
    ).status,
    400,
  );
  assert.equal((await post("diagram-to-code/generate-streaming")).status, 404);
});

test("login publishes a browser link, blocks duplicate login and cancels cleanly", async (t) => {
  let aborted = false;
  const { url, post } = await fixture(t, {
    login: async ({ notify, signal }) => {
      notify({ type: "auth_url", url: "https://auth.openai.com/example" });
      await new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
    },
  });
  assert.equal((await post("login")).status, 202);
  const status = await (await fetch(`${url}/v1/ai/status`)).json();
  assert.equal(status.login.url, "https://auth.openai.com/example");
  assert.equal((await post("login")).status, 409);
  assert.equal((await post("logout")).status, 200);
  assert.equal(aborted, true);
  assert.equal(
    (await (await fetch(`${url}/v1/ai/status`)).json()).login.state,
    "idle",
  );
});

test("manual callback is sent to the pending Pi login prompt", async (t) => {
  let callback;
  const { url, post } = await fixture(t, {
    login: async ({ prompt }) => {
      callback = await prompt({ type: "manual_code" });
    },
  });
  await post("login");
  assert.equal(
    (
      await post("login/callback", {
        url: "http://127.0.0.1:1455/auth/callback?code=test",
      })
    ).status,
    200,
  );
  assert.match(callback, /code=test/);
  assert.equal(
    (await (await fetch(`${url}/v1/ai/status`)).json()).login.state,
    "complete",
  );
});

test("browser cancellation aborts Pi generation and releases the busy state", async (t) => {
  let signal;
  const { post } = await fixture(t, {
    generate: async (_messages, delta, generationSignal) => {
      signal = generationSignal;
      delta("starting");
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
    },
  });
  // Use the same endpoint with an explicit signal to simulate closing the dialog.
  const initial = await post("text-to-diagram/chat-streaming", {
    messages: [{ role: "user", content: "Draw" }],
  });
  const blocked = await post("text-to-diagram/chat-streaming", {
    messages: [{ role: "user", content: "Draw" }],
  });
  assert.equal(blocked.status, 409);
  await initial.body.cancel();
  for (let attempt = 0; attempt < 50 && !signal.aborted; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(signal.aborted, true);
});

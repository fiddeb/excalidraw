import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createPiAdapter } from "./pi.mjs";

test("actual Pi SDK streams a diagram with GPT-6.1 Sol / Medium and no tools", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "excalidraw-pi-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "cache.json"),
    refreshOnCreate: false,
  });
  // Replace only provider I/O; session creation, prompts, events and disposal use Pi.
  runtime.listCredentials = async () => [
    { providerId: "openai", type: "oauth" },
  ];
  runtime.checkAuth = async () => ({ source: "OAuth", type: "oauth" });
  runtime.getAuth = async () => ({ auth: { apiKey: "test-oauth-token" } });
  let captured;
  runtime.streamSimple = (model, context, options) => {
    captured = { model, context, options };
    const stream = new AssistantMessageEventStream();
    const text = "```mermaid\nflowchart TD\nA --> B\n```";
    const message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: message,
    });
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: text,
      partial: message,
    });
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  };
  const adapter = await createPiAdapter(dir, {
    modelRuntime: runtime,
    catalogFetch: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/models");
      assert.equal(options.headers.Authorization, "Bearer test-oauth-token");
      return Response.json({
        models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol" }],
      });
    },
  });
  assert.equal((await adapter.status()).model, "gpt-6.1-sol");
  const deltas = [];
  await adapter.generate(
    [{ role: "user", content: "Draw A to B" }],
    (delta) => deltas.push(delta),
    new AbortController().signal,
  );
  assert.equal(captured.model.id, "gpt-6.1-sol");
  assert.equal(captured.options.reasoning, "medium");
  assert.match(deltas.join(""), /flowchart TD/);
  assert.doesNotMatch(deltas.join(""), /```/);
  // Pi embeds tool declarations in system messages; none should be present.
  assert.ok(
    captured.context.messages.every(
      (message) => !message.tools?.length && !message.toolsAdded?.length,
    ),
  );
  assert.match(
    JSON.stringify(captured.context.messages),
    /editable diagrams for Excalidraw/,
  );
  assert.equal(
    JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).model,
    "gpt-6.1-sol",
  );
});

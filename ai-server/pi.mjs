import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createMermaidStream } from "./mermaid-stream.mjs";

const systemPrompt = `You generate editable diagrams for Excalidraw.
Return only raw Mermaid source, without Markdown code fences or explanations.
Use flowchart, sequenceDiagram or classDiagram syntax supported by Mermaid.
For general diagrams prefer flowchart TD. Quote labels containing punctuation.
Do not use HTML, links, initialization directives, external resources or tools.
The user supplies a JSON conversation. Follow the latest user request, using earlier
messages as diagram context. When given a syntax error, repair the diagram.`;

const nativePrompt = `You create and edit native Excalidraw objects.
Return only a JSON object with an operations array. No Markdown or explanations.
Each operation is either {"action":"create", ...shape} or
{"action":"update","targetId":"an ID from the selected objects", ...shape}.
Updates must keep the original type and include complete geometry, not deltas.
Supported types: rectangle, ellipse, diamond, text, line, arrow, polygon.
Every shape has type, x, y, width, height (absolute canvas coordinates).
Optional style: strokeColor and backgroundColor (#RRGGBB or transparent),
strokeWidth (1-10), roughness (0-2), opacity (0-100), fontSize (8-120 for text).
Text objects need text. Place labels as separate native text objects.
Lines, arrows and polygons need points: [[localX,localY],...], relative to x,y.
The first point must be [0,0]. width/height must equal the point bounds.
For polygons provide at least three unique vertices; repeat the first at the end.
Polygons are editable custom contours. Use them for custom shapes.
To attach arrows, give created shapes a unique ref such as "box1", then give the
arrow startTarget and/or endTarget pointing to that ref or a selected object's ID.
Only arrows may have these target fields. Place their endpoints near target outlines.
Do not invent Excalidraw IDs or binding metadata; the app creates bindings itself.
Do not delete objects, create images, URLs, HTML, metadata, groups or scripts.
Only update explicitly selected objects. Locked objects must not be updated.
Use the supplied viewport origin when creating objects on an empty canvas.
Keep diagrams readable with clear spacing. Maximum 80 operations.`;

export async function createPiAdapter(
  stateDir,
  { modelRuntime, catalogFetch = fetch } = {},
) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const configPath = join(stateDir, "settings.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    config = { deviceId: randomUUID(), model: "gpt-6.1-sol" };
  }
  config.model ??= "gpt-6.1-sol";
  const save = () =>
    writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await save();
  const runtime =
    modelRuntime ??
    (await ModelRuntime.create({
      authPath: join(stateDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(stateDir, "models-cache.json"),
    }));
  let models = [];
  let catalogLoaded = false;
  const connected = async () =>
    (await runtime.listCredentials()).some(
      (entry) => entry.providerId === "openai" && entry.type === "oauth",
    );
  async function loadCatalog() {
    if (catalogLoaded) return;
    const auth = await runtime.getAuth("openai");
    const response = await catalogFetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${auth.auth.apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        `Could not load ChatGPT models (${response.status}). Reconnect ChatGPT if needed.`,
      );
    const catalog = await response.json();
    const entries = catalog.models ?? catalog.data;
    if (!Array.isArray(entries))
      throw new Error("Invalid ChatGPT model catalog");
    models = entries.flatMap((entry) => {
      const id = entry.slug ?? entry.id;
      const model = runtime.getModel("openai", id);
      return model ? [{ id, name: entry.display_name ?? model.name }] : [];
    });
    if (!models.length)
      throw new Error(
        "Your ChatGPT account returned no models supported by this Pi version.",
      );
    if (!models.some((model) => model.id === config.model)) {
      config.model =
        models.find((model) => model.id === "gpt-6.1-sol")?.id ?? models[0].id;
      await save();
    }
    catalogLoaded = true;
  }
  return {
    async status() {
      const isConnected = await connected();
      let catalogError;
      if (isConnected) {
        try {
          await loadCatalog();
        } catch (error) {
          catalogError = error.message;
        }
      }
      return {
        connected: isConnected,
        models: isConnected ? models : [],
        model: config.model,
        thinkingLevel: "medium",
        catalogError,
      };
    },
    async login(interaction) {
      await runtime.login("openai", "oauth", interaction, {
        getDeviceId: () => config.deviceId,
        agentName: "Excalidraw fork",
      });
      catalogLoaded = false;
    },
    async logout() {
      await runtime.logout("openai");
      catalogLoaded = false;
      models = [];
    },
    async selectModel(id) {
      if (!(await connected())) throw new Error("Connect ChatGPT first");
      await loadCatalog();
      if (!models.some((model) => model.id === id))
        throw new Error("Unknown ChatGPT model");
      config.model = id;
      await save();
    },
    async generate(
      messages,
      onDelta,
      signal,
      { native = false, selection = [], origin = [0, 0] } = {},
    ) {
      if (!(await connected()))
        throw new Error(
          "Open AI settings in the menu and connect ChatGPT first.",
        );
      await loadCatalog();
      signal.throwIfAborted();
      const resourceLoader = {
        getExtensions: () => ({
          extensions: [],
          errors: [],
          runtime: createExtensionRuntime(),
        }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => (native ? nativePrompt : systemPrompt),
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => {},
        reload: async () => {},
      };
      const { session } = await createAgentSession({
        cwd: stateDir,
        agentDir: stateDir,
        modelRuntime: runtime,
        model: runtime.getModel("openai", config.model),
        tools: [],
        noTools: "all",
        thinkingLevel: "medium",
        resourceLoader,
        sessionManager: SessionManager.inMemory(stateDir),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
      });
      const abort = () => {
        void session.abort();
      };
      const mermaidStream = native
        ? { push: onDelta, finish() {} }
        : createMermaidStream(onDelta);
      const unsubscribe = session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          mermaidStream.push(event.assistantMessageEvent.delta);
        }
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        await session.prompt(
          JSON.stringify(
            native
              ? { messages, selectedObjects: selection, origin }
              : messages,
          ),
        );
        signal.throwIfAborted();
        const last = session.messages.findLast(
          (message) => message.role === "assistant",
        );
        if (last?.stopReason === "error" || last?.stopReason === "aborted") {
          throw new Error(last.errorMessage || "Generation failed");
        }
        if (!session.getLastAssistantText()?.trim())
          throw new Error("The model returned an empty diagram");
        mermaidStream.finish();
      } finally {
        signal.removeEventListener("abort", abort);
        unsubscribe();
        session.dispose();
      }
    },
  };
}

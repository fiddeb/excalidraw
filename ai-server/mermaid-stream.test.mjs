import assert from "node:assert/strict";
import { test } from "node:test";
import { createMermaidStream } from "./mermaid-stream.mjs";

test("removes Markdown fences split across arbitrary streaming chunks", () => {
  let output = "";
  const stream = createMermaidStream((delta) => {
    output += delta;
  });
  for (const character of "```mermaid\r\nflowchart TD\r\nA --> B\r\n```\n")
    stream.push(character);
  stream.finish();
  assert.equal(output, "flowchart TD\nA --> B\n");
});

test("preserves raw Mermaid and the final line without a newline", () => {
  let output = "";
  const stream = createMermaidStream((delta) => {
    output += delta;
  });
  stream.push("flowchart TD\nA --> B");
  stream.finish();
  assert.equal(output, "flowchart TD\nA --> B");
});

test("rejects an empty fenced response", () => {
  const stream = createMermaidStream(() => {});
  stream.push("```mermaid\n```\n");
  assert.throws(() => stream.finish(), /empty diagram/);
});

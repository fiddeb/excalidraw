// Emit complete lines so split Markdown fences never reach the Mermaid parser.
export function createMermaidStream(onDelta) {
  let buffer = "";
  let hasContent = false;
  const emit = (line, newline) => {
    if (/^\s*```(?:mermaid)?\s*$/i.test(line)) return;
    if (line.trim()) hasContent = true;
    onDelta(line + newline);
  };
  return {
    push(delta) {
      buffer += delta;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        emit(buffer.slice(0, index).replace(/\r$/, ""), "\n");
        buffer = buffer.slice(index + 1);
      }
    },
    finish() {
      if (buffer) emit(buffer, "");
      buffer = "";
      if (!hasContent) throw new Error("The model returned an empty diagram");
    },
  };
}

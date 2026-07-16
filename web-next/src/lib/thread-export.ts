import type { ChatMessage, Thread } from "./types";

/**
 * Serialize a thread's visible messages to Markdown. Excludes tool calls and
 * thinking blocks by default so the output reads like a normal conversation
 * log. Pass `includeDebug: true` when the owner wants the full raw trace.
 */
export function exportThreadToMarkdown(
  thread: Thread | undefined,
  messages: ChatMessage[],
  options: { includeDebug?: boolean } = {},
): string {
  const title = thread?.title || "pi-dyland thread";
  const when = new Date().toISOString();
  const header = [`# ${title}`, ``, `> Exported ${when}`, ``];
  const body: string[] = [];
  for (const m of messages) {
    if (m.kind === "user") {
      body.push(`## 🧑 You`);
      body.push("");
      body.push(m.text);
      if (m.skillHint) body.push(`\n_via /${m.skillHint}_`);
      body.push("");
    } else if (m.kind === "assistant") {
      body.push(`## 🤖 Dyland`);
      body.push("");
      if (options.includeDebug && m.thinking) {
        body.push(`> _Thinking_`);
        body.push("");
        body.push(m.thinking);
        body.push("");
      }
      body.push(m.text || "_(empty)_");
      body.push("");
    } else if (m.kind === "tool" && options.includeDebug) {
      body.push(`### 🔧 tool ${m.name} (${m.status})`);
      body.push("");
      body.push("```json");
      body.push(JSON.stringify(m.args ?? {}, null, 2));
      body.push("```");
      if (m.result) {
        body.push("");
        body.push("```");
        body.push(m.result);
        body.push("```");
      }
      body.push("");
    } else if (m.kind === "error") {
      body.push(`> ⚠️ **error:** ${m.message}`);
      body.push("");
    }
  }
  return header.concat(body).join("\n");
}

/** Trigger a browser download of a Markdown blob. */
export function downloadMarkdown(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Delay revoke so Safari has time to consume the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

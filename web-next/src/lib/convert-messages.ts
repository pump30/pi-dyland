import type { ChatMessage } from "./types";

const SYSTEM_HINT_RE = /<system_hint>[\s\S]*?<\/system_hint>\s*/g;
const SLASH_HINT_RE =
  /<system_hint>[\s\S]*?The user invoked \/([a-z0-9_]+)[\s\S]*?<\/system_hint>/;

interface RawContent {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  content?: unknown;
  isError?: boolean;
  toolUseId?: string;
  tool_use_id?: string;
}

interface RawMessage {
  role: string;
  content: RawContent[];
}

/**
 * Convert the pi Agent transcript (raw Message[]) into flat client ChatMessages.
 * Pairs tool_use blocks in assistant messages with tool_result blocks in the
 * following tool message, so each tool call becomes exactly one card.
 */
export function convertRawMessages(raw: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const toolIndex = new Map<string, number>();

  for (const rawMsg of raw) {
    const m = rawMsg as RawMessage;
    if (!m || !Array.isArray(m.content)) continue;

    if (m.role === "user") {
      const text = m.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      const hintMatch = text.match(SLASH_HINT_RE);
      const visible = text.replace(SYSTEM_HINT_RE, "").trim();
      if (visible) {
        out.push({
          id: `u-${out.length}`,
          kind: "user",
          text: visible,
          skillHint: hintMatch ? hintMatch[1] : undefined,
        });
      }
      continue;
    }

    if (m.role === "assistant") {
      const text = m.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      if (text) {
        out.push({
          id: `a-${out.length}`,
          kind: "assistant",
          text,
          streaming: false,
        });
      }
      for (const c of m.content) {
        if (c.type === "tool_use" && c.id) {
          out.push({
            id: `t-${out.length}`,
            kind: "tool",
            toolCallId: c.id,
            name: c.name ?? "tool",
            args: c.input,
            result: null,
            status: "running",
          });
          toolIndex.set(c.id, out.length - 1);
        }
      }
      continue;
    }

    if (m.role === "tool") {
      for (const c of m.content) {
        if (c.type !== "tool_result") continue;
        const id = c.toolUseId ?? c.tool_use_id;
        const contentArr = Array.isArray(c.content)
          ? (c.content as RawContent[])
          : [];
        const text = contentArr
          .filter((x) => x.type === "text")
          .map((x) => x.text ?? "")
          .join("\n");
        if (id && toolIndex.has(id)) {
          const idx = toolIndex.get(id)!;
          const existing = out[idx];
          if (existing.kind === "tool") {
            existing.result = text;
            existing.isError = c.isError;
            existing.status = c.isError ? "error" : "done";
          }
        } else if (text) {
          out.push({
            id: `t-${out.length}`,
            kind: "tool",
            name: "tool",
            args: null,
            result: text,
            status: c.isError ? "error" : "done",
            isError: c.isError,
          });
        }
      }
    }
  }
  return out;
}

import type { CardBlock, CardKind, CardPayload } from "./cards";

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  /** true while a /chat SSE stream is running for this thread */
  inFlight?: boolean;
  /** Cumulative token estimate (client-side heuristic, not authoritative). */
  tokens?: { input: number; output: number };
  /** Active session goal, if any. */
  goal?: SessionGoal | null;
}

export interface SessionGoal {
  text: string;
  createdAt: number;
  continuations: number;
}

export interface Skill {
  name: string;
  label: string;
  description: string;
  parameters?: unknown;
}

export interface AttachmentImage {
  data: string; // base64
  mimeType: string;
  name: string;
  size: number;
}

export interface AttachmentFile {
  name: string;
  content: string;
  size: number;
  addToLibrary?: boolean;
}

/** Message rendered in the chat log (client-side model, not pi's raw shape). */
export type ChatMessage =
  | {
      id: string;
      kind: "user";
      text: string;
      images?: AttachmentImage[];
      files?: AttachmentFile[];
      skillHint?: string;
    }
  | {
      id: string;
      kind: "assistant";
      text: string;
      /** Chain-of-thought / reasoning stream. Rendered in a collapsed panel. */
      thinking?: string;
      /** true while streaming; false once done. */
      streaming?: boolean;
      /** Cards attached to this assistant turn (transient — not persisted). */
      cards?: CardBlock[];
    }
  | {
      id: string;
      kind: "tool";
      toolCallId?: string;
      name: string;
      args: unknown;
      /** null while running */
      result: string | null;
      isError?: boolean;
      status: "running" | "done" | "error";
    }
  | {
      id: string;
      kind: "error";
      message: string;
    };

export type SseEvent =
  | { type: "assistant_start" }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | {
      type: "tool_start";
      toolCallId: string;
      name: string;
      args: unknown;
    }
  | {
      type: "tool_end";
      toolCallId: string;
      name: string;
      result: {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
    }
  | { type: "skill_hint"; name: string }
  | {
      type: "usage";
      deltaInput: number;
      deltaOutput: number;
      totalInput: number;
      totalOutput: number;
    }
  | { type: "goal_updated"; goal: SessionGoal | null }
  | {
      type: "card";
      id: string;
      parent: string | null;
      kind: CardKind;
      payload: CardPayload;
    }
  | { type: "error"; message: string }
  | { type: "done" };

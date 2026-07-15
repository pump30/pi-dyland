export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
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
      /** true while streaming; false once done. */
      streaming?: boolean;
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
  | { type: "error"; message: string }
  | { type: "done" };

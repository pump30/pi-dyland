import { apiUrl } from "./utils";
import type {
  AttachmentFile,
  AttachmentImage,
  SessionGoal,
  Skill,
  SseEvent,
  Thread,
} from "./types";

export async function fetchThreads(): Promise<Thread[]> {
  const r = await fetch(apiUrl("/threads"), { credentials: "include" });
  if (!r.ok) throw new Error(`GET /threads → ${r.status}`);
  return r.json();
}

export async function fetchSkills(): Promise<Skill[]> {
  const r = await fetch(apiUrl("/skills"), { credentials: "include" });
  if (!r.ok) throw new Error(`GET /skills → ${r.status}`);
  return r.json();
}

export async function createThread(title?: string): Promise<Thread> {
  const r = await fetch(apiUrl("/threads"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!r.ok) throw new Error(`POST /threads → ${r.status}`);
  return r.json();
}

export async function deleteThread(id: string): Promise<void> {
  const r = await fetch(apiUrl(`/threads/${id}`), {
    method: "DELETE",
    credentials: "include",
  });
  if (!r.ok) throw new Error(`DELETE /threads/${id} → ${r.status}`);
}

export async function renameThread(id: string, title: string): Promise<void> {
  const r = await fetch(apiUrl(`/threads/${id}`), {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!r.ok) throw new Error(`PATCH /threads/${id} → ${r.status}`);
}

export async function resetThread(id: string): Promise<void> {
  await fetch(apiUrl(`/reset?thread=${encodeURIComponent(id)}`), {
    method: "POST",
    credentials: "include",
  });
}

/**
 * Cancel any in-flight prompt for a thread. Safe no-op if nothing is running.
 * The server rebuilds the Agent so subsequent /chat cannot inherit stuck state.
 */
export async function cancelThread(id: string): Promise<void> {
  await fetch(apiUrl(`/threads/${encodeURIComponent(id)}/cancel`), {
    method: "POST",
    credentials: "include",
  });
}

export async function fetchMessages(threadId: string): Promise<unknown[]> {
  const r = await fetch(
    apiUrl(`/messages?thread=${encodeURIComponent(threadId)}`),
    { credentials: "include" },
  );
  if (!r.ok) return [];
  return r.json();
}

/**
 * Compact old messages in a thread. Replaces everything but the tail with an
 * LLM-produced summary. Returns quickly (server does one non-streaming call).
 */
export async function compactThread(id: string): Promise<{ ok: boolean; action?: string; dropped?: number }> {
  const r = await fetch(apiUrl(`/compact?thread=${encodeURIComponent(id)}`), {
    method: "POST",
    credentials: "include",
  });
  if (!r.ok) throw new Error(`POST /compact → ${r.status}`);
  return r.json();
}

/** Fetch up to 3 follow-up prompt suggestions for the current thread. */
export async function fetchSuggestions(id: string): Promise<string[]> {
  try {
    const r = await fetch(apiUrl(`/suggest?thread=${encodeURIComponent(id)}`), {
      credentials: "include",
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { suggestions?: string[] };
    return data.suggestions ?? [];
  } catch {
    return [];
  }
}

export async function setGoal(id: string, text: string): Promise<SessionGoal | null> {
  const r = await fetch(apiUrl(`/threads/${encodeURIComponent(id)}/goal`), {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`PUT /threads/${id}/goal → ${r.status}`);
  const data = (await r.json()) as { goal: SessionGoal | null };
  return data.goal;
}

export async function clearGoal(id: string): Promise<void> {
  await fetch(apiUrl(`/threads/${encodeURIComponent(id)}/goal`), {
    method: "DELETE",
    credentials: "include",
  });
}

export interface FeedbackBody {
  threadId: string;
  messageId: string;
  rating: "up" | "down";
  note?: string;
}

export async function sendFeedback(body: FeedbackBody): Promise<void> {
  await fetch(apiUrl("/feedback"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}


export interface ChatRequestBody {
  prompt: string;
  threadId: string;
  images?: Pick<AttachmentImage, "data" | "mimeType">[];
  files?: Array<Pick<AttachmentFile, "name" | "content"> & { addToLibrary?: boolean }>;
}

/**
 * Stream a /chat SSE response. Calls `onEvent` for each parsed data event.
 * Resolves when the stream ends. Rejects on network/HTTP errors.
 */
export async function streamChat(
  body: ChatRequestBody,
  onEvent: (ev: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(apiUrl("/chat"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`POST /chat → ${res.status}: ${t.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLines = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) continue;
      let payload: SseEvent;
      try {
        payload = JSON.parse(dataLines.join("\n")) as SseEvent;
      } catch {
        continue;
      }
      onEvent(payload);
    }
  }
}

// -----------------------------------------------------------------------------
// RAG (knowledge base) helpers
// -----------------------------------------------------------------------------

export interface RagDoc {
  sha: string;
  name: string;
  mime: string;
  size: number;
  chunks: number;
  source: "chat" | "upload" | "inbox";
  addedAt: number;
}

export interface RagJob {
  id: string;
  name: string;
  mime: string;
  size: number;
  source: RagDoc["source"];
  status: "queued" | "reading" | "chunking" | "embedding" | "done" | "failed";
  pct: number;
  sha?: string;
  chunks?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export type RagEvent =
  | { type: "job_queued"; job: RagJob }
  | { type: "job_progress"; id: string; status: RagJob["status"]; pct: number }
  | { type: "job_done"; id: string; doc: RagDoc }
  | { type: "job_failed"; id: string; error: string }
  | { type: "doc_deleted"; sha: string };

export async function listRagDocs(): Promise<RagDoc[]> {
  const res = await fetch(apiUrl("/rag/docs"), { credentials: "include" });
  if (!res.ok) throw new Error(`listRagDocs ${res.status}`);
  const data = (await res.json()) as { docs: RagDoc[] };
  return data.docs;
}

export async function deleteRagDoc(sha: string): Promise<void> {
  const res = await fetch(apiUrl(`/rag/docs/${encodeURIComponent(sha)}`), {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`deleteRagDoc ${res.status}`);
}

export async function uploadRagFiles(
  files: Array<{ name: string; mime: string; bytes: ArrayBuffer }>,
): Promise<Array<{ id: string; name: string }>> {
  const payload = {
    files: files.map((f) => ({
      name: f.name,
      mime: f.mime,
      bytesBase64: bufferToBase64(f.bytes),
    })),
  };
  const res = await fetch(apiUrl("/rag/upload"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`uploadRagFiles ${res.status}: ${t}`);
  }
  const data = (await res.json()) as { jobs: Array<{ id: string; name: string }> };
  return data.jobs;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize)) as number[],
    );
  }
  return btoa(bin);
}

/**
 * Subscribe to the /rag/events SSE stream. Uses fetch + ReadableStream so
 * Basic Auth is picked up automatically by the browser (unlike EventSource
 * on cross-realm setups). Returns a stop function.
 */
export function streamRagEvents(
  onEvent: (ev: RagEvent) => void,
  onError?: (err: unknown) => void,
): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(apiUrl("/rag/events"), {
        credentials: "include",
        signal: ctrl.signal,
        headers: { Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`streamRagEvents ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              const raw = line.slice(5).trim();
              if (!raw) continue;
              try {
                onEvent(JSON.parse(raw) as RagEvent);
              } catch {
                /* ignore malformed frames */
              }
            }
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError" && onError) onError(err);
    }
  })();
  return () => ctrl.abort();
}

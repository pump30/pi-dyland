"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import * as api from "@/lib/api";
import { convertRawMessages } from "@/lib/convert-messages";
import type {
  AttachmentFile,
  AttachmentImage,
  ChatMessage,
  Skill,
  SseEvent,
  Thread,
} from "@/lib/types";
import { MessageList } from "./message-list";
import { Composer } from "./composer";
import { ThreadSidebar } from "./thread-sidebar";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";

const DEFAULT_THREAD_ID = "default";
const ACTIVE_KEY = "pi-dyland.active-thread";

export function ChatApp() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string>(DEFAULT_THREAD_ID);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendingThreadRef = useRef<string | null>(null);

  // Load active-thread pointer once on mount.
  useEffect(() => {
    const stored = localStorage.getItem(ACTIVE_KEY);
    if (stored) setActiveId(stored);
  }, []);

  // Persist active-thread pointer.
  useEffect(() => {
    localStorage.setItem(ACTIVE_KEY, activeId);
  }, [activeId]);

  const refreshThreads = useCallback(async () => {
    try {
      const list = await api.fetchThreads();
      setThreads(list);
    } catch {
      /* silent */
    }
  }, []);

  const refreshMessages = useCallback(async (tid: string) => {
    try {
      const raw = await api.fetchMessages(tid);
      setMessages(convertRawMessages(raw));
    } catch {
      setMessages([]);
    }
  }, []);

  // Boot.
  useEffect(() => {
    (async () => {
      try {
        setSkills(await api.fetchSkills());
      } catch {
        setSkills([]);
      }
      await refreshThreads();
    })();
  }, [refreshThreads]);

  // Reload messages when active thread changes.
  useEffect(() => {
    refreshMessages(activeId);
  }, [activeId, refreshMessages]);

  const activeThread = threads.find((t) => t.id === activeId);
  const activeTitle = activeThread?.title || "New chat";

  useEffect(() => {
    // Scroll to bottom whenever messages update.
    scrollAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  async function handleNew() {
    // If we're mid-stream, abandon it before switching threads.
    stopStreamLocal();
    try {
      const t = await api.createThread();
      await refreshThreads();
      setActiveId(t.id);
      setMessages([]);
    } catch (e) {
      pushError((e as Error).message);
    }
  }

  async function handleDelete(id: string) {
    // Cancel first — the server rebuilds the agent so the delete cannot race
    // an in-flight prompt.
    try { await api.cancelThread(id); } catch { /* ignore */ }
    try {
      await api.deleteThread(id);
      if (activeId === id) setActiveId(DEFAULT_THREAD_ID);
      await refreshThreads();
    } catch (e) {
      pushError((e as Error).message);
    }
  }

  /**
   * Hard reset the current thread. Server rebuilds the Agent instance so any
   * stuck "already processing" state is gone — this is the escape hatch when
   * the previous run jammed.
   */
  async function handleReset() {
    stopStreamLocal();
    try { await api.resetThread(activeId); } catch { /* ignore */ }
    setMessages([]);
    await refreshThreads();
  }

  /**
   * User pressed Stop while a stream was running. Abort locally AND tell the
   * server to drop the Agent instance, otherwise pi-agent-core keeps running
   * in the background and blocks the next prompt with "already processing".
   */
  function handleStop() {
    const tid = sendingThreadRef.current;
    stopStreamLocal();
    if (tid) {
      api.cancelThread(tid).catch(() => {});
    }
  }

  function stopStreamLocal() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }

  // If the tab is closed or reloaded mid-stream, tell the server to drop the
  // agent instance. Uses navigator.sendBeacon so it survives unload.
  useEffect(() => {
    const onBeforeUnload = () => {
      const tid = sendingThreadRef.current;
      if (!tid) return;
      const url = (
        typeof window !== "undefined" && window.location.port === "3000"
          ? (process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8787")
          : ""
      ) + `/threads/${encodeURIComponent(tid)}/cancel`;
      try {
        navigator.sendBeacon(url);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Auto-cancel when switching to a different thread mid-stream.
  const prevActiveRef = useRef(activeId);
  useEffect(() => {
    if (prevActiveRef.current !== activeId) {
      const prev = prevActiveRef.current;
      if (sendingThreadRef.current === prev) {
        // We were streaming on the previous thread; drop it.
        stopStreamLocal();
        api.cancelThread(prev).catch(() => {});
      }
      prevActiveRef.current = activeId;
    }
  }, [activeId]);

  function pushError(msg: string) {
    setMessages((cur) => [
      ...cur,
      { id: `e-${cur.length}-${Date.now()}`, kind: "error", message: msg },
    ]);
  }

  async function handleSend(
    prompt: string,
    images: AttachmentImage[],
    files: AttachmentFile[],
  ) {
    if (sending) return;
    setSending(true);
    const targetThreadId = activeId;
    sendingThreadRef.current = targetThreadId;
    const userId = `u-${Date.now()}`;
    // Optimistically show the user message.
    setMessages((cur) => [
      ...cur,
      {
        id: userId,
        kind: "user",
        text: prompt || "(attachment)",
        images: images.length > 0 ? images : undefined,
        files: files.length > 0 ? files : undefined,
      },
    ]);

    const abort = new AbortController();
    abortRef.current = abort;

    const assistantId = `a-${Date.now()}`;
    let assistantAdded = false;
    const toolIdMap = new Map<string, string>();

    try {
      await api.streamChat(
        {
          prompt,
          threadId: targetThreadId,
          images: images.length > 0 ? images.map((i) => ({ data: i.data, mimeType: i.mimeType })) : undefined,
          files: files.length > 0 ? files.map((f) => ({ name: f.name, content: f.content })) : undefined,
        },
        (ev: SseEvent) => {
          setMessages((cur) => applySseEvent(cur, ev, {
            userMsgId: userId,
            assistantId,
            assistantAdded: () => assistantAdded,
            setAssistantAdded: (v) => { assistantAdded = v; },
            toolIdMap,
          }));
        },
        abort.signal,
      );
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        pushError("Cancelled");
      } else {
        pushError(err.message);
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      sendingThreadRef.current = null;
      refreshThreads();
    }
  }

  return (
    <div className="flex h-full">
      <ThreadSidebar
        threads={threads}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={handleNew}
        onDelete={handleDelete}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 px-6 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{activeTitle}</div>
            <div className="truncate text-xs text-muted-foreground">
              {skills.length} skills
              {skills.length > 0 && ": " + skills.map((s) => s.name).join(", ")}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            onClick={handleReset}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>
        </header>
        <Separator />
        <ScrollArea className="flex-1">
          <MessageList messages={messages} />
          <div ref={scrollAnchorRef} />
        </ScrollArea>
        <Separator />
        <div className="pt-3">
          <Composer
            skills={skills}
            disabled={false}
            sending={sending}
            onSend={handleSend}
            onStop={handleStop}
            onError={pushError}
          />
        </div>
      </main>
    </div>
  );
}

// -----------------------------------------------------------------------------
// SSE reducer
// -----------------------------------------------------------------------------

interface SseCtx {
  userMsgId: string;
  assistantId: string;
  assistantAdded: () => boolean;
  setAssistantAdded: (v: boolean) => void;
  toolIdMap: Map<string, string>;
}

function applySseEvent(
  cur: ChatMessage[],
  ev: SseEvent,
  ctx: SseCtx,
): ChatMessage[] {
  switch (ev.type) {
    case "skill_hint": {
      return cur.map((m) =>
        m.id === ctx.userMsgId && m.kind === "user"
          ? { ...m, skillHint: ev.name }
          : m,
      );
    }
    case "assistant_start": {
      if (ctx.assistantAdded()) return cur;
      ctx.setAssistantAdded(true);
      return [
        ...cur,
        { id: ctx.assistantId, kind: "assistant", text: "", streaming: true },
      ];
    }
    case "text_delta": {
      if (!ctx.assistantAdded()) {
        ctx.setAssistantAdded(true);
        return [
          ...cur,
          {
            id: ctx.assistantId,
            kind: "assistant",
            text: ev.delta,
            streaming: true,
          },
        ];
      }
      return cur.map((m) =>
        m.id === ctx.assistantId && m.kind === "assistant"
          ? { ...m, text: m.text + ev.delta }
          : m,
      );
    }
    case "thinking_delta": {
      // Not surfaced in UI (yet).
      return cur;
    }
    case "tool_start": {
      const localId = `t-${ev.toolCallId}`;
      ctx.toolIdMap.set(ev.toolCallId, localId);
      return [
        ...cur,
        {
          id: localId,
          kind: "tool",
          toolCallId: ev.toolCallId,
          name: ev.name,
          args: ev.args,
          result: null,
          status: "running",
        },
      ];
    }
    case "tool_end": {
      const localId = ctx.toolIdMap.get(ev.toolCallId);
      const text = (ev.result?.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      const isError = Boolean(ev.result?.isError);
      if (!localId) {
        return [
          ...cur,
          {
            id: `t-orphan-${Date.now()}`,
            kind: "tool",
            name: ev.name,
            args: null,
            result: text,
            isError,
            status: isError ? "error" : "done",
          },
        ];
      }
      return cur.map((m) =>
        m.id === localId && m.kind === "tool"
          ? { ...m, result: text, isError, status: isError ? "error" : "done" }
          : m,
      );
    }
    case "error": {
      return [
        ...cur,
        {
          id: `e-${Date.now()}`,
          kind: "error",
          message: ev.message,
        },
      ];
    }
    case "done": {
      return cur.map((m) =>
        m.id === ctx.assistantId && m.kind === "assistant"
          ? { ...m, streaming: false }
          : m,
      );
    }
    default:
      return cur;
  }
}

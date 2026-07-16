"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Menu, RotateCcw, Target } from "lucide-react";
import * as api from "@/lib/api";
import { convertRawMessages } from "@/lib/convert-messages";
import { downloadMarkdown, exportThreadToMarkdown } from "@/lib/thread-export";
import type {
  AttachmentFile,
  AttachmentImage,
  ChatMessage,
  SessionGoal,
  Skill,
  SseEvent,
  Thread,
} from "@/lib/types";
import { MessageList } from "./message-list";
import { Composer, type ComposerHandle } from "./composer";
import { ThreadSidebar } from "./thread-sidebar";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { CommandPalette, type PaletteAction } from "./command-palette";
import { EmptyStateSuggestions, FollowUpChips } from "./suggestions";
import { TokenUsage } from "./token-usage";
import { GoalBar } from "./goal-bar";

const DEFAULT_THREAD_ID = "default";
const ACTIVE_KEY = "pi-dyland.active-thread";

export function ChatApp() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string>(DEFAULT_THREAD_ID);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [usage, setUsage] = useState<{ input: number; output: number }>({ input: 0, output: 0 });
  const [goal, setGoal] = useState<SessionGoal | null>(null);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendingThreadRef = useRef<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const suggestReqRef = useRef(0);

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

  // Reload messages when active thread changes; also sync goal + usage from
  // the thread list so the header reflects reality after a reload.
  useEffect(() => {
    refreshMessages(activeId);
    setFollowUps([]);
    const t = threads.find((x) => x.id === activeId);
    setGoal(t?.goal ?? null);
    setUsage(t?.tokens ?? { input: 0, output: 0 });
  }, [activeId, refreshMessages, threads]);

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
      setFollowUps([]);
      setGoal(null);
      setUsage({ input: 0, output: 0 });
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
    setFollowUps([]);
    setUsage({ input: 0, output: 0 });
    await refreshThreads();
  }

  async function handleCompact() {
    if (sending) return;
    try {
      const res = await api.compactThread(activeId);
      if (res.action === "compacted") {
        await refreshMessages(activeId);
        await refreshThreads();
      } else {
        pushError(`compact: ${res.action ?? "no-op"}`);
      }
    } catch (e) {
      pushError((e as Error).message);
    }
  }

  function handleExport() {
    const md = exportThreadToMarkdown(activeThread, messages);
    const slug = (activeThread?.title || "thread")
      .replace(/[^a-z0-9-_\s]/gi, "")
      .replace(/\s+/g, "-")
      .slice(0, 40) || "thread";
    downloadMarkdown(`${slug}-${Date.now()}.md`, md);
  }

  async function handleSetGoal(text: string) {
    try {
      const next = await api.setGoal(activeId, text);
      setGoal(next);
      await refreshThreads();
    } catch (e) {
      pushError((e as Error).message);
    }
  }

  async function handleClearGoal() {
    try {
      await api.clearGoal(activeId);
      setGoal(null);
      await refreshThreads();
    } catch (e) {
      pushError((e as Error).message);
    }
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
    // Handle client-side slash commands that don't need a stream at all.
    // Server ALSO handles /goal, so this is just a fast-path for UX.
    if (prompt.trim() === "/compact") {
      await handleCompact();
      return;
    }
    setSending(true);
    setFollowUps([]);
    const targetThreadId = activeId;
    sendingThreadRef.current = targetThreadId;
    const userId = `u-${Date.now()}`;
    // Optimistically show the user message (except for /goal which is a
    // meta-command — we'd rather show it as a subtle toast, but the SSE
    // stream from the server will emit `goal_updated` and we skip the user
    // echo entirely for /goal).
    const isGoalCmd = /^\/goal\b/.test(prompt.trim());
    if (!isGoalCmd) {
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
    }

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
          if (ev.type === "usage") {
            setUsage({ input: ev.totalInput, output: ev.totalOutput });
            return;
          }
          if (ev.type === "goal_updated") {
            setGoal(ev.goal);
            return;
          }
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
      // Kick off follow-up suggestions in the background. Ignore stale
      // responses if the user has moved on or started a new turn.
      const reqId = ++suggestReqRef.current;
      api
        .fetchSuggestions(targetThreadId)
        .then((s) => {
          if (reqId === suggestReqRef.current && targetThreadId === activeId) {
            setFollowUps(s);
          }
        })
        .catch(() => {});
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

  // --------- Command palette + keyboard shortcuts -------------------------

  const paletteActions: PaletteAction[] = [
    {
      id: "new-thread",
      label: "New thread",
      shortcut: "⌘⇧N",
      run: () => handleNew(),
    },
    {
      id: "reset-thread",
      label: "Reset current thread",
      hint: "Rebuild the agent instance, drop message history",
      run: () => handleReset(),
    },
    {
      id: "compact",
      label: "Compact old messages",
      hint: "Summarize the head of the conversation",
      run: () => handleCompact(),
    },
    {
      id: "export",
      label: "Export as Markdown",
      hint: "Download the current thread transcript",
      run: () => handleExport(),
    },
    {
      id: "set-goal",
      label: goal ? "Change session goal" : "Set session goal",
      hint: "Auto-continues the agent until the goal is met",
      run: () => {
        const text = window.prompt(
          "Session goal (empty to clear):",
          goal?.text ?? "",
        );
        if (text === null) return;
        if (!text.trim()) {
          void handleClearGoal();
        } else {
          void handleSetGoal(text.trim());
        }
      },
    },
    {
      id: "toggle-sidebar",
      label: "Toggle threads sidebar",
      shortcut: "⌘B",
      run: () => setSidebarOpen((v) => !v),
    },
  ];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void handleNew();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "b") {
        // Do not steal ⌘B from textarea bold-shortcut users typing markdown
        // — but our textarea does not implement bold, so we're safe.
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // handleNew captures state via closures; safest to keep the deps empty
    // and read the latest via refs — but handleNew calls setState which is
    // stable-ish. Leaving the effect fixed to avoid re-binding on every
    // render, which would cause dropped shortcuts during typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------------

  const showEmptyState = messages.length === 0 && !sending;

  return (
    <div className="relative flex h-full">
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        actions={paletteActions}
      />
      <ThreadSidebar
        threads={threads}
        activeId={activeId}
        open={sidebarOpen}
        onSelect={setActiveId}
        onNew={handleNew}
        onDelete={handleDelete}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 px-3 py-3 md:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 md:hidden"
            onClick={() => setSidebarOpen(true)}
            title="Threads"
          >
            <Menu className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{activeTitle}</div>
            <div className="truncate text-xs text-muted-foreground">
              {skills.length} skills
              {skills.length > 0 && ": " + skills.map((s) => s.name).join(", ")}
            </div>
          </div>
          <TokenUsage
            input={usage.input}
            output={usage.output}
            onCompact={handleCompact}
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-2"
            onClick={() => {
              const text = window.prompt(
                "Session goal (empty to clear):",
                goal?.text ?? "",
              );
              if (text === null) return;
              if (!text.trim()) void handleClearGoal();
              else void handleSetGoal(text.trim());
            }}
            title="Set session goal"
          >
            <Target className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-2"
            onClick={handleExport}
            title="Export thread as Markdown"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-2 md:px-3"
            onClick={handleReset}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Reset</span>
          </Button>
        </header>
        <Separator />
        <ScrollArea className="flex-1">
          {showEmptyState ? (
            <EmptyStateSuggestions
              onPick={(tpl) => composerRef.current?.setDraft(tpl, true)}
            />
          ) : (
            <MessageList messages={messages} threadId={activeId} />
          )}
          <div ref={scrollAnchorRef} />
        </ScrollArea>
        {followUps.length > 0 && !sending && (
          <FollowUpChips
            suggestions={followUps}
            onPick={(s) => {
              composerRef.current?.setDraft(s, false);
              setFollowUps([]);
            }}
          />
        )}
        <GoalBar goal={goal} onClear={handleClearGoal} />
        <Separator />
        <div className="pt-3">
          <Composer
            ref={composerRef}
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
      if (!ctx.assistantAdded()) {
        ctx.setAssistantAdded(true);
        return [
          ...cur,
          {
            id: ctx.assistantId,
            kind: "assistant",
            text: "",
            thinking: ev.delta,
            streaming: true,
          },
        ];
      }
      return cur.map((m) =>
        m.id === ctx.assistantId && m.kind === "assistant"
          ? { ...m, thinking: (m.thinking ?? "") + ev.delta }
          : m,
      );
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

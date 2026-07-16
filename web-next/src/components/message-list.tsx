"use client";

import { AlertTriangle, User, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/lib/types";
import { MarkdownBody } from "./markdown";
import { ToolCard } from "./tool-card";
import { ReasoningPanel } from "./reasoning-panel";
import { FeedbackButtons } from "./feedback-buttons";

export function MessageList({
  messages,
  threadId,
}: {
  messages: ChatMessage[];
  /** Passed down so per-message feedback can attribute the vote. */
  threadId: string;
}) {
  return (
    <div className="flex flex-col gap-3 py-6">
      {messages.map((m) => (
        <MessageRow key={m.id} msg={m} threadId={threadId} />
      ))}
    </div>
  );
}

function MessageRow({ msg, threadId }: { msg: ChatMessage; threadId: string }) {
  if (msg.kind === "tool") return <ToolCard msg={msg} />;

  if (msg.kind === "error") {
    return (
      <div className="mx-auto w-full max-w-3xl px-4">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />
            error
          </div>
          <div className="whitespace-pre-wrap break-words">{msg.message}</div>
        </div>
      </div>
    );
  }

  const isUser = msg.kind === "user";
  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div
        className={cn(
          "flex gap-3",
          isUser ? "flex-row-reverse" : "flex-row",
        )}
      >
        <div
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs",
            isUser
              ? "border-primary/30 bg-primary text-primary-foreground"
              : "border-border bg-muted text-muted-foreground",
          )}
        >
          {isUser ? <User className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
        </div>
        <div
          className={cn(
            "min-w-0 flex-1 rounded-lg px-4 py-3 border animate-fade-in-up",
            isUser
              ? "bg-secondary border-secondary max-w-[min(85%,42rem)] ml-auto"
              : "bg-card border-border",
          )}
        >
          {isUser && msg.skillHint && (
            <div className="mb-2 inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
              via /{msg.skillHint}
            </div>
          )}
          {msg.kind === "user" ? (
            <div className="whitespace-pre-wrap break-words text-sm">{msg.text}</div>
          ) : (
            <>
              {msg.thinking && (
                <ReasoningPanel text={msg.thinking} streaming={msg.streaming} />
              )}
              <MarkdownBody text={msg.text} />
              {msg.streaming && msg.text === "" && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:300ms]" />
                </div>
              )}
              {/* Feedback appears only after streaming completes, and only
                  when there is actual assistant text to rate. */}
              {!msg.streaming && msg.text && (
                <FeedbackButtons threadId={threadId} messageId={msg.id} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

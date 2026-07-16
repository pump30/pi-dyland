"use client";

import { ChevronRight, Wrench, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/lib/types";

export function ToolCard({
  msg,
}: {
  msg: Extract<ChatMessage, { kind: "tool" }>;
}) {
  const [open, setOpen] = useState(msg.status === "error");
  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div
        className={cn(
          "rounded-lg border bg-card text-card-foreground overflow-hidden transition-colors",
          msg.status === "error" && "border-destructive/50",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/40"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono text-xs font-medium">{msg.name}</span>
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            {msg.status === "running" && (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>running</span>
              </>
            )}
            {msg.status === "done" && (
              <>
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                <span>done</span>
              </>
            )}
            {msg.status === "error" && (
              <>
                <XCircle className="h-3 w-3 text-destructive" />
                <span className="text-destructive">error</span>
              </>
            )}
          </div>
        </button>
        {open && (
          <div className="border-t bg-muted/30 p-3 text-xs">
            <div className="mb-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Arguments
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground/90">
                {JSON.stringify(msg.args ?? {}, null, 2)}
              </pre>
            </div>
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Result
              </div>
              <pre
                className={cn(
                  "whitespace-pre-wrap break-words font-mono text-xs",
                  msg.isError ? "text-destructive" : "text-foreground/90",
                )}
              >
                {msg.result ?? "(no output yet)"}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

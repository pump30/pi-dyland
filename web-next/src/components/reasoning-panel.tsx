"use client";

import { ChevronRight, Brain } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Collapsible chain-of-thought panel. Rendered inside an assistant message
 * body when `thinking` is non-empty. Defaults collapsed — the point is to
 * keep the answer main-line clean while still surfacing the reasoning trace
 * when the user is curious. During streaming we auto-expand so the user sees
 * *something* while text_delta hasn't started yet.
 */
export function ReasoningPanel({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shouldExpand = open || Boolean(streaming);
  if (!text) return null;
  return (
    <div className="mb-2 rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            shouldExpand && "rotate-90",
          )}
        />
        <Brain className="h-3 w-3 shrink-0" />
        <span className="font-medium">Thinking</span>
        {streaming && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/70">
            <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground" />
            live
          </span>
        )}
      </button>
      {shouldExpand && (
        <div className="border-t border-muted-foreground/20 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

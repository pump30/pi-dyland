"use client";

import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { sendFeedback } from "@/lib/api";

/**
 * 👍/👎 buttons that record a rating for a specific assistant turn. Fire-and-
 * forget — errors are swallowed inside sendFeedback and the UI just goes back
 * to its resting state. The server appends to feedback.jsonl.
 */
export function FeedbackButtons({
  threadId,
  messageId,
}: {
  threadId: string;
  messageId: string;
}) {
  const [state, setState] = useState<"up" | "down" | null>(null);

  function submit(rating: "up" | "down") {
    // Toggle: clicking the active rating clears it (still logs a new entry).
    const next = state === rating ? null : rating;
    setState(next);
    if (rating) {
      void sendFeedback({ threadId, messageId, rating });
    }
  }

  return (
    <div className="mt-2 flex items-center gap-1 opacity-60 transition-opacity hover:opacity-100">
      <button
        type="button"
        onClick={() => submit("up")}
        className={cn(
          "rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          state === "up" && "text-emerald-500",
        )}
        title="Helpful"
      >
        <ThumbsUp className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => submit("down")}
        className={cn(
          "rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          state === "down" && "text-destructive",
        )}
        title="Not helpful"
      >
        <ThumbsDown className="h-3 w-3" />
      </button>
    </div>
  );
}

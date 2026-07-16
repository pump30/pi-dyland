"use client";

import type { ActionChipsPayload } from "@/lib/cards";

export function CardActionChips({
  payload,
  onPick,
}: {
  payload: ActionChipsPayload;
  onPick?: (prompt: string) => void;
}) {
  if (payload.prompts.length === 0) return null;
  return (
    <div className="my-2 flex flex-wrap gap-1.5">
      {payload.prompts.map((p, i) => (
        <button
          key={i}
          type="button"
          className="rounded-full border border-border/60 bg-card/40 px-2.5 py-1 text-xs text-foreground hover:bg-muted/40"
          onClick={() => onPick?.(p)}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

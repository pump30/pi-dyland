"use client";

import { cn } from "@/lib/utils";
import type { StatPayload } from "@/lib/cards";

export function CardStat({ payload }: { payload: StatPayload }) {
  const tone = payload.tone ?? "neutral";
  return (
    <div className="my-2 inline-flex flex-col gap-0.5 rounded-md border border-border/50 bg-card/40 px-4 py-3">
      <div className="text-xs text-muted-foreground">{payload.label}</div>
      <div className="text-2xl font-semibold tabular-nums">{payload.value}</div>
      {payload.delta && (
        <div
          className={cn(
            "text-xs",
            tone === "positive" && "text-green-500",
            tone === "negative" && "text-destructive",
            tone === "neutral" && "text-muted-foreground",
          )}
        >
          {payload.delta}
        </div>
      )}
    </div>
  );
}

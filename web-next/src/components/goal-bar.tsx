"use client";

import { Target, X } from "lucide-react";
import type { SessionGoal } from "@/lib/types";

/**
 * Persistent bar shown above the composer while a session goal is active.
 * Displays the goal text + how many auto-continuations have happened. Click
 * X to clear the goal (the same endpoint the /goal clear command uses).
 */
export function GoalBar({
  goal,
  onClear,
}: {
  goal: SessionGoal | null | undefined;
  onClear: () => void;
}) {
  if (!goal) return null;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-1">
      <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs">
        <Target className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">Goal:</span> {goal.text}
        </span>
        <span
          className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-primary"
          title="Auto-continuations used"
        >
          {goal.continuations}/5
        </span>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={onClear}
          title="Clear goal"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

"use client";

import { Coins } from "lucide-react";
import { cn } from "@/lib/utils";

const CONTEXT_WINDOW = 200_000;
// When the running total crosses this fraction of the context window, colour
// the badge amber. Model actually stops streaming near 100 %, so 60 % is a
// comfortable heads-up threshold for "consider /compact".
const WARN_FRACTION = 0.6;
const DANGER_FRACTION = 0.85;

function humanize(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function TokenUsage({
  input,
  output,
  onCompact,
}: {
  input: number;
  output: number;
  /** Optional callback so the badge doubles as the /compact affordance. */
  onCompact?: () => void;
}) {
  const total = input + output;
  const frac = total / CONTEXT_WINDOW;
  const level =
    frac >= DANGER_FRACTION ? "danger" : frac >= WARN_FRACTION ? "warn" : "ok";
  const body = (
    <>
      <Coins className="h-3 w-3" />
      <span className="tabular-nums">
        {humanize(input)} / {humanize(output)}
      </span>
      <span className="text-muted-foreground/70">·</span>
      <span className="tabular-nums text-muted-foreground/70">
        {(frac * 100).toFixed(0)}%
      </span>
    </>
  );
  const cls = cn(
    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium tabular-nums transition-colors",
    level === "ok" && "border-border bg-muted/40 text-muted-foreground",
    level === "warn" && "border-amber-500/40 bg-amber-500/10 text-amber-500",
    level === "danger" && "border-destructive/50 bg-destructive/10 text-destructive",
  );
  if (onCompact) {
    return (
      <button
        type="button"
        onClick={onCompact}
        className={cn(cls, "hover:bg-accent")}
        title={`in ${input} · out ${output} · click to /compact`}
      >
        {body}
      </button>
    );
  }
  return (
    <span className={cls} title={`in ${input} · out ${output}`}>
      {body}
    </span>
  );
}

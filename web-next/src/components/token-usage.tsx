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
  // Hover tooltip. Kept inline (no Radix Tooltip dep — see web-next/package.json).
  // Uses `group-hover` + `pointer-events-none` so it never eats clicks meant for
  // the badge itself. `usage` events only arrive after a full turn completes
  // (server.ts finally-block), which is why fresh / just-reset threads show
  // "0 / 0 · 0%" — the tooltip explains that.
  const levelHint =
    level === "danger"
      ? "Near the 200k context limit — click to /compact now."
      : level === "warn"
      ? "Getting large — consider clicking to /compact."
      : total === 0
      ? "No turns completed yet on this thread. Counters update after each reply."
      : "Click to /compact and summarize older messages.";
  const tooltip = (
    <span
      role="tooltip"
      className="pointer-events-none absolute right-0 top-full z-50 mt-1.5 hidden w-64 rounded-md border border-border bg-popover p-2.5 text-left text-[11px] font-normal leading-snug text-popover-foreground shadow-md group-hover:block group-focus-visible:block"
    >
      <span className="mb-1 block text-xs font-semibold text-foreground">
        Token usage (rough estimate)
      </span>
      <span className="mb-1 block text-muted-foreground">
        Server estimates ≈ chars ÷ 4, not the exact provider count.
      </span>
      <span className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 tabular-nums">
        <span className="text-muted-foreground">Input</span>
        <span>{input.toLocaleString()} tok</span>
        <span className="text-muted-foreground">Output</span>
        <span>{output.toLocaleString()} tok</span>
        <span className="text-muted-foreground">Total</span>
        <span>
          {total.toLocaleString()} / {CONTEXT_WINDOW.toLocaleString()} ({(frac * 100).toFixed(1)}%)
        </span>
      </span>
      <span className="mt-1.5 block text-muted-foreground">{levelHint}</span>
    </span>
  );
  if (onCompact) {
    return (
      <span className="group relative inline-block">
        <button
          type="button"
          onClick={onCompact}
          className={cn(cls, "hover:bg-accent")}
          aria-label={`Token usage: ${input} input, ${output} output, ${(frac * 100).toFixed(0)}% of context. Click to /compact.`}
        >
          {body}
        </button>
        {tooltip}
      </span>
    );
  }
  return (
    <span className="group relative inline-block">
      <span className={cls} aria-label={`Token usage: ${input} input, ${output} output`}>
        {body}
      </span>
      {tooltip}
    </span>
  );
}

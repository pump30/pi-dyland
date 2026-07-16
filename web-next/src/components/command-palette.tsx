"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Actions the palette exposes. Keep the list flat — this is a keyboard-first
 * launcher, not a full menu. Add sparingly.
 */
export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  /** Optional keyboard shortcut label shown on the right ("⌘⇧N"). */
  shortcut?: string;
  run: () => void | Promise<void>;
}

export function CommandPalette({
  open,
  onOpenChange,
  actions,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  actions: PaletteAction[];
}) {
  const [query, setQuery] = useState("");
  const [hl, setHl] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state each time the palette opens; auto-focus the input.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHl(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? actions.filter(
        (a) =>
          a.label.toLowerCase().includes(q) ||
          (a.hint ?? "").toLowerCase().includes(q),
      )
    : actions;
  const clampedHl = Math.min(hl, Math.max(0, filtered.length - 1));

  function pick(a: PaletteAction) {
    onOpenChange(false);
    // Defer so state updates settle before the caller may reopen.
    setTimeout(() => {
      void a.run();
    }, 0);
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-background/60 p-4 pt-[15vh] backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl animate-fade-in-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b px-3 py-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHl(0);
            }}
            placeholder="Type a command…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHl((h) => Math.min(filtered.length - 1, h + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHl((h) => Math.max(0, h - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const target = filtered[clampedHl];
                if (target) pick(target);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onOpenChange(false);
              }
            }}
          />
        </div>
        <ul className="max-h-80 overflow-y-auto">
          {filtered.length === 0 && (
            <li className="px-3 py-4 text-center text-xs text-muted-foreground">
              No commands match “{query}”.
            </li>
          )}
          {filtered.map((a, i) => (
            <li key={a.id}>
              <button
                type="button"
                onMouseEnter={() => setHl(i)}
                onClick={() => pick(a)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
                  i === clampedHl && "bg-accent",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{a.label}</div>
                  {a.hint && (
                    <div className="truncate text-xs text-muted-foreground">
                      {a.hint}
                    </div>
                  )}
                </div>
                {a.shortcut && (
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {a.shortcut}
                  </kbd>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

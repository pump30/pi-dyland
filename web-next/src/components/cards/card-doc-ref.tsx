"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import type { DocRefPayload } from "@/lib/cards";

export function CardDocRef({ payload }: { payload: DocRefPayload }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 rounded-md border border-border/50 bg-card/40 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{payload.name}</span>
        <span className="text-xs text-muted-foreground">
          L{payload.lineStart}–{payload.lineEnd} · {payload.score.toFixed(2)}
        </span>
      </div>
      <button
        type="button"
        className="mt-1 text-xs text-primary underline underline-offset-4"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "收起" : "展开片段"}
      </button>
      {open && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 text-xs">
          {payload.snippet}
        </pre>
      )}
    </div>
  );
}

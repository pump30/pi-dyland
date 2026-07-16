"use client";

import { useState } from "react";
import type { KeyvaluePayload } from "@/lib/cards";

export function CardKeyvalue({ payload }: { payload: KeyvaluePayload }) {
  return (
    <div className="my-2 rounded-md border border-border/50 bg-card/40">
      {payload.title && (
        <div className="border-b border-border/50 px-3 py-2 text-xs font-medium">
          {payload.title}
        </div>
      )}
      <dl className="divide-y divide-border/30 text-sm">
        {payload.entries.map((e, i) => (
          <div key={i} className="flex items-start gap-3 px-3 py-2">
            <dt className="w-1/3 shrink-0 text-xs text-muted-foreground">{e.key}</dt>
            <dd className="min-w-0 flex-1 break-words font-mono text-xs">
              <Value entry={e} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Value({ entry }: { entry: KeyvaluePayload["entries"][number] }) {
  const [revealed, setRevealed] = useState(!entry.secret);
  const shown = revealed ? entry.value : "••••••••";
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 break-all">{shown}</span>
      {entry.secret && (
        <button
          type="button"
          className="text-[10px] text-primary underline underline-offset-4"
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? "hide" : "show"}
        </button>
      )}
      {entry.copyable && (
        <button
          type="button"
          className="text-[10px] text-primary underline underline-offset-4"
          onClick={() => {
            void navigator.clipboard.writeText(entry.value);
          }}
        >
          copy
        </button>
      )}
    </div>
  );
}

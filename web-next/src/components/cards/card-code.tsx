"use client";

import type { CodePayload } from "@/lib/cards";

export function CardCode({ payload }: { payload: CodePayload }) {
  return (
    <div className="my-2 overflow-hidden rounded-md border border-border/50 bg-card/40">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-1 text-xs text-muted-foreground">
        <span>{payload.language ?? "code"}</span>
        <button
          type="button"
          className="text-primary underline underline-offset-4"
          onClick={() => {
            void navigator.clipboard.writeText(payload.code);
          }}
        >
          copy
        </button>
      </div>
      <pre className="max-h-96 overflow-auto p-3 text-xs">
        <code>{payload.code}</code>
      </pre>
    </div>
  );
}

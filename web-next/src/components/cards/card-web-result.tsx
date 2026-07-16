"use client";

import { ExternalLink } from "lucide-react";
import type { WebResultPayload } from "@/lib/cards";

export function CardWebResult({ payload }: { payload: WebResultPayload }) {
  return (
    <a
      href={payload.url}
      target="_blank"
      rel="noopener noreferrer"
      className="my-2 block rounded-md border border-border/50 bg-card/40 px-3 py-2 text-sm hover:bg-muted/40"
    >
      <div className="flex items-center gap-2">
        {payload.favicon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={payload.favicon} alt="" className="h-4 w-4 rounded" />
        ) : (
          <ExternalLink className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{payload.title}</span>
      </div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">{payload.url}</div>
      {payload.summary && (
        <div className="mt-1 line-clamp-3 text-xs text-muted-foreground">
          {payload.summary}
        </div>
      )}
    </a>
  );
}

"use client";

import type { ListPayload } from "@/lib/cards";

export function CardList({ payload }: { payload: ListPayload }) {
  return (
    <div className="my-2 rounded-md border border-border/50 bg-card/40">
      {payload.title && (
        <div className="border-b border-border/50 px-3 py-2 text-xs font-medium">
          {payload.title}
        </div>
      )}
      <ul className="divide-y divide-border/30">
        {payload.items.map((item, i) => {
          const body = (
            <div className="flex items-start gap-2 px-3 py-2 text-sm">
              {item.icon && <span className="shrink-0">{item.icon}</span>}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{item.title}</div>
                {item.subtitle && (
                  <div className="truncate text-xs text-muted-foreground">
                    {item.subtitle}
                  </div>
                )}
              </div>
            </div>
          );
          return (
            <li key={i}>
              {item.href ? (
                <a
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block hover:bg-muted/40"
                >
                  {body}
                </a>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

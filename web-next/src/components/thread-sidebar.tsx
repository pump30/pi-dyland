"use client";

import { Plus, Trash2, MessageSquare } from "lucide-react";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { cn } from "@/lib/utils";
import type { Thread } from "@/lib/types";

export function ThreadSidebar({
  threads,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  threads: Thread[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-card">
      <div className="flex items-center gap-2 px-3 py-3">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold tracking-tight">Threads</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-7 px-2"
          onClick={onNew}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          New
        </Button>
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        <ul className="space-y-0.5 p-2">
          {threads.map((t) => (
            <li key={t.id}>
              <div
                className={cn(
                  "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors",
                  t.id === activeId
                    ? "bg-secondary text-secondary-foreground"
                    : "hover:bg-accent hover:text-accent-foreground",
                )}
                onClick={() => onSelect(t.id)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {t.title || "(untitled)"}
                </span>
                {t.messageCount > 0 && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {t.messageCount}
                  </span>
                )}
                {t.id !== "default" && (
                  <button
                    type="button"
                    className="rounded p-1 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete "${t.title}"?`)) onDelete(t.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </aside>
  );
}

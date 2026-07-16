"use client";

import { Plus, Trash2, MessageSquare, X } from "lucide-react";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { cn } from "@/lib/utils";
import type { Thread } from "@/lib/types";

export function ThreadSidebar({
  threads,
  activeId,
  open,
  onSelect,
  onNew,
  onDelete,
  onClose,
}: {
  threads: Thread[];
  activeId: string;
  /** Mobile: true = drawer visible; desktop: ignored (always visible). */
  open: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** Called when user picks an item on mobile so the drawer can close. */
  onClose: () => void;
}) {
  return (
    <>
      {/* Backdrop (mobile only, when open) */}
      <div
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/60 backdrop-blur-sm transition-opacity md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        className={cn(
          "z-40 flex h-full w-64 shrink-0 flex-col border-r bg-card transition-transform",
          // Mobile: fixed drawer that slides in/out.
          "fixed inset-y-0 left-0 md:static",
          open ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-3">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold tracking-tight">Threads</span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              onClick={onNew}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              New
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 md:hidden"
              onClick={onClose}
              title="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
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
                  onClick={() => {
                    onSelect(t.id);
                    onClose();
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t.title || "(untitled)"}
                  </span>
                  {t.inFlight && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
                      title="streaming"
                    />
                  )}
                  {t.messageCount > 0 && (
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {t.messageCount}
                    </span>
                  )}
                  {t.id !== "default" && (
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground opacity-60 transition-opacity hover:bg-destructive/10 hover:text-destructive md:opacity-0 md:group-hover:opacity-100"
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
    </>
  );
}

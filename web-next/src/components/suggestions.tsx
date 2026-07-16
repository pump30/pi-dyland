"use client";

import { Sparkles, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Empty-state prompt templates shown before the first user turn on a thread.
 * Templates contain `[placeholder]` tokens; when the user picks one, we drop
 * it into the composer and let them fill in the blanks. Kept English/Chinese
 * mixed so the owner sees his own idiom.
 */
export const PROMPT_TEMPLATES: Array<{ label: string; template: string }> = [
  { label: "Summarize a source", template: "帮我总结一下 [source]，重点是 [focus]。" },
  { label: "Research a topic", template: "Research [topic] and give me the top 5 recent developments." },
  { label: "Schedule an event", template: "帮我在 [calendar] 加一个事件：[event]，时间 [time]。" },
  { label: "Draft an email", template: "帮我写一封给 [recipient] 的邮件，主题是 [subject]，语气 [tone]。" },
  { label: "Explain a concept", template: "Explain [concept] like I'm a senior engineer, in Chinese." },
  { label: "Debug an error", template: "我遇到了这个报错：\n\n```\n[error]\n```\n\n可能的原因和排查思路？" },
];

export function EmptyStateSuggestions({
  onPick,
}: {
  onPick: (template: string) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-4 flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        Quick start
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {PROMPT_TEMPLATES.map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => onPick(t.template)}
            className="group flex flex-col gap-1 rounded-lg border bg-card p-3 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent"
          >
            <div className="text-xs font-medium text-muted-foreground group-hover:text-foreground">
              {t.label}
            </div>
            <div className="text-sm text-foreground/90">{t.template}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Turn-end follow-up chips. Renders 3 suggested next-user prompts under the
 * last assistant message. Clicking a chip fills the composer.
 */
export function FollowUpChips({
  suggestions,
  onPick,
}: {
  suggestions: string[];
  onPick: (s: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2 pt-1">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Suggested follow-ups
      </div>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onPick(s)}
            className={cn(
              "group inline-flex max-w-full items-center gap-1 rounded-full border bg-card px-3 py-1 text-xs text-foreground/80 transition-colors",
              "hover:border-primary/40 hover:bg-accent hover:text-foreground",
            )}
          >
            <span className="truncate">{s}</span>
            <ArrowRight className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-70" />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Locate the first `[placeholder]` in a string and return the character
 * offsets so we can auto-select it in the textarea. Returns null when there
 * is no placeholder to highlight.
 */
export function firstPlaceholderRange(text: string): { start: number; end: number } | null {
  const m = text.match(/\[[^\]\n]+\]/);
  if (!m || m.index === undefined) return null;
  return { start: m.index, end: m.index + m[0].length };
}

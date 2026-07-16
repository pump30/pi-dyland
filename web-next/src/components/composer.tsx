"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Paperclip, Send, Square, X } from "lucide-react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { VoiceInput } from "./voice-input";
import { firstPlaceholderRange } from "./suggestions";
import { cn } from "@/lib/utils";
import type {
  AttachmentFile,
  AttachmentImage,
  Skill,
} from "@/lib/types";

const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 200 * 1024;

function humanSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file, "utf-8");
  });
}
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export interface ComposerHandle {
  /**
   * Overwrite the current draft. When `highlightPlaceholder` is true and the
   * text contains a `[placeholder]` block, we select it so the user can start
   * typing immediately.
   */
  setDraft: (text: string, highlightPlaceholder?: boolean) => void;
}

export const Composer = forwardRef<ComposerHandle, {
  skills: Skill[];
  disabled: boolean;
  /** True while a /chat SSE stream is in flight. Send button becomes Stop. */
  sending: boolean;
  onSend: (
    prompt: string,
    images: AttachmentImage[],
    files: AttachmentFile[],
    opts: { addToLibrary: boolean },
  ) => void;
  onStop: () => void;
  onError: (msg: string) => void;
}>(function Composer({
  skills,
  disabled,
  sending,
  onSend,
  onStop,
  onError,
}, ref) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<AttachmentImage[]>([]);
  const [files, setFiles] = useState<AttachmentFile[]>([]);
  const [slashHl, setSlashHl] = useState(0);
  const [addToLibrary, setAddToLibrary] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    setDraft(text, highlightPlaceholder) {
      setValue(text);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        // Grow the textarea to fit.
        ta.style.height = "auto";
        ta.style.height = Math.min(200, ta.scrollHeight) + "px";
        if (highlightPlaceholder) {
          const range = firstPlaceholderRange(text);
          if (range) ta.setSelectionRange(range.start, range.end);
          else ta.setSelectionRange(text.length, text.length);
        } else {
          ta.setSelectionRange(text.length, text.length);
        }
      });
    },
  }));

  // Slash-autocomplete: only when the whole prompt starts with a bare /token
  const slashMatch = value.match(/^\/([a-z0-9_-]*)$/i);
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase().replace(/-/g, "_") : null;
  const slashOptions =
    slashQuery !== null ? skills.filter((s) => s.name.startsWith(slashQuery)) : [];

  useEffect(() => {
    if (slashOptions.length > 0 && slashHl >= slashOptions.length) setSlashHl(0);
  }, [slashOptions.length, slashHl]);

  function pickSlash(name: string) {
    setValue(`/${name} `);
    // Focus back on textarea
    requestAnimationFrame(() => taRef.current?.focus());
  }

  async function ingest(fs: FileList | File[]) {
    for (const file of Array.from(fs)) {
      const isImage = file.type.startsWith("image/") && IMAGE_MIMES.has(file.type);
      if (isImage) {
        if (images.length >= MAX_IMAGES) {
          onError(`Too many images (max ${MAX_IMAGES}).`);
          return;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          onError(
            `Image "${file.name}" too large (${humanSize(file.size)}, max ${humanSize(MAX_IMAGE_BYTES)}).`,
          );
          return;
        }
        const dataUrl = await readAsDataUrl(file);
        const b64 = dataUrl.split(",", 2)[1] ?? "";
        setImages((cur) => [
          ...cur,
          { data: b64, mimeType: file.type, name: file.name, size: file.size },
        ]);
      } else {
        if (files.length >= MAX_FILES) {
          onError(`Too many files (max ${MAX_FILES}).`);
          return;
        }
        if (file.size > MAX_FILE_BYTES) {
          onError(
            `File "${file.name}" too large (${humanSize(file.size)}, max ${humanSize(MAX_FILE_BYTES)}).`,
          );
          return;
        }
        try {
          const content = await readAsText(file);
          setFiles((cur) => [
            ...cur,
            { name: file.name, content, size: file.size },
          ]);
        } catch (e) {
          onError(`Cannot read "${file.name}" as text.`);
        }
      }
    }
  }

  function submit() {
    if (disabled) return;
    const text = value.trim();
    if (!text && images.length === 0 && files.length === 0) return;
    onSend(text, images, files, { addToLibrary });
    setValue("");
    setImages([]);
    setFiles([]);
    setAddToLibrary(false);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      {(images.length > 0 || files.length > 0) && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {images.map((img, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-md border bg-card px-1.5 py-1 text-xs"
            >
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={img.name}
                className="h-6 w-6 rounded object-cover"
              />
              <span className="max-w-40 truncate">{img.name}</span>
              <span className="text-muted-foreground">{humanSize(img.size)}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                onClick={() =>
                  setImages((c) => c.filter((_, idx) => idx !== i))
                }
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {files.map((f, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-md border bg-card px-1.5 py-1 text-xs"
            >
              <span>📄</span>
              <span className="max-w-40 truncate">{f.name}</span>
              <span className="text-muted-foreground">{humanSize(f.size)}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setFiles((c) => c.filter((_, idx) => idx !== i))}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <label className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="h-3 w-3 rounded border-border/70 accent-primary"
            checked={addToLibrary}
            onChange={(e) => setAddToLibrary(e.target.checked)}
          />
          加入文件库 <span className="text-muted-foreground/70">(可通过 /library 管理，200KB 内)</span>
        </label>
      )}
      <div className="relative">
        {slashOptions.length > 0 && (
          <div className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-md overflow-hidden rounded-md border bg-popover shadow-lg animate-fade-in-up">
            {slashOptions.map((s, i) => (
              <div
                key={s.name}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSlash(s.name);
                }}
                onMouseEnter={() => setSlashHl(i)}
                className={cn(
                  "cursor-pointer border-b px-3 py-2 last:border-b-0",
                  i === slashHl && "bg-accent",
                )}
              >
                <div className="font-mono text-sm font-medium text-primary">
                  /{s.name}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                  {s.label || s.description.slice(0, 100)}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => fileInputRef.current?.click()}
            title="Attach files or images"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.json,.csv,.log,.py,.js,.ts,.tsx,.jsx,.sh,.yaml,.yml,.toml,.xml,.html,.css,.rs,.go,.java,.c,.cpp,.h,.rb,.php,text/*"
            className="hidden"
            onChange={async (e) => {
              if (e.target.files) await ingest(e.target.files);
              e.target.value = "";
            }}
          />
          <VoiceInput
            disabled={disabled || sending}
            onTranscript={(text) => {
              setValue((v) => (v ? v + " " + text : text));
              // Grow the textarea to fit the incoming transcript.
              requestAnimationFrame(() => {
                const ta = taRef.current;
                if (!ta) return;
                ta.style.height = "auto";
                ta.style.height = Math.min(200, ta.scrollHeight) + "px";
                ta.focus();
              });
            }}
          />
          <Textarea
            ref={taRef}
            value={value}
            placeholder="Say something to Dyland… (⌘K menu, / for skills, /goal for a session goal)"
            className="min-h-[38px] flex-1 border-0 bg-transparent px-1 py-1.5 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            rows={1}
            onChange={(e) => {
              setValue(e.target.value);
              // auto-resize
              const t = e.target as HTMLTextAreaElement;
              t.style.height = "auto";
              t.style.height = Math.min(200, t.scrollHeight) + "px";
            }}
            onKeyDown={(e) => {
              if (slashOptions.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashHl((h) => Math.min(slashOptions.length - 1, h + 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashHl((h) => Math.max(0, h - 1));
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  const picked = slashOptions[slashHl];
                  if (picked) {
                    e.preventDefault();
                    pickSlash(picked.name);
                    return;
                  }
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setValue("");
                  return;
                }
              }
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={async (e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              const fs: File[] = [];
              for (const it of items) {
                if (it.kind === "file") {
                  const f = it.getAsFile();
                  if (f) fs.push(f);
                }
              }
              if (fs.length > 0) {
                e.preventDefault();
                await ingest(fs);
              }
            }}
          />
          {sending ? (
            <Button
              size="icon"
              variant="destructive"
              className="h-8 w-8 shrink-0"
              onClick={onStop}
              title="Stop (aborts the current turn)"
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-8 w-8 shrink-0"
              disabled={disabled || (!value.trim() && images.length === 0 && files.length === 0)}
              onClick={submit}
              title="Send (Cmd/Ctrl+Enter)"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});
Composer.displayName = "Composer";

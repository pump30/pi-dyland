"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Inbox, Loader2, Search, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type RagDoc,
  type RagEvent,
  type RagJob,
  deleteRagDoc,
  listRagDocs,
  streamRagEvents,
  uploadRagFiles,
} from "@/lib/api";
import { formatBytes, formatRelativeTime } from "@/lib/utils";

const ACCEPT =
  ".pdf,.docx,.txt,.md,.markdown,.html,.htm,.json,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/html,application/json,text/csv";
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5;

const SOURCE_LABEL: Record<RagDoc["source"], string> = {
  chat: "chat",
  inbox: "inbox",
  upload: "upload",
};

export function LibraryView() {
  const [docs, setDocs] = useState<RagDoc[]>([]);
  const [jobs, setJobs] = useState<Map<string, RagJob>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    listRagDocs()
      .then(setDocs)
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    const stop = streamRagEvents(
      (ev: RagEvent) => {
        setJobs((prev) => {
          const next = new Map(prev);
          if (ev.type === "job_queued") {
            next.set(ev.job.id, ev.job);
          } else if (ev.type === "job_progress") {
            const existing = next.get(ev.id);
            if (existing) {
              next.set(ev.id, { ...existing, status: ev.status, pct: ev.pct });
            }
          } else if (ev.type === "job_done") {
            next.delete(ev.id);
            setDocs((d) => {
              const filtered = d.filter((x) => x.sha !== ev.doc.sha);
              return [ev.doc, ...filtered];
            });
          } else if (ev.type === "job_failed") {
            const existing = next.get(ev.id);
            if (existing) {
              next.set(ev.id, {
                ...existing,
                status: "failed",
                pct: 100,
                error: ev.error,
              });
            }
          } else if (ev.type === "doc_deleted") {
            setDocs((d) => d.filter((x) => x.sha !== ev.sha));
          }
          return next;
        });
      },
      (err) => setError(String(err)),
    );
    return stop;
  }, []);

  const totalBytes = useMemo(() => docs.reduce((n, d) => n + d.size, 0), [docs]);
  const filteredDocs = useMemo(() => {
    if (!filter.trim()) return docs;
    const q = filter.toLowerCase();
    return docs.filter((d) => d.name.toLowerCase().includes(q));
  }, [docs, filter]);

  const handleFiles = useCallback(async (fs: File[]) => {
    setError(null);
    const accepted = fs.filter((f) => f.size <= MAX_BYTES).slice(0, MAX_FILES);
    if (accepted.length !== fs.length) {
      setError(
        `部分文件被跳过（超过 ${MAX_BYTES / 1024 / 1024}MB 或超过一次 ${MAX_FILES} 个上限）。大文件请放到 NAS 的 $DATA_DIR/rag/inbox/ 目录。`,
      );
    }
    if (accepted.length === 0) return;
    setUploading(true);
    try {
      const payloads = await Promise.all(
        accepted.map(async (f) => ({
          name: f.name,
          mime: f.type || "application/octet-stream",
          bytes: await f.arrayBuffer(),
        })),
      );
      await uploadRagFiles(payloads);
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const fs = Array.from(e.dataTransfer.files);
      void handleFiles(fs);
    },
    [handleFiles],
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const fs = Array.from(e.target.files ?? []);
      if (fs.length > 0) void handleFiles(fs);
      if (inputRef.current) inputRef.current.value = "";
    },
    [handleFiles],
  );

  const onDelete = useCallback(async (sha: string) => {
    if (!confirm("删除这份文档？")) return;
    try {
      await deleteRagDoc(sha);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const activeJobs = Array.from(jobs.values()).filter(
    (j) => j.status !== "done" && j.status !== "failed",
  );
  const failedJobs = Array.from(jobs.values()).filter((j) => j.status === "failed");

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border/50 px-4 py-3">
        <Link
          href="/"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">返回聊天</span>
        </Link>
        <h1 className="text-base font-semibold">📚 文件库</h1>
        <span className="text-xs text-muted-foreground">
          {docs.length} 篇 · {formatBytes(totalBytes)}
        </span>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4">
        <section
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
            dragOver ? "border-primary bg-primary/5" : "border-border/60"
          }`}
        >
          <Upload className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm">拖文件到这里，或</p>
          <button
            type="button"
            className="mt-1 text-sm text-primary underline underline-offset-4"
            onClick={() => inputRef.current?.click()}
          >
            点击选择文件
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={onPick}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            PDF / DOCX / TXT / MD / HTML / JSON / CSV · 单文件 ≤ 20MB · 一次最多 5 个
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            更大的文件请放到 NAS 上的 <code>$DATA_DIR/rag/inbox/</code> 目录
          </p>
          {uploading && (
            <p className="mt-2 flex items-center justify-center gap-1 text-xs text-primary">
              <Loader2 className="h-3 w-3 animate-spin" /> 上传中…
            </p>
          )}
        </section>

        {error && (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {activeJobs.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">
              🔄 处理中 ({activeJobs.length})
            </h2>
            <ul className="space-y-2">
              {activeJobs.map((j) => (
                <li
                  key={j.id}
                  className="flex items-center gap-3 rounded-md border border-border/50 bg-card/40 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{j.name}</span>
                  <span className="h-2 w-32 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full bg-primary transition-all"
                      style={{ width: `${j.pct}%` }}
                    />
                  </span>
                  <span className="w-20 text-xs text-muted-foreground">{j.status}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {failedJobs.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-2 text-sm font-medium text-destructive">
              ❌ 失败 ({failedJobs.length})
            </h2>
            <ul className="space-y-1">
              {failedJobs.map((j) => (
                <li
                  key={j.id}
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
                >
                  <div className="truncate font-medium">{j.name}</div>
                  <div className="text-destructive/80">{j.error ?? "unknown error"}</div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-6">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-muted-foreground">📄 已入库文档</h2>
            <div className="flex items-center gap-1 rounded-md border border-border/50 px-2 py-1">
              <Search className="h-3 w-3 text-muted-foreground" />
              <input
                type="text"
                placeholder="按文件名过滤…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-40 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
              />
            </div>
          </div>
          {filteredDocs.length === 0 ? (
            <div className="rounded-md border border-border/40 bg-card/20 p-6 text-center text-sm text-muted-foreground">
              <Inbox className="mx-auto mb-2 h-6 w-6" />
              {docs.length === 0
                ? "还没有任何文档。上传一份，或让文件出现在 NAS 的 inbox 目录里。"
                : "没有匹配的文档。"}
            </div>
          ) : (
            <ul className="space-y-2">
              {filteredDocs.map((d) => (
                <li
                  key={d.sha}
                  className="flex items-center gap-3 rounded-md border border-border/50 bg-card/40 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  <span className="rounded-md border border-border/40 bg-secondary/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {SOURCE_LABEL[d.source]}
                  </span>
                  <span className="w-20 text-right text-xs text-muted-foreground">
                    {formatBytes(d.size)}
                  </span>
                  <span className="w-14 text-right text-xs text-muted-foreground">
                    {d.chunks} chk
                  </span>
                  <span className="w-20 text-right text-xs text-muted-foreground">
                    {formatRelativeTime(d.addedAt)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(d.sha)}
                    className="h-7 w-7 p-0"
                    aria-label="删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

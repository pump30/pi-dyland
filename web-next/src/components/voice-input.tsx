"use client";

import { Mic, MicOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Web Speech API types (not in lib.dom for all TS targets).
interface WebkitSpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionCtor = new () => WebkitSpeechRecognition;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Microphone button that streams recognized speech into the composer draft.
 * Uses the browser's Web Speech API (Chrome, Safari, Edge). If unsupported,
 * the button renders disabled with a tooltip; no fallback is attempted.
 *
 * `onTranscript` is called with the accumulating final transcript. The parent
 * typically appends to the current draft.
 */
export function VoiceInput({
  onTranscript,
  disabled,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const recRef = useRef<WebkitSpeechRecognition | null>(null);

  useEffect(() => {
    setSupported(getRecognitionCtor() !== null);
  }, []);

  const stop = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {
      /* ignore */
    }
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    // Reuse the instance if we have one — some browsers dislike a fresh
    // instance in rapid succession.
    const rec = new Ctor();
    rec.lang = navigator.language || "zh-CN";
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const ev = e as {
        results: ArrayLike<ArrayLike<{ transcript: string; isFinal?: boolean }>>;
      };
      const parts: string[] = [];
      for (let i = 0; i < ev.results.length; i++) {
        const alt = ev.results[i][0];
        if (alt && alt.transcript) parts.push(alt.transcript);
      }
      const text = parts.join(" ").trim();
      if (text) onTranscript(text);
    };
    rec.onerror = () => {
      setListening(false);
    };
    rec.onend = () => {
      setListening(false);
    };
    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
    }
  }, [onTranscript]);

  // Auto-stop if the user navigates away or reloads mid-recording.
  useEffect(() => stop, [stop]);

  if (supported === false) return null;

  return (
    <button
      type="button"
      onClick={() => (listening ? stop() : start())}
      disabled={disabled || !supported}
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
        listening
          ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
        (disabled || !supported) && "opacity-40",
      )}
      title={listening ? "Stop dictation" : "Start dictation"}
    >
      {listening ? (
        <MicOff className="h-4 w-4 animate-pulse" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </button>
  );
}

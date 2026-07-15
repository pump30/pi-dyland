"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export function MarkdownBody({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("prose-msg break-words text-sm", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => (
            <a target="_blank" rel="noopener noreferrer" {...props} />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

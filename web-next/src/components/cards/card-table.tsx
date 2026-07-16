"use client";

import type { TablePayload } from "@/lib/cards";

export function CardTable({ payload }: { payload: TablePayload }) {
  return (
    <div className="my-2 overflow-x-auto rounded-md border border-border/50 bg-card/40">
      {payload.title && (
        <div className="border-b border-border/50 px-3 py-2 text-xs font-medium">
          {payload.title}
        </div>
      )}
      <table className="w-full text-xs">
        <thead className="bg-muted/40">
          <tr>
            {payload.columns.map((c) => (
              <th key={c} className="px-2 py-1 text-left font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {payload.rows.map((row, i) => (
            <tr key={i} className="border-t border-border/30">
              {row.map((cell, j) => (
                <td key={j} className="px-2 py-1">
                  {cell ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

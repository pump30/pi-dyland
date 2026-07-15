import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// API base: dev uses NEXT_PUBLIC_API_BASE (defaults to http://127.0.0.1:8787),
// prod (static export served from Hono) uses same-origin relative paths.
export const API_BASE =
  typeof window !== "undefined" && window.location.port === "3000"
    ? process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8787"
    : "";

export function apiUrl(path: string) {
  return `${API_BASE}${path}`;
}

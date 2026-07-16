export type CardKind =
  | "table"
  | "list"
  | "keyvalue"
  | "stat"
  | "doc-ref"
  | "code"
  | "web-result"
  | "action-chips";

export type CardPayload = unknown;

export interface CardBlock {
  id: string;
  parent: string | null;
  kind: CardKind;
  payload: CardPayload;
}

export interface TablePayload {
  title?: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface ListPayload {
  title?: string;
  items: Array<{ title: string; subtitle?: string; icon?: string; href?: string }>;
}

export interface KeyvaluePayload {
  title?: string;
  entries: Array<{ key: string; value: string; copyable?: boolean; secret?: boolean }>;
}

export interface StatPayload {
  label: string;
  value: string | number;
  delta?: string;
  tone?: "neutral" | "positive" | "negative";
}

export interface DocRefPayload {
  name: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  snippet: string;
}

export interface CodePayload {
  language?: string;
  code: string;
}

export interface WebResultPayload {
  title: string;
  url: string;
  summary?: string;
  favicon?: string;
}

export interface ActionChipsPayload {
  prompts: string[];
}

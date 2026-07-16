"use client";

import type {
  ActionChipsPayload,
  CardKind,
  CardPayload,
  CodePayload,
  DocRefPayload,
  KeyvaluePayload,
  ListPayload,
  StatPayload,
  TablePayload,
  WebResultPayload,
} from "@/lib/cards";
import { CardTable } from "./card-table";
import { CardList } from "./card-list";
import { CardKeyvalue } from "./card-keyvalue";
import { CardStat } from "./card-stat";
import { CardDocRef } from "./card-doc-ref";
import { CardCode } from "./card-code";
import { CardWebResult } from "./card-web-result";
import { CardActionChips } from "./card-action-chips";

export function CardRenderer({
  kind,
  payload,
}: {
  kind: CardKind;
  payload: CardPayload;
}) {
  switch (kind) {
    case "table":
      return <CardTable payload={payload as TablePayload} />;
    case "list":
      return <CardList payload={payload as ListPayload} />;
    case "keyvalue":
      return <CardKeyvalue payload={payload as KeyvaluePayload} />;
    case "stat":
      return <CardStat payload={payload as StatPayload} />;
    case "doc-ref":
      return <CardDocRef payload={payload as DocRefPayload} />;
    case "code":
      return <CardCode payload={payload as CodePayload} />;
    case "web-result":
      return <CardWebResult payload={payload as WebResultPayload} />;
    case "action-chips":
      return <CardActionChips payload={payload as ActionChipsPayload} />;
    default:
      return null;
  }
}

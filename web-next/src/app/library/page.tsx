import type { Metadata } from "next";
import { LibraryView } from "@/components/library-view";

export const metadata: Metadata = {
  title: "文件库 · pi-dyland",
};

export default function LibraryPage() {
  return <LibraryView />;
}

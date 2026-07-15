import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "pi-dyland",
  description: "Personal AI assistant",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="h-screen overflow-hidden">{children}</body>
    </html>
  );
}

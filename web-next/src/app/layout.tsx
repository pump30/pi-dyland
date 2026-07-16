import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "pi-dyland",
  description: "Personal AI assistant",
};

// viewport-fit=cover + interactive-widget=resizes-content makes iOS Safari's
// dynamic viewport play nicely with the fixed-height chat layout.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#09090b",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="h-[100dvh] overflow-hidden">{children}</body>
    </html>
  );
}

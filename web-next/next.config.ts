import type { NextConfig } from "next";

// Static export so Hono can serve the built `out/` directory directly.
// - No SSR, no /api routes, no image optimization.
// - In dev (`next dev`) we can't use rewrites in export mode either, so
//   dev-server API calls go to the same origin. Run pi-dyland Hono on :8787
//   and Next dev on :3000 with `NEXT_PUBLIC_API_BASE=http://127.0.0.1:8787`
//   or open the Next dev tab and hit :8787 UI directly for testing.
// - In prod, Hono serves `out/` on :8787 so relative /threads etc. all work.
const config: NextConfig = {
  output: "export",
  reactStrictMode: true,
  trailingSlash: true,
  images: { unoptimized: true },
};

export default config;

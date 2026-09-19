import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.TAGMIX_STANDALONE === "1" ? "standalone" : undefined,
  poweredByHeader: false,
  // The CLI checker currently loses captured stdout under Node 24; the stable
  // compiler API performs the same strict validation reliably.
  experimental: {
    useTypeScriptCli: false,
  },
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;

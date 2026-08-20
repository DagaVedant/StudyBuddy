import type { NextConfig } from "next";

const reportOnlyCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/worksheets/[id]/complete": ["./models/**/*"],
  },

  // Nodemailer opens a raw TLS socket and loads its transports by path.
  // Bundling it breaks both.
  serverExternalPackages: ["nodemailer"],

  experimental: {
    viewTransition: true,
  },

  async redirects() {
    return [
      {
        source: "/worksheets/:id/review",
        destination: "/worksheets/:id/edit",
        permanent: true,
      },
      {
        source: "/worksheets/:id/verify",
        destination: "/worksheets/:id/check",
        permanent: true,
      },
    ];
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Content-Security-Policy-Report-Only", value: reportOnlyCsp },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

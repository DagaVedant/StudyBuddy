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
  /*
   * Keys here are picomatch globs matched against the route path, not literal
   * paths, so a bracketed dynamic segment cannot be written as `[id]`: inside
   * a glob that is a character class matching one of "i" or "d". It has to be
   * a `*`, which matches a segment and not a slash.
   *
   * This was checked by building with a probe file forced into each form and
   * reading the route's own `.nft.json` afterwards. `/api/worksheets/[id]/...`
   * pulled in nothing, and the escaped `\[id\]` form the Next docs show
   * pulled in nothing either; only `*` matched. The `complete` entry below had
   * therefore never done anything since the day it was added. The embedding
   * model was reaching production regardless, because nft traces it naturally
   * from six different routes, which is exactly why a silently dead include is
   * worth fixing rather than deleting: it is the safety net for the day that
   * stops being true.
   */
  outputFileTracingIncludes: {
    "/api/worksheets/*/complete": ["./models/**/*"],

    /*
     * sharp's Linux build is two packages, and only one of them can be traced.
     *
     * nft follows the JS require into `@img/sharp-linux-x64` and finds the
     * `.node` binary. It cannot follow what that binary does next, which is to
     * dlopen `libvips-cpp.so` out of a second package, so the shared library
     * was never deployed and every page upload died with ERR_DLOPEN_FAILED.
     * On Windows and macOS the question never comes up, because there libvips
     * ships inside the platform package itself.
     *
     * These two globs match nothing on a developer's machine, since npm only
     * installs the optional dependency for the platform it is running on. They
     * match on Vercel, which is the only place it matters.
     */
    "/api/worksheets/*/pages": [
      "./node_modules/@img/sharp-linux-x64/**/*",
      "./node_modules/@img/sharp-libvips-linux-x64/**/*",
    ],
  },

  // Nodemailer opens a raw TLS socket and loads its transports by path.
  // Bundling it breaks both.
  serverExternalPackages: ["nodemailer"],

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

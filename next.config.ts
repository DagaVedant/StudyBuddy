import { createHash } from "node:crypto";

import type { NextConfig } from "next";

import { themeInitScript } from "./lib/theme-script";

/**
 * Hashed rather than nonced, and computed rather than pasted.
 *
 * A nonce has to differ per response, which means opting every page out of
 * static rendering to carry one. This script never changes between requests, so
 * a hash is both cheaper and stricter. Computing it from the source string
 * means editing the script cannot silently invalidate the policy.
 */
const themeScriptHash = `'sha256-${createHash("sha256")
  .update(themeInitScript, "utf8")
  .digest("base64")}'`;

/**
 * Report-only, deliberately, and not forever.
 *
 * Next inlines its own bootstrap and flight-data scripts, which are generated
 * per build and cannot be hashed from here, so an enforced `script-src` without
 * `'unsafe-inline'` takes the whole app down. Shipping that blind is how a
 * security header becomes an outage. Report-only puts the violations in the
 * browser console and in any report endpoint pointed at it, which is the list
 * of things to fix before this is enforced.
 *
 * `frame-ancestors` is the exception and is enforced below: it is the one
 * directive that cannot be delivered by meta tag, nothing embeds this app, and
 * clickjacking a page that has a delete button is a real risk today.
 *
 * What it reported on 2026-08-10, from a walk over / and /signup:
 *
 *   - `unsafe-eval`, many times. Turbopack's dev HMR client evaluates strings.
 *     Dev only, so it is not worth loosening the policy for. Confirm it is
 *     absent from `next build && next start` before enforcing.
 *   - `https://va.vercel-scripts.com`. Real, and in production: layout.tsx
 *     mounts Vercel Web Analytics. Allowed above.
 *
 * The remaining question before enforcement is Next's own inline bootstrap
 * scripts, which is what `'unsafe-inline'` is covering. Removing it needs a
 * nonce, and a nonce needs every page to be dynamic.
 */
const reportOnlyCsp = [
  "default-src 'self'",
  // va.vercel-scripts.com is Vercel Web Analytics, which app/layout.tsx mounts
  // on every page. Found by running this policy report-only and reading the
  // console rather than by remembering it was there, which is the argument for
  // report-only in one line.
  `script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com ${themeScriptHash}`,
  // Tailwind ships a stylesheet, but the view-transition work and a few
  // components set style attributes, which 'unsafe-inline' covers here.
  "style-src 'self' 'unsafe-inline'",
  // blob: is the rasterizer: pages are rendered to a canvas and previewed
  // before they are ever uploaded. data: covers the inline SVG marks.
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  // The worker is the only thing this app talks to, and it talks inbound.
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // No `upgrade-insecure-requests` here. A report-only policy cannot act on it,
  // so browsers ignore it and log an error for every page load, which is a
  // console full of noise about a directive that was never going to do
  // anything. Strict-Transport-Security below already forces https in
  // production, which is the whole of what it would have bought.
].join("; ");

const nextConfig: NextConfig = {
  /*
   * The embedding weights, which nothing imports.
   *
   * `models/` is written by scripts/fetch-embedding-model.mjs during prebuild
   * and read at runtime through a path built from process.cwd(), so tracing
   * cannot see it: there is no import to follow. Without this the serverless
   * bundle ships the ONNX runtime and no model, and the first classification
   * falls back to downloading 23MB from huggingface.co inside an `after()`.
   *
   * Keyed to the upload completion route, which is the only one that reaches
   * classification, rather than to `/*`: the other 38 routes have no use for
   * 23MB and every one of them would carry it.
   */
  outputFileTracingIncludes: {
    "/api/worksheets/[id]/complete": ["./models/**/*"],
  },

  experimental: {
    /*
     * Opts into React's <ViewTransition> integration. Next then runs every
     * <Link> navigation inside document.startViewTransition, which is what
     * lets the route change animate instead of hard-cutting. Still flagged
     * experimental in 16.2.12; the flag is the only supported way in.
     */
    viewTransition: true,
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Enforced. Nothing here has ever been framed, and the app has
          // one-click destructive controls on the review and settings screens.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Content-Security-Policy-Report-Only", value: reportOnlyCsp },
          // Two years and preload-eligible. Only sent over HTTPS, so a local
          // http://localhost run never sees it.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          // The path can carry a worksheet id, so the full URL does not leave
          // the origin. Same-origin requests keep it, which is what the
          // rasterizer and the file routes need.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Redundant with frame-ancestors for modern browsers, kept for the
          // ones that never learned CSP.
          { key: "X-Frame-Options", value: "DENY" },
          // Nothing in this app asks for hardware. Saying so means a compromised
          // dependency cannot ask either.
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

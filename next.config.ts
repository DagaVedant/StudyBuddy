import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    /*
     * Opts into React's <ViewTransition> integration. Next then runs every
     * <Link> navigation inside document.startViewTransition, which is what
     * lets the route change animate instead of hard-cutting. Still flagged
     * experimental in 16.2.12; the flag is the only supported way in.
     */
    viewTransition: true,
  },
};

export default nextConfig;

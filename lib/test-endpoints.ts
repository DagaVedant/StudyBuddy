/**
 * Whether the e2e-only routes under `app/api/test/` will answer.
 *
 * Those routes mint an admin account and rewrite trial counters with no session
 * and no CSRF token, so reaching one on a deployed site is a complete takeover.
 * They were guarded by `ENABLE_TEST_ENDPOINTS === 'true'` alone, which is one
 * misconfigured environment variable away from exactly that.
 *
 * `NODE_ENV` is not the second condition, however much it looks like the
 * obvious one. The e2e suite runs `next build && npx next start`
 * (playwright.config.ts:44) because dev-mode compilation stalls make the timing
 * flaky, so its server reports production as loudly as the real one does.
 * Gating on it would refuse every request the suite makes.
 *
 * What actually separates the live site from a local production build is being
 * deployed. `VERCEL_ENV` is set on every Vercel deployment and on no local run,
 * so a preview is refused as firmly as production: a preview deployment that
 * hands out admin accounts is not meaningfully safer than a production one.
 */
/** Only what the guard reads. `ProcessEnv` insists on NODE_ENV, which it does not. */
interface TestEnv {
  ENABLE_TEST_ENDPOINTS?: string
  VERCEL_ENV?: string
}

export function testEndpointsEnabled(
  // Narrowed to the two variables this reads. `ProcessEnv` insists on NODE_ENV,
  // which would mean every caller and every test building a whole one.
  env: TestEnv = process.env as TestEnv,
): boolean {
  if (env.ENABLE_TEST_ENDPOINTS !== 'true') return false
  if (env.VERCEL_ENV) return false
  return true
}

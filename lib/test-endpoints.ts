interface TestEnv {
  ENABLE_TEST_ENDPOINTS?: string
  VERCEL_ENV?: string
}

export function testEndpointsEnabled(
  env: TestEnv = process.env as TestEnv,
): boolean {
  if (env.ENABLE_TEST_ENDPOINTS !== 'true') return false
  if (env.VERCEL_ENV) return false
  return true
}

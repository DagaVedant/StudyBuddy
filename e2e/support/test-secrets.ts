import { randomBytes } from 'node:crypto'

/**
 * The secrets the e2e server runs on, generated per run.
 *
 * They used to sit inline in `playwright.config.ts` as literals that looked
 * exactly like the real thing: a base64 `AUTH_SECRET`, a 32-byte key, a bearer
 * token. Nothing was wrong with them, and that is the problem. A committed
 * string shaped like a credential trips every secret scanner pointed at this
 * repository, and it is one copy-paste away from a deploy script, which is
 * precisely how this class of mistake happens.
 *
 * Generated rather than moved, so there is no constant to copy. Each is fresh
 * per run and lives only in the test server's environment.
 *
 * Nothing here needs to be stable between runs. The suite starts one server,
 * registers its own accounts against it, and throws the database away
 * afterwards, so a session cookie never has to outlive the process that issued
 * it. If something one day does, generating it here is still right and the
 * fixture should be seeded rather than pinned.
 */
export const TEST_SECRETS = {
  /** Signs the session cookie. Auth.js wants 32 bytes of base64. */
  AUTH_SECRET: randomBytes(32).toString('base64'),

  /** Seals a saved API key. `openApiKey` fails loudly on the wrong length. */
  CREDENTIALS_ENC_KEY: randomBytes(32).toString('base64'),

  /** The bearer the worker routes check with a timing-safe compare. */
  WORKER_API_TOKEN: randomBytes(24).toString('hex'),
} as const

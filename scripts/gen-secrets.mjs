import { randomBytes } from 'node:crypto'

/**
 * Prints fresh production secrets. Run with: npm run gen:secrets
 *
 * AUTH_SECRET signs session cookies. CREDENTIALS_ENC_KEY encrypts user API
 * keys at rest and must be exactly 32 bytes. Rotating CREDENTIALS_ENC_KEY
 * makes every stored API key unreadable — users would re-enter theirs.
 */
const lines = [
  `AUTH_SECRET="${randomBytes(32).toString('base64')}"`,
  `CREDENTIALS_ENC_KEY="${randomBytes(32).toString('base64')}"`,
  `WORKER_API_TOKEN="sb_worker_${randomBytes(24).toString('hex')}"`,
]

console.log(lines.join('\n'))

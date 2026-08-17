import { randomBytes } from 'node:crypto'

export const TEST_SECRETS = {
  AUTH_SECRET: randomBytes(32).toString('base64'),
  CREDENTIALS_ENC_KEY: randomBytes(32).toString('base64'),
  WORKER_API_TOKEN: randomBytes(24).toString('hex'),
} as const

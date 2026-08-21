import {randomBytes} from 'node:crypto'

const lines = [
  `AUTH_SECRET="${randomBytes(32).toString('base64')}"`,
  `CREDENTIALS_ENC_KEY="${randomBytes(32).toString('base64')}"`,
  `WORKER_API_TOKEN="sb_worker_${randomBytes(24).toString('hex')}"`,
]

console.log(lines.join('\n'))

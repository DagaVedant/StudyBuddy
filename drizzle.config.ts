import {config} from 'dotenv'
import {defineConfig} from 'drizzle-kit'

config({path: '.env.local'})

let url = ''
if (process.env.DATABASE_URL) url = process.env.DATABASE_URL

export default defineConfig({
  schema: './lib/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {url},
  strict: true,
  verbose: true,
})

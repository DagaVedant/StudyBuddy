import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// Next.js loads .env.local automatically; drizzle-kit runs outside Next, so load it here.
config({ path: '.env.local' })

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
})

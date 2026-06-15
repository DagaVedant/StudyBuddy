import { config } from 'dotenv'

config({ path: '.env.local' })

import postgres from 'postgres'

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false })

  const rows = await sql`
    select email, role, email_verified is not null as verified,
           trial_pages_used, trial_explanations_used
    from users
  `
  for (const row of rows) {
    console.log(JSON.stringify(row))
  }
  console.log('ADMIN_EMAILS =', process.env.ADMIN_EMAILS)

  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

import { config } from 'dotenv'
import { openDatabase } from '../db'

config({ path: '.env.local' })


async function main() {
  const sql = openDatabase()

  const rows = await sql`
    select email, role, email_verified is not null as verified,
           trial_worksheets_used, trial_explanations_used
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

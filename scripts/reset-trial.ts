import { config } from 'dotenv'

config({ path: '.env.local' })

import postgres from 'postgres'

/** Resets a dev account's trial counters. Usage: npx tsx scripts/reset-trial.ts <email> */
async function main() {
  const email = process.argv[2]
  if (!email) throw new Error('Usage: npx tsx scripts/reset-trial.ts <email>')

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false })

  const rows = await sql`
    update users
    set trial_worksheets_used = 0, trial_pages_used = 0,
        trial_explanations_used = 0
    where email = ${email}
    returning email
  `

  console.log(rows.length ? `reset ${rows[0].email}` : `no account: ${email}`)
  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

import { config } from 'dotenv'

config({ path: '.env.local' })


import { confirmDestructive, databaseHost, requireLocalDb } from '../_confirm'
import { openDatabase } from '../db'

async function main() {
  const email = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  if (!email) throw new Error('Usage: npx tsx scripts/repair/reset-trial.ts <email> [--yes]')

  requireLocalDb()

  const sql = openDatabase()

  const [account] = await sql<
    { email: string; worksheets: number; explanations: number }[]
  >`
    select email,
           trial_worksheets_used as worksheets,
           trial_explanations_used as explanations
    from users
    where email = ${email}
  `

  if (!account) {
    console.log(`no account: ${email}`)
    await sql.end()
    return
  }

  await confirmDestructive([
    `Reset trial counters for ${account.email} on ${databaseHost(process.env.DATABASE_URL!)}`,
    `  worksheets used:   ${account.worksheets} -> 0`,
    `  explanations used: ${account.explanations} -> 0`,
  ])

  const rows = await sql`
    update users
    set trial_worksheets_used = 0, trial_explanations_used = 0
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

import { config } from 'dotenv'

config({ path: '.env.local' })

import postgres from 'postgres'

import { confirmDestructive, databaseHost, requireLocalDb } from './_confirm'

async function main() {
  // The first argument that is not a flag, so `reset-trial --yes bob@x` does
  // not take "--yes" for the address and report "no account: --yes", which
  // reads exactly like the account not existing.
  const email = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  if (!email) throw new Error('Usage: npx tsx scripts/reset-trial.ts <email> [--yes]')

  requireLocalDb()

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false })

  // Read the counters first so the prompt can show what is being thrown away.
  // An email is one account rather than a wildcard, but it is still somebody
  // else's quota, and a typo lands on whichever real account matches.
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

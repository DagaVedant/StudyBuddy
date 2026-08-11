import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })


import {
  planNumberDuplicateMerges,
  promptSimilarity,
  type DuplicateCandidate,
} from '../lib/questions/duplicates-plan'
import { normalizeForCompare } from '../lib/questions/shape'

import { databaseHost } from './_confirm'
import { connect } from './db'

/**
 * What the printed-number merge would fold under each candidate rule.
 *
 * `planNumberDuplicateMerges` deletes a row, so what guards it is the only
 * thing between a re-read being tidied up and a real question disappearing.
 * The fix list asked for a choice-containment check; what shipped is a
 * prompt-vocabulary similarity threshold. Both are defensible from the armchair
 * and they do not agree, so this prints the disagreement against the papers
 * rather than settling it by argument. Read-only.
 *
 *   npx tsx scripts/merge-rule-compare.ts              # every worksheet
 *   npx tsx scripts/merge-rule-compare.ts edison_      # titles with this prefix
 *
 * A pair listed under DISAGREE is one where the two rules give different
 * answers, which is the entire decision. Anything under BOTH is uncontroversial.
 */

/** The containment rule the fix list named, lifted so both can be run side by side. */
function choicesContained(
  inner: { text: string }[],
  outer: { text: string }[],
): boolean {
  if (inner.length === 0 || outer.length === 0) return false

  const haystacks = outer.map((c) => normalizeForCompare(c.text)).filter(Boolean)
  if (haystacks.length === 0) return false

  return inner.every((choice) => {
    const needle = normalizeForCompare(choice.text)
    if (needle.length < 12) return false
    return haystacks.some((hay) => hay.includes(needle))
  })
}

function eitherContains(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  return choicesContained(a.choices, b.choices) || choicesContained(b.choices, a.choices)
}

function modalChoiceCount(questions: DuplicateCandidate[]): number {
  const counts = new Map<number, number>()
  for (const q of questions) {
    if (q.choices.length === 0) continue
    counts.set(q.choices.length, (counts.get(q.choices.length) ?? 0) + 1)
  }
  let best = 4
  let seen = 0
  for (const [n, c] of counts) if (c > seen) [best, seen] = [n, c]
  return best
}

const short = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 64)

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')

  const prefix = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? ''

  const sql = connect(url)

  console.log(`Reading ${databaseHost(url)}, titles "${prefix || '(all)'}"\n`)

  const sheets = await sql<{ id: string; title: string }[]>`
    select id, title from worksheets
    where title like ${prefix + '%'}
    order by title
  `

  let bothCount = 0
  let similarityOnly = 0
  let containmentOnly = 0

  for (const sheet of sheets) {
    const rows = await sql<
      {
        id: string
        printed_number: number | null
        prompt_text: string
        choices: { label: string; text: string }[] | null
      }[]
    >`
      select q.id, q.printed_number, q.prompt_text,
             coalesce(
               (select json_agg(json_build_object('label', c.label, 'text', c.text)
                                order by c.label)
                from answer_choices c where c.question_id = q.id),
               '[]'::json
             ) as choices
      from questions q
      where q.worksheet_id = ${sheet.id}
      order by q.ordinal
    `

    const questions: DuplicateCandidate[] = rows.map((r) => ({
      id: r.id,
      printedNumber: r.printed_number,
      promptText: r.prompt_text,
      choices: r.choices ?? [],
    }))

    const expected = modalChoiceCount(questions)

    // Every pair sharing a printed number, which is what the planner starts from.
    const byNumber = new Map<number, DuplicateCandidate[]>()
    for (const q of questions) {
      if (q.printedNumber === null) continue
      byNumber.set(q.printedNumber, [...(byNumber.get(q.printedNumber) ?? []), q])
    }

    const lines: string[] = []

    for (const [number, group] of [...byNumber].sort((a, b) => a[0] - b[0])) {
      if (group.length !== 2) continue

      const [a, b] = group
      const similarity = promptSimilarity(a.promptText, b.promptText)
      const bySimilarity = similarity >= 0.8
      const byContainment = eitherContains(a, b)

      if (bySimilarity && byContainment) bothCount += 1
      else if (bySimilarity) similarityOnly += 1
      else if (byContainment) containmentOnly += 1

      const verdict =
        bySimilarity && byContainment
          ? 'BOTH    '
          : bySimilarity
            ? 'DISAGREE similarity only'
            : byContainment
              ? 'DISAGREE containment only'
              : 'neither '

      lines.push(
        `  #${String(number).padStart(2)} ${verdict}  sim=${similarity.toFixed(2)}  ` +
          `contained=${byContainment}`,
      )
      lines.push(`      A ${a.choices.length}ch  ${short(a.promptText)}`)
      lines.push(`      B ${b.choices.length}ch  ${short(b.promptText)}`)
    }

    if (lines.length === 0) continue

    console.log(`${sheet.title}  (expected ${expected} choices)`)
    console.log(lines.join('\n'))

    const planned = planNumberDuplicateMerges(questions, expected)
    console.log(`  shipping rule would fold ${planned.length} pair(s)\n`)
  }

  console.log('='.repeat(66))
  console.log(`both rules agree to fold : ${bothCount}`)
  console.log(`similarity only          : ${similarityOnly}   <- deleted today, spared if containment is added`)
  console.log(`containment only         : ${containmentOnly}   <- spared today, deleted if the rule is swapped`)
  console.log(
    '\nIf both DISAGREE counts are zero the rules are equivalent on this data and\n' +
      'the shipping one stands. Any row above is a question the choice turns on.',
  )

  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

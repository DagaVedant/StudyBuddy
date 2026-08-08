import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { scoreRun, type ModelScore, type PageRun } from './score'

/**
 * Re-grades already-saved runs against a narrower page range.
 *
 * Each raw file keeps every page's extraction, so narrowing the benchmark to a
 * subset does not mean re-running the models that already finished; their
 * answers for those pages are on disk. Without this, a short run of two extra
 * models could only be compared against a table scored on a different slice of
 * the paper, which is not a comparison at all.
 */
const OUT = 'benchmark/results'
const FROM_PAGE = Number(process.env.BENCH_FROM ?? 42)
const TO_PAGE = Number(process.env.BENCH_TO ?? 58)
const EXPECTED_FROM = Number(process.env.BENCH_EXPECT_FROM ?? 58)
const EXPECTED_TOTAL = Number(process.env.BENCH_EXPECTED ?? 114)

async function main() {
  const files = (await readdir(OUT)).filter(
    (f) => f.startsWith('raw-') && f.endsWith('.json'),
  )

  console.log(
    `re-grading pages ${FROM_PAGE}-${TO_PAGE} ` +
      `against questions ${EXPECTED_FROM}-${EXPECTED_TOTAL}\n`,
  )

  for (const file of files) {
    const path = join(OUT, file)
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      score: ModelScore
      runs: PageRun[]
    }

    const inRange = parsed.runs.filter(
      (r) => r.pageNumber >= FROM_PAGE && r.pageNumber <= TO_PAGE,
    )

    if (inRange.length === 0) {
      console.log(`  ${parsed.score.model.padEnd(24)} no pages in range, left alone`)
      continue
    }

    const before = parsed.score.countRecall
    const score = scoreRun(
      parsed.score.model,
      inRange,
      EXPECTED_TOTAL,
      parsed.score.offloaded,
      EXPECTED_FROM,
    )

    // Only the score is replaced. The per-page answers stay untouched, so any
    // range can be graded again later, including the original one.
    await writeFile(path, JSON.stringify({ score, runs: parsed.runs }, null, 2))

    console.log(
      `  ${score.model.padEnd(24)} ${(before * 100).toFixed(1)}% over the full paper ` +
        `-> ${(score.countRecall * 100).toFixed(1)}% here ` +
        `(${score.found}/${EXPECTED_TOTAL - EXPECTED_FROM + 1}, ${inRange.length} pages)`,
    )
  }
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})

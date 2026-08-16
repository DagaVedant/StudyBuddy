import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import sharp from 'sharp'

import { OllamaProvider, type OllamaCallStats } from '../../lib/ai/ollama'
import { validated } from '../../lib/ai/validated'
import { rasterizePdfPages, type RasterizedPage } from './rasterize-pdf'
import { scoreRun, type ModelScore, type PageRun } from './score'

const PDF = 'benchmark/input/sample-test-a-and-explanations-2024.pdf'
const OUT = 'benchmark/results'
const FROM_PAGE = Number(process.env.BENCH_FROM ?? 1)
const TO_PAGE = Number(process.env.BENCH_TO ?? 58)
const EXPECTED_TOTAL = Number(process.env.BENCH_EXPECTED ?? 114)

/**
 * The first printed question number the chosen pages contain.
 *
 * Only 1 when the run starts at the front of the paper; scoring a slice out of
 * the middle needs it, or every question before the slice counts as missing.
 */
const EXPECTED_FROM = Number(process.env.BENCH_EXPECT_FROM ?? 1)
const OLLAMA = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'

/**
 * One attempt per page, unlike production.
 *
 * The provider now retries an empty reply, which is the right behaviour for a
 * student uploading a worksheet but the wrong one for measurement: it would
 * hide exactly the weakness this benchmark exists to expose, and would make
 * later models incomparable to the batch already scored without it.
 */
const ATTEMPTS = Number(process.env.BENCH_ATTEMPTS ?? 1)

/** Anything at or above this needs more VRAM than the card has free. */
const VRAM_BUDGET_BYTES = 14.7 * 1024 ** 3

interface Candidate {
  model: string
  sizeBytes: number
  offloaded: boolean
}

/**
 * Asks Ollama which pulled models can actually see an image.
 *
 * Discovering this rather than hardcoding a list means a model that finished
 * downloading mid-run gets picked up, and a text-only one cannot silently
 * score zero for a reason that has nothing to do with its quality.
 */
async function visionModels(): Promise<Candidate[]> {
  const tags = (await (await fetch(`${OLLAMA}/api/tags`)).json()) as {
    models?: { name: string; size: number }[]
  }

  const found: Candidate[] = []

  for (const entry of tags.models ?? []) {
    const shown = (await (
      await fetch(`${OLLAMA}/api/show`, {
        method: 'POST',
        body: JSON.stringify({ model: entry.name }),
      })
    ).json()) as { capabilities?: string[] }

    if (!shown.capabilities?.includes('vision')) continue

    found.push({
      model: entry.name,
      sizeBytes: entry.size,
      offloaded: entry.size >= VRAM_BUDGET_BYTES,
    })
  }

  // Smallest first: the models that fit finish quickly, so results start
  // landing long before anything offloaded is done.
  return found.sort((a, b) => a.sizeBytes - b.sizeBytes)
}

async function runModel(
  candidate: Candidate,
  pages: RasterizedPage[],
): Promise<PageRun[]> {
  // Appended to rather than overwritten: the callback fires inside the
  // provider, where the compiler cannot follow it, so anything assigned here
  // gets narrowed to whatever it last held. Taking the newest entry after each
  // page sidesteps that, and keeps the stats even if a page emits several
  // calls.
  const statsLog: OllamaCallStats[] = []

  const raw = new OllamaProvider({
    baseUrl: OLLAMA,
    visionModel: candidate.model,
    textModel: candidate.model,
    executionSite: 'operator_gpu',
    timeoutMs: 20 * 60_000,
    maxAttempts: ATTEMPTS,
    onStats: (s) => {
      statsLog.push(s)
    },
  })

  const provider = validated(raw)

  const runs: PageRun[] = []

  for (const page of pages) {
    const started = Date.now()

    try {
      // Pages are stored as WebP, which is what production stores, but Ollama
      // rejects WebP with a 400. The real worker converts to PNG right before
      // inference for the same reason, so this mirrors it rather than feeding
      // the models something production would never send.
      const png = await sharp(await readFile(page.file)).png().toBuffer()
      const image = new Uint8Array(png)

      const questions = await provider.extractQuestions({
        image,
        mediaType: 'image/png',
        text: page.text,
        width: page.width,
        height: page.height,
        pageNumber: page.pageNumber,
      })

      const s = statsLog.at(-1)
      runs.push({
        pageNumber: page.pageNumber,
        questions,
        rejected: 0,
        wallMs: Date.now() - started,
        promptTokens: s?.promptTokens ?? 0,
        evalTokens: s?.evalTokens ?? 0,
        evalDurationNs: s?.evalDurationNs ?? 0,
        loadDurationNs: s?.loadDurationNs ?? 0,
      })

      process.stdout.write(
        `\r  ${candidate.model}: page ${page.pageNumber}/${pages.at(-1)?.pageNumber} ` +
          `(${runs.reduce((n, r) => n + r.questions.length, 0)} questions)      `,
      )
    } catch (error) {
      const s = statsLog.at(-1)
      runs.push({
        pageNumber: page.pageNumber,
        questions: [],
        rejected: 0,
        wallMs: Date.now() - started,
        promptTokens: s?.promptTokens ?? 0,
        evalTokens: s?.evalTokens ?? 0,
        evalDurationNs: s?.evalDurationNs ?? 0,
        loadDurationNs: s?.loadDurationNs ?? 0,
        error: (error as Error).message,
      })
    }
  }

  process.stdout.write('\n')
  return runs
}

/**
 * Scores kept from earlier batches.
 *
 * The report is rewritten from scratch on every model, so a run limited to the
 * offloaded models would otherwise erase the small ones, and comparing them is
 * the entire point of the exercise. Re-running a model replaces its old score
 * rather than showing it twice.
 */
async function previousScores(rerunning: Set<string>): Promise<ModelScore[]> {
  const files = await readdir(OUT).catch(() => [] as string[])
  const kept: ModelScore[] = []

  for (const file of files) {
    if (!file.startsWith('raw-') || !file.endsWith('.json')) continue

    try {
      const { score } = JSON.parse(await readFile(join(OUT, file), 'utf8')) as {
        score?: ModelScore
      }
      if (score?.model && !rerunning.has(score.model)) kept.push(score)
    } catch {
      // A run killed mid-write leaves a truncated file; it is not worth
      // failing the whole benchmark over one unreadable result.
      console.warn(`  (ignoring unreadable ${file})`)
    }
  }

  return kept
}

function report(scores: ModelScore[], baseline?: ModelScore): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  const lines: string[] = []

  const expectedCount = EXPECTED_TOTAL - EXPECTED_FROM + 1

  lines.push(
    `# Extraction benchmark: pages ${FROM_PAGE}-${TO_PAGE}, ` +
      `questions ${EXPECTED_FROM}-${EXPECTED_TOTAL} (${expectedCount})\n`,
  )
  lines.push(
    `${ATTEMPTS} attempt${ATTEMPTS === 1 ? '' : 's'} per page. Rows emitted well above ` +
      `${expectedCount} mean the model split passages or choices into extra questions.\n`,
  )

  // Best first, so the table reads as a ranking rather than as run order.
  const ranked = [...scores].sort((a, b) => b.countRecall - a.countRecall)

  lines.push('| model | recall | found | missed | blank pages | dup | phantom | 4-choice | empty stem | rows | ms/page | ms/q | tok/s |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')

  for (const s of ranked) {
    const choicePct = s.rowsEmitted > 0 ? pct(s.choicesComplete / s.rowsEmitted) : '-'
    lines.push(
      `| ${s.model}${s.offloaded ? ' *(offloaded)*' : ''} | ${pct(s.countRecall)} | ` +
        `${s.found}/${s.expectedTotal - s.expectedFrom + 1} | ${s.missed.length} | ${s.pagesFailed} | ` +
        `${s.duplicated.length} | ` +
        `${s.phantomPairs} | ${choicePct} | ${s.emptyStems} | ${s.rowsEmitted} | ` +
        `${Math.round(s.msPerPage)} | ${Math.round(s.msPerQuestion)} | ${s.tokensPerSec.toFixed(1)} |`,
    )
  }

  if (baseline) {
    lines.push(`\n## Change vs ${baseline.model}\n`)
    lines.push('| model | recall | missed | phantom | 4-choice |')
    lines.push('|---|---|---|---|---|')

    const baseChoice =
      baseline.rowsEmitted > 0 ? baseline.choicesComplete / baseline.rowsEmitted : 0

    for (const s of ranked) {
      if (s.model === baseline.model) continue
      const choice = s.rowsEmitted > 0 ? s.choicesComplete / s.rowsEmitted : 0
      const d = (n: number) => (n >= 0 ? `+${(n * 100).toFixed(1)}pp` : `${(n * 100).toFixed(1)}pp`)
      const c = (n: number) => (n >= 0 ? `+${n}` : `${n}`)

      lines.push(
        `| ${s.model} | ${d(s.countRecall - baseline.countRecall)} | ` +
          `${c(s.missed.length - baseline.missed.length)} | ` +
          `${c(s.phantomPairs - baseline.phantomPairs)} | ${d(choice - baseChoice)} |`,
      )
    }
  }

  lines.push('\n## Missed question numbers\n')
  for (const s of ranked) {
    lines.push(`- **${s.model}**: ${s.missed.length === 0 ? 'none' : s.missed.join(', ')}`)
  }

  return lines.join('\n')
}

async function main() {
  await mkdir(OUT, { recursive: true })

  // Rebuilds the table from saved results alone. Needed after re-grading an
  // existing set against a different page range, and after abandoning a run:
  // the report is only written when a model finishes, so without this the last
  // scores on disk would have no way to reach it. Deliberately ahead of model
  // discovery, so it does not require Ollama to be up.
  if (process.env.BENCH_REPORT_ONLY === '1') {
    const saved = await previousScores(new Set())
    if (saved.length === 0) throw new Error('No saved results to report on.')

    const baseline = saved.find((s) => s.model.startsWith('qwen2.5vl'))
    await writeFile(join(OUT, 'report.md'), report(saved, baseline))
    console.log(`report rewritten from ${saved.length} saved result(s)`)
    return
  }

  const discovered = await visionModels()

  // Lets the models that fit run as one batch now and the offloaded ones go
  // separately later, without either waiting on the other.
  const only = process.env.BENCH_ONLY ?? 'all'
  const matching = discovered.filter((c) =>
    only === 'fits' ? !c.offloaded : only === 'offloaded' ? c.offloaded : true,
  )

  if (discovered.length === 0) throw new Error('No vision-capable models are pulled.')
  if (matching.length === 0) {
    throw new Error(`No vision models matched BENCH_ONLY=${only}.`)
  }

  // An offloaded model can take hours, so a run that dies partway (the machine
  // sleeping is enough) must not throw away the ones already measured. Set
  // BENCH_FORCE=1 to score a model again anyway.
  const finished = await previousScores(new Set())
  const finishedNames = new Set(finished.map((s) => s.model))
  const force = process.env.BENCH_FORCE === '1'
  const candidates = force
    ? matching
    : matching.filter((c) => !finishedNames.has(c.model))

  console.log(
    `vision models found (${discovered.length}), ` +
      `${matching.length} match BENCH_ONLY=${only}:`,
  )
  for (const c of matching) {
    const already = !force && finishedNames.has(c.model)
    console.log(
      `  ${c.model.padEnd(24)} ${(c.sizeBytes / 1024 ** 3).toFixed(1)} GB` +
        (c.offloaded ? '  [offloaded]' : '') +
        (already ? '  -> already scored, skipping' : ''),
    )
  }

  if (candidates.length === 0) {
    console.log('\nnothing left to run.')
    return
  }

  console.log(`\nrasterizing pages ${FROM_PAGE}-${TO_PAGE}...`)
  const pages = await rasterizePdfPages(PDF, join(OUT, 'pages'), FROM_PAGE, TO_PAGE)
  console.log(`  ${pages.length} pages ready\n`)

  const scores: ModelScore[] = finished.filter(
    (s) => !candidates.some((c) => c.model === s.model),
  )
  if (scores.length > 0) {
    console.log(`carrying forward ${scores.length} model(s) scored earlier\n`)
  }

  for (const candidate of candidates) {
    console.log(`running ${candidate.model}${candidate.offloaded ? ' (offloaded, slow)' : ''}`)
    const runs = await runModel(candidate, pages)

    const score = scoreRun(
      candidate.model,
      runs,
      EXPECTED_TOTAL,
      candidate.offloaded,
      EXPECTED_FROM,
    )
    scores.push(score)

    await writeFile(
      join(OUT, `raw-${candidate.model.replace(/[:/]/g, '_')}.json`),
      JSON.stringify({ score, runs }, null, 2),
    )

    console.log(
      `  recall ${(score.countRecall * 100).toFixed(1)}% | ` +
        `missed ${score.missed.length} | phantom ${score.phantomPairs} | ` +
        `${score.tokensPerSec.toFixed(1)} tok/s\n`,
    )

    // Written after every model so a long run is readable before it ends.
    const baseline = scores.find((s) => s.model.startsWith('qwen2.5vl'))
    await writeFile(join(OUT, 'report.md'), report(scores, baseline))
  }

  console.log(`done: ${join(OUT, 'report.md')}`)
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})

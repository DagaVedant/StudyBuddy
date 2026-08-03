import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import sharp from 'sharp'

import { OllamaProvider, type OllamaCallStats } from '../lib/ai/ollama'
import { rasterizePdfPages, type RasterizedPage } from './benchmark/rasterize-pdf'
import { scoreRun, type ModelScore, type PageRun } from './benchmark/score'

const PDF = 'benchmark/input/sample-test-a-and-explanations-2024.pdf'
const OUT = 'benchmark/results'
const FROM_PAGE = Number(process.env.BENCH_FROM ?? 1)
const TO_PAGE = Number(process.env.BENCH_TO ?? 58)
const EXPECTED_TOTAL = Number(process.env.BENCH_EXPECTED ?? 114)
const OLLAMA = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'

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

  const provider = new OllamaProvider({
    baseUrl: OLLAMA,
    visionModel: candidate.model,
    textModel: candidate.model,
    executionSite: 'operator_gpu',
    timeoutMs: 20 * 60_000,
    onStats: (s) => {
      statsLog.push(s)
    },
  })

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

function report(scores: ModelScore[], baseline?: ModelScore): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  const lines: string[] = []

  lines.push(`# Extraction benchmark — pages ${FROM_PAGE}-${TO_PAGE}, ${EXPECTED_TOTAL} questions\n`)

  lines.push('| model | recall | found | missed | dup | phantom | 4-choice | empty stem | rows | ms/page | ms/q | tok/s |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|')

  for (const s of scores) {
    const choicePct = s.rowsEmitted > 0 ? pct(s.choicesComplete / s.rowsEmitted) : '-'
    lines.push(
      `| ${s.model}${s.offloaded ? ' *(offloaded)*' : ''} | ${pct(s.countRecall)} | ` +
        `${s.found}/${EXPECTED_TOTAL} | ${s.missed.length} | ${s.duplicated.length} | ` +
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

    for (const s of scores) {
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
  for (const s of scores) {
    lines.push(`- **${s.model}**: ${s.missed.length === 0 ? 'none' : s.missed.join(', ')}`)
  }

  return lines.join('\n')
}

async function main() {
  await mkdir(OUT, { recursive: true })

  const candidates = await visionModels()
  if (candidates.length === 0) throw new Error('No vision-capable models are pulled.')

  console.log(`vision models found (${candidates.length}):`)
  for (const c of candidates) {
    console.log(
      `  ${c.model.padEnd(24)} ${(c.sizeBytes / 1024 ** 3).toFixed(1)} GB` +
        (c.offloaded ? '  [offloaded]' : ''),
    )
  }

  console.log(`\nrasterizing pages ${FROM_PAGE}-${TO_PAGE}...`)
  const pages = await rasterizePdfPages(PDF, join(OUT, 'pages'), FROM_PAGE, TO_PAGE)
  console.log(`  ${pages.length} pages ready\n`)

  const scores: ModelScore[] = []

  for (const candidate of candidates) {
    console.log(`running ${candidate.model}${candidate.offloaded ? ' (offloaded, slow)' : ''}`)
    const runs = await runModel(candidate, pages)

    const score = scoreRun(candidate.model, runs, EXPECTED_TOTAL, candidate.offloaded)
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

  console.log(`done — ${join(OUT, 'report.md')}`)
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})

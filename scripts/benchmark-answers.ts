import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { ANSWER_JSON_SCHEMA, ANSWER_SYSTEM, answerUserText } from '../lib/ai/prompts'
import { connect, requireDatabaseUrl } from './db'

/**
 * Which local model should derive an answer key.
 *
 * The extraction model was chosen by measurement rather than by reputation, and
 * this is the same question for a different job: reading a page and solving one
 * are not the same skill, and the 7B vision model that won the first contest has
 * no particular claim on the second.
 *
 * Scored against the papers' own answer keys. 275 stored questions carry a
 * `pdf_key` answer read out of the source PDF, which is ground truth nobody in
 * this pipeline produced, so a model cannot score well here by agreeing with
 * something the pipeline already believed.
 *
 * What matters as much as the score is the shape of the failures. A model that
 * answers 70% and admits the rest is more useful than one that answers 75% and
 * is confidently wrong about the remainder, because a derived answer is stored
 * as `ai_derived` and shown to the student as the answer. So this reports
 * refusals and confident-wrong separately rather than folding both into
 * accuracy.
 *
 * Results are written to a file as each model finishes, not only printed.
 * Node buffers stdout when it is a pipe and flushes on exit, so a run watched
 * from another process shows nothing at all until it ends: this one looked
 * stuck for an hour and had in fact finished three models. A synchronous append
 * per model is worth more than the tidiness of printing only.
 *
 *   npx tsx scripts/benchmark-answers.ts [--limit 40] [--models a,b,c] [--out path]
 */

const OLLAMA = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'

const DEFAULT_MODELS = ['qwen3.5:9b', 'gemma4:12b', 'gpt-oss:20b', 'qwen3.6:27b']

interface Scored {
  model: string
  answered: number
  correct: number
  refused: number
  confidentWrong: number
  truncated: number
  failed: number
  seconds: number
}

/** Explicit, so the negative checks in the loop narrow to the answered case. */
type AskResult =
  | { kind: 'failed' }
  | { kind: 'truncated' }
  | { kind: 'ok'; answer: string | null; confidence: number; working: string }

interface Row {
  id: string
  promptText: string
  correctAnswer: string
  choices: { label: string; text: string }[]
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

async function ask(model: string, row: Row, timeoutMs = 300_000): Promise<AskResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        format: ANSWER_JSON_SCHEMA,
        /*
         * Generous, because several of these are reasoning models and the
         * thinking comes out of the same budget as the answer. qwen3.5:9b spent
         * 1200 tokens on 3,626 characters of reasoning and emitted no content
         * at all, which scored as a failure and looked like a broken schema.
         */
        options: { temperature: 0, num_ctx: 8192, num_predict: 4096 },
        messages: [
          { role: 'system', content: ANSWER_SYSTEM },
          { role: 'user', content: answerUserText(row) },
        ],
      }),
    })

    if (!response.ok) return { kind: 'failed' as const }

    const body = (await response.json()) as {
      message?: { content?: string }
      done_reason?: string
    }
    const content = body.message?.content

    // Distinguished rather than folded into one failure count. A model that
    // ran out of budget mid-thought is telling you something different from
    // one that returned nonsense, and the fix is different too.
    if (!content) {
      return { kind: body.done_reason === 'length' ? ('truncated' as const) : ('failed' as const) }
    }

    try {
      const parsed = JSON.parse(content) as {
        answer: string | null
        confidence: number
        working: string
      }
      return { kind: 'ok' as const, ...parsed }
    } catch {
      return { kind: body.done_reason === 'length' ? ('truncated' as const) : ('failed' as const) }
    }
  } catch {
    return { kind: 'failed' as const }
  } finally {
    clearTimeout(timer)
  }
}

/** The label the model settled on, normalised to compare with a stored key. */
function label(answer: string | null, choices: Row['choices']): string | null {
  if (!answer) return null

  const trimmed = answer.trim()
  const bare = trimmed.replace(/^[('"]*([A-Ea-e])[)."'\s]*$/, '$1').toUpperCase()
  if (/^[A-E]$/.test(bare)) return bare

  // A model that answered with the option's text rather than its label is
  // right about the question and wrong about the format, which is a parsing
  // problem here and not a knowledge one.
  const match = choices.find(
    (choice) => choice.text.trim().toLowerCase() === trimmed.toLowerCase(),
  )
  return match ? match.label.toUpperCase() : null
}

async function main(): Promise<void> {
  const limit = Number(arg('limit', '40'))
  const models = arg('models', DEFAULT_MODELS.join(',')).split(',').filter(Boolean)
  const out = arg('out', 'benchmark/results/answers.txt')

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, '')

  /** Printed and appended. The append is the one that survives a kill. */
  const record = (line: string) => {
    console.log(line)
    appendFileSync(out, `${line}
`)
  }

  const sql = connect(requireDatabaseUrl())

  // Ordered, not random, so two runs compare on the same questions.
  const rows = await sql<Row[]>`
    select q.id, q.prompt_text as "promptText", q.correct_answer as "correctAnswer",
      coalesce(
        (select json_agg(json_build_object('label', c.label, 'text', c.text) order by c.label)
         from answer_choices c where c.question_id = q.id),
        '[]'::json
      ) as choices
    from questions q
    where q.correct_answer is not null
      and q.answer_source = 'pdf_key'
      and exists (select 1 from answer_choices c where c.question_id = q.id)
    order by q.id
    limit ${limit}`

  record(`${rows.length} questions, ${models.length} model(s)`)

  const scores: Scored[] = []

  for (const model of models) {
    const started = Date.now()
    const score: Scored = {
      model,
      answered: 0,
      correct: 0,
      refused: 0,
      confidentWrong: 0,
      truncated: 0,
      failed: 0,
      seconds: 0,
    }

    for (const [index, row] of rows.entries()) {
      const result = await ask(model, row)

      if (result.kind === 'failed') {
        score.failed += 1
      } else if (result.kind === 'truncated') {
        score.truncated += 1
      } else if (result.answer === null) {
        score.refused += 1
      } else {
        const chosen = label(result.answer, row.choices)
        score.answered += 1
        // Some models answer 0-100 however firmly the prompt says 0-1.
        const raw = Number(result.confidence ?? 0)
        const confidence = raw > 1 ? raw / 100 : raw
        if (chosen === row.correctAnswer.trim().toUpperCase()) score.correct += 1
        else if (confidence >= 0.5) score.confidentWrong += 1
      }

      if ((index + 1) % 10 === 0) {
        process.stdout.write(`  ${model}: ${index + 1}/${rows.length}\r`)
      }
    }

    score.seconds = Math.round((Date.now() - started) / 1000)
    scores.push(score)

    record(
      `${model.padEnd(16)} correct ${String(score.correct).padStart(3)}/${rows.length}` +
        `  refused ${score.refused}  confident-wrong ${score.confidentWrong}` +
        `  truncated ${score.truncated}  failed ${score.failed}  ${score.seconds}s`,
    )
  }

  record('--- ranked by correct, then by confident-wrong ---')
  for (const score of [...scores].sort(
    (a, b) => b.correct - a.correct || a.confidentWrong - b.confidentWrong,
  )) {
    const accuracy = rows.length ? ((score.correct / rows.length) * 100).toFixed(0) : '0'
    record(
      `  ${score.model.padEnd(16)} ${accuracy.padStart(3)}%  ` +
        `${(score.seconds / Math.max(rows.length, 1)).toFixed(1)}s/question`,
    )
  }

  await sql.end()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})

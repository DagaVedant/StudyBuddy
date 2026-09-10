import {config} from 'dotenv'

config({path: '.env.local'})

import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {ANSWER_SYSTEM} from '../../lib/ai/prompts'
import {parseModelJson} from '../../lib/ai/types'

const OUT_DIR = join('benchmark', 'results')
const KEY_FILE = join('benchmark', 'input', 'answer-key.json')
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

const DEFAULT_MODEL = 'dots-studio/dots-3-note-preview:free'
const DEFAULT_FROM = join(
  'benchmark',
  'results',
  'raw-openrouter-dots_studio_dots_3_note_preview_free.json',
)

const CONFIDENT = 0.8

type Question = {
  ordinal: number
  promptText: string
  choices: {label: string; text: string}[]
}

type Solution = {
  ordinal: number
  answer: string | null
  working: string
  confidence: number
}

type BatchRun = {
  ordinals: number[]
  solutions: Solution[]
  wallMs: number
  promptTokens: number
  evalTokens: number
  fenced: boolean
  truncated: boolean
  failed: string | null
}

type Options = {
  model: string
  from: string
  perCall: number
  maxTokens: number
  lean: boolean
}

function batchSchema(lean: boolean) {
  const properties: Record<string, unknown> = {
    ordinal: {type: 'integer'},
    answer: {anyOf: [{type: 'string'}, {type: 'null'}]},
    confidence: {type: 'number'},
  }

  const required = ['ordinal', 'answer', 'confidence']

  if (!lean) {
    properties.working = {type: 'string'}
    required.push('working')
  }

  return {
    type: 'object',
    properties: {
      solutions: {
        type: 'array',
        items: {type: 'object', properties, required, additionalProperties: false},
      },
    },
    required: ['solutions'],
    additionalProperties: false,
  }
}

function addendum(lean: boolean) {
  const lines = [
    '',
    'You are given SEVERAL questions in one request. Solve each one on its own,',
    'under every rule above, and return one entry per question.',
    '',
    'Every entry carries the ordinal of the question it answers, copied exactly',
    'from the heading. Entries may be returned in any order, but every question',
    'given to you must get exactly one entry. Never merge two questions into one',
    'entry, and never answer a question you were not given.',
  ]

  if (lean) {
    lines.push(
      '',
      'Do not return working or traps. Return only the ordinal, the answer and',
      'your confidence. Reason privately; return the verdict.',
    )
  }

  return lines.join('\n')
}

function userTextFor(questions: Question[]) {
  const lines: string[] = []

  for (const question of questions) {
    lines.push('Question ' + question.ordinal + ':')
    lines.push('<question>')
    lines.push(question.promptText)
    lines.push('</question>')

    if (question.choices.length > 0) {
      lines.push('Options:')
      for (const choice of question.choices) {
        lines.push(choice.label + ') ' + choice.text)
      }
    } else {
      lines.push('This question has no options. Answer with the value itself.')
    }

    lines.push('')
  }

  lines.push('Solve every question above.')

  return lines.join('\n')
}

function stripFences(text: string) {
  let trimmed = text.trim()

  if (!trimmed.startsWith('```')) return {text: trimmed, fenced: false}

  const firstBreak = trimmed.indexOf('\n')
  if (firstBreak === -1) return {text: trimmed, fenced: false}

  let body = trimmed.slice(firstBreak + 1)

  const closing = body.lastIndexOf('```')
  if (closing !== -1) body = body.slice(0, closing)

  return {text: body.trim(), fenced: true}
}

function readSolutions(raw: unknown): Solution[] {
  const solutions: Solution[] = []

  if (!raw || typeof raw !== 'object') return solutions

  const list = (raw as {solutions?: unknown}).solutions
  if (!Array.isArray(list)) return solutions

  for (const item of list) {
    if (!item || typeof item !== 'object') continue

    const row = item as Record<string, unknown>

    let ordinal = 0
    if (typeof row.ordinal === 'number') ordinal = row.ordinal

    let answer: string | null = null
    if (typeof row.answer === 'string') answer = row.answer

    let working = ''
    if (typeof row.working === 'string') working = row.working

    let confidence = 0
    if (typeof row.confidence === 'number') confidence = row.confidence

    solutions.push({
      ordinal: ordinal,
      answer: answer,
      working: working,
      confidence: confidence,
    })
  }

  return solutions
}

async function loadQuestions(from: string): Promise<Question[]> {
  const raw = await readFile(from, 'utf8')
  const parsed = JSON.parse(raw) as {
    runs: {
      questions: {
        ordinal: number
        prompt_text: string
        choices: {label: string; text: string}[]
      }[]
    }[]
  }

  const byOrdinal = new Map<number, Question>()

  for (const run of parsed.runs) {
    for (const question of run.questions) {
      if (byOrdinal.has(question.ordinal)) continue

      byOrdinal.set(question.ordinal, {
        ordinal: question.ordinal,
        promptText: question.prompt_text,
        choices: question.choices,
      })
    }
  }

  const questions: Question[] = []
  for (const question of byOrdinal.values()) questions.push(question)

  questions.sort(function (a, b) {
    return a.ordinal - b.ordinal
  })

  return questions
}

async function runBatch(
  options: Options,
  apiKey: string,
  questions: Question[],
): Promise<BatchRun> {
  const ordinals: number[] = []
  for (const question of questions) ordinals.push(question.ordinal)

  const started = Date.now()

  let response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://studybuddy.app',
        'X-Title': 'StudyBuddy benchmark',
      },
      signal: AbortSignal.timeout(600000),
      body: JSON.stringify({
        model: options.model,
        max_tokens: options.maxTokens,
        messages: [
          {role: 'system', content: ANSWER_SYSTEM + '\n' + addendum(options.lean)},
          {role: 'user', content: userTextFor(questions)},
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'answers',
            strict: true,
            schema: batchSchema(options.lean),
          },
        },
      }),
    })
  } catch (error) {
    return {
      ordinals: ordinals,
      solutions: [],
      wallMs: Date.now() - started,
      promptTokens: 0,
      evalTokens: 0,
      fenced: false,
      truncated: false,
      failed: (error as Error).message,
    }
  }

  const wallMs = Date.now() - started

  if (!response.ok) {
    const body = await response.text()

    return {
      ordinals: ordinals,
      solutions: [],
      wallMs: wallMs,
      promptTokens: 0,
      evalTokens: 0,
      fenced: false,
      truncated: false,
      failed: 'HTTP ' + response.status + ': ' + body.slice(0, 400),
    }
  }

  const payload = (await response.json()) as {
    choices?: {message?: {content?: string}}[]
    usage?: {prompt_tokens?: number; completion_tokens?: number}
  }

  let text = ''
  if (payload.choices && payload.choices[0]) {
    const message = payload.choices[0].message
    if (message && message.content) text = message.content
  }

  let promptTokens = 0
  let evalTokens = 0
  if (payload.usage) {
    if (payload.usage.prompt_tokens) promptTokens = payload.usage.prompt_tokens
    if (payload.usage.completion_tokens) evalTokens = payload.usage.completion_tokens
  }

  if (!text) {
    return {
      ordinals: ordinals,
      solutions: [],
      wallMs: wallMs,
      promptTokens: promptTokens,
      evalTokens: evalTokens,
      fenced: false,
      truncated: false,
      failed: 'empty response',
    }
  }

  const stripped = stripFences(text)

  let value: unknown = null
  let truncated = false

  try {
    value = JSON.parse(stripped.text)
  } catch {
    try {
      const lenient = parseModelJson(stripped.text)
      value = lenient.value
      truncated = lenient.truncated
    } catch (error) {
      return {
        ordinals: ordinals,
        solutions: [],
        wallMs: wallMs,
        promptTokens: promptTokens,
        evalTokens: evalTokens,
        fenced: stripped.fenced,
        truncated: false,
        failed: 'unparseable: ' + (error as Error).message,
      }
    }
  }

  return {
    ordinals: ordinals,
    solutions: readSolutions(value),
    wallMs: wallMs,
    promptTokens: promptTokens,
    evalTokens: evalTokens,
    fenced: stripped.fenced,
    truncated: truncated,
    failed: null,
  }
}

function numeric(value: string) {
  const cleaned = value.replace(/[\s,$]/g, '')
  if (!/^-?[0-9]*\.?[0-9]+$/.test(cleaned)) return null

  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) return null

  return parsed
}

function matches(given: string, expected: string) {
  const left = given.trim()
  const right = expected.trim()

  if (left.toUpperCase() === right.toUpperCase()) return true

  const leftNumber = numeric(left)
  const rightNumber = numeric(right)

  if (leftNumber === null || rightNumber === null) return false

  return Math.abs(leftNumber - rightNumber) < 0.0001
}

function score(
  options: Options,
  key: Record<string, string>,
  questions: Question[],
  runs: BatchRun[],
) {
  const byOrdinal = new Map<number, Solution>()

  let wallMs = 0
  let promptTokens = 0
  let evalTokens = 0
  let failedBatches = 0
  let fencedBatches = 0
  let truncatedBatches = 0

  for (const run of runs) {
    wallMs = wallMs + run.wallMs
    promptTokens = promptTokens + run.promptTokens
    evalTokens = evalTokens + run.evalTokens

    if (run.failed) failedBatches = failedBatches + 1
    if (run.fenced) fencedBatches = fencedBatches + 1
    if (run.truncated) truncatedBatches = truncatedBatches + 1

    for (const solution of run.solutions) {
      if (byOrdinal.has(solution.ordinal)) continue
      byOrdinal.set(solution.ordinal, solution)
    }
  }

  let correct = 0
  let wrong = 0
  let refused = 0
  let missing = 0
  let confidentWrong = 0
  let unkeyed = 0

  const wrongOrdinals: number[] = []
  const missingOrdinals: number[] = []

  for (const question of questions) {
    const expected = key[String(question.ordinal)]
    if (!expected) {
      unkeyed = unkeyed + 1
      continue
    }

    const solution = byOrdinal.get(question.ordinal)

    if (!solution) {
      missing = missing + 1
      missingOrdinals.push(question.ordinal)
      continue
    }

    if (solution.answer === null) {
      refused = refused + 1
      continue
    }

    if (matches(solution.answer, expected)) {
      correct = correct + 1
      continue
    }

    wrong = wrong + 1
    wrongOrdinals.push(question.ordinal)

    if (solution.confidence >= CONFIDENT) confidentWrong = confidentWrong + 1
  }

  const attempted = correct + wrong
  const keyed = questions.length - unkeyed

  let accuracy = 0
  if (attempted > 0) accuracy = correct / attempted

  let coverage = 0
  if (keyed > 0) coverage = correct / keyed

  return {
    model: options.model,
    lean: options.lean,
    perCall: options.perCall,
    calls: runs.length,
    questions: questions.length,
    keyed: keyed,
    correct: correct,
    wrong: wrong,
    refused: refused,
    missing: missing,
    unkeyed: unkeyed,
    confidentWrong: confidentWrong,
    accuracyOfAttempted: accuracy,
    coverageOfKeyed: coverage,
    wrongOrdinals: wrongOrdinals,
    missingOrdinals: missingOrdinals,
    failedBatches: failedBatches,
    fencedBatches: fencedBatches,
    truncatedBatches: truncatedBatches,
    totalWallMs: wallMs,
    promptTokens: promptTokens,
    evalTokens: evalTokens,
  }
}

function readOptions(argv: string[]): Options {
  let model = DEFAULT_MODEL
  let from = DEFAULT_FROM
  let perCall = 60
  let maxTokens = 32000
  let lean = false

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]

    if (flag === '--model' && value) model = value
    if (flag === '--from' && value) from = value
    if (flag === '--per-call' && value) perCall = Number(value)
    if (flag === '--max-tokens' && value) maxTokens = Number(value)
    if (flag === '--lean') lean = true
  }

  return {model: model, from: from, perCall: perCall, maxTokens: maxTokens, lean: lean}
}

function slugify(model: string) {
  return model.replace(/[^a-zA-Z0-9]+/g, '_')
}

async function main() {
  const options = readOptions(process.argv.slice(2))

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set. Put it in .env.local.')
    process.exit(1)
  }

  const key = JSON.parse(await readFile(KEY_FILE, 'utf8')) as Record<string, string>
  const questions = await loadQuestions(options.from)

  const batches: Question[][] = []
  for (let i = 0; i < questions.length; i = i + options.perCall) {
    batches.push(questions.slice(i, i + options.perCall))
  }

  let mode = 'with working'
  if (options.lean) mode = 'lean, answer only'

  console.log(
    options.model +
      ': ' +
      questions.length +
      ' question(s) in ' +
      batches.length +
      ' call(s), ' +
      mode,
  )

  const runs: BatchRun[] = []

  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index]

    const run = await runBatch(options, apiKey, batch)
    runs.push(run)

    let line =
      '  call ' +
      (index + 1) +
      '/' +
      batches.length +
      ' questions ' +
      batch[0].ordinal +
      '-' +
      batch[batch.length - 1].ordinal +
      ': ' +
      run.solutions.length +
      ' solution(s), ' +
      Math.round(run.wallMs / 1000) +
      's, ' +
      run.evalTokens +
      ' out tokens'

    if (run.fenced) line = line + ', FENCED'
    if (run.truncated) line = line + ', TRUNCATED'
    if (run.failed) line = line + ', FAILED: ' + run.failed

    console.log(line)
  }

  const summary = score(options, key, questions, runs)

  let name = 'raw-answers-' + slugify(options.model)
  if (options.lean) name = name + '-lean'

  const out = join(OUT_DIR, name + '.json')
  await writeFile(out, JSON.stringify({score: summary, runs: runs}, null, 1))

  console.log('')
  console.log('correct           ' + summary.correct + '/' + summary.keyed)
  console.log('wrong             ' + summary.wrong)
  console.log('refused           ' + summary.refused)
  console.log('missing           ' + summary.missing)
  console.log('confident-wrong   ' + summary.confidentWrong)
  console.log(
    'accuracy          ' +
      (summary.accuracyOfAttempted * 100).toFixed(1) +
      '% of attempted, ' +
      (summary.coverageOfKeyed * 100).toFixed(1) +
      '% of all',
  )
  console.log('wrong ordinals    ' + summary.wrongOrdinals.join(', '))
  console.log('missing ordinals  ' + summary.missingOrdinals.join(', '))
  console.log('calls             ' + summary.calls)
  console.log('fenced calls      ' + summary.fencedBatches)
  console.log('truncated calls   ' + summary.truncatedBatches)
  console.log('failed calls      ' + summary.failedBatches)
  console.log('wall              ' + Math.round(summary.totalWallMs / 1000) + 's')
  console.log('tokens in/out     ' + summary.promptTokens + '/' + summary.evalTokens)
  console.log('')
  console.log('wrote ' + out)
}

main().catch(function (error: unknown) {
  console.error((error as Error).message)
  process.exit(1)
})

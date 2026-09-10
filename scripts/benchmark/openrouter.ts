import {config} from 'dotenv'

config({path: '.env.local'})

import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import sharp from 'sharp'

import {EXTRACTION_JSON_SCHEMA, EXTRACTION_SYSTEM} from '../../lib/ai/prompts'
import {parseModelJson} from '../../lib/ai/types'

const PAGES_DIR = join('benchmark', 'results', 'pages')
const REFERENCE = join('benchmark', 'results', 'raw-qwen2.5vl_7b.json')
const OUT_DIR = join('benchmark', 'results')
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

const EXPECTED_TOTAL = 114
const REFERENCE_MISSED = [2]

type Extracted = {
  image_index: number
  page_number: number
  ordinal: number
  prompt_text: string
  question_type: string
  choices: {label: string; text: string}[]
  bbox: number[] | null
  has_figure: boolean
  topic_label: string
}

type GroupRun = {
  pages: number[]
  questions: Extracted[]
  wallMs: number
  promptTokens: number
  evalTokens: number
  fenced: boolean
  truncated: boolean
  failed: string | null
}

type Options = {
  model: string
  pages: number[]
  perCall: number
  maxTokens: number
}

function packedSchema() {
  const base = EXTRACTION_JSON_SCHEMA as unknown as {
    properties: {questions: {items: {properties: Record<string, unknown>; required: string[]}}}
  }

  const item = base.properties.questions.items

  const properties: Record<string, unknown> = {image_index: {type: 'integer'}}
  for (const key of Object.keys(item.properties)) properties[key] = item.properties[key]
  properties.topic_label = {type: 'string'}

  const required = ['image_index']
  for (const key of item.required) required.push(key)
  required.push('topic_label')

  return {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {type: 'object', properties, required, additionalProperties: false},
      },
    },
    required: ['questions'],
    additionalProperties: false,
  }
}

const PACKED_ADDENDUM = [
  '',
  'You are given SEVERAL page images in one request, in order. Each is labelled',
  'below with its page number and pixel size. Apply every rule above to each',
  'page independently, and return one combined list.',
  '',
  'Two extra fields on every question:',
  '- image_index: which image in THIS request the question came from, counting',
  '  from 1 for the first image. It is a position in this batch, nothing else.',
  '  Pages often print their own number in a header or footer. Ignore it. That',
  '  printed number is part of the page, not an answer to this field.',
  '- topic_label: a short phrase naming the skill the question tests, such as',
  '  "solving two-step linear equations". Three to six words. Never a sentence.',
  '',
  'Questions must appear in reading order across the whole batch: image by',
  'image, and within an image top to bottom.',
].join('\n')

function userTextFor(pages: {pageNumber: number; width: number; height: number}[]) {
  const lines = ['Pages in this batch, in the order the images appear:', '']

  for (const page of pages) {
    lines.push(
      '- Page ' + page.pageNumber + ', ' + page.width + 'x' + page.height + ' pixels.',
    )
  }

  lines.push('', 'Extract the questions from every page.')

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

function readQuestions(raw: unknown): Extracted[] {
  const questions: Extracted[] = []

  if (!raw || typeof raw !== 'object') return questions

  const list = (raw as {questions?: unknown}).questions
  if (!Array.isArray(list)) return questions

  for (const item of list) {
    if (!item || typeof item !== 'object') continue

    const row = item as Record<string, unknown>

    let imageIndex = 0
    if (typeof row.image_index === 'number') imageIndex = row.image_index

    let ordinal = 0
    if (typeof row.ordinal === 'number') ordinal = row.ordinal

    let promptText = ''
    if (typeof row.prompt_text === 'string') promptText = row.prompt_text

    let questionType = ''
    if (typeof row.question_type === 'string') questionType = row.question_type

    const choices: {label: string; text: string}[] = []
    if (Array.isArray(row.choices)) {
      for (const choice of row.choices) {
        if (!choice || typeof choice !== 'object') continue

        const entry = choice as Record<string, unknown>

        let label = ''
        if (typeof entry.label === 'string') label = entry.label

        let text = ''
        if (typeof entry.text === 'string') text = entry.text

        choices.push({label, text})
      }
    }

    let bbox: number[] | null = null
    if (Array.isArray(row.bbox)) bbox = row.bbox as number[]

    let hasFigure = false
    if (row.has_figure === true) hasFigure = true

    let topicLabel = ''
    if (typeof row.topic_label === 'string') topicLabel = row.topic_label

    questions.push({
      image_index: imageIndex,
      page_number: 0,
      ordinal: ordinal,
      prompt_text: promptText,
      question_type: questionType,
      choices: choices,
      bbox: bbox,
      has_figure: hasFigure,
      topic_label: topicLabel,
    })
  }

  return questions
}

function resolvePages(questions: Extracted[], group: number[]) {
  let direct = true

  for (const question of questions) {
    if (question.image_index < 1 || question.image_index > group.length) direct = false
  }

  if (direct) {
    for (const question of questions) {
      question.page_number = group[question.image_index - 1]
    }

    return false
  }

  const order: number[] = []
  for (const question of questions) {
    if (!order.includes(question.image_index)) order.push(question.image_index)
  }

  order.sort(function (a, b) {
    return a - b
  })

  const mapped = new Map<number, number>()

  for (let i = 0; i < order.length; i++) {
    let page = group[group.length - 1]
    if (i < group.length) page = group[i]

    mapped.set(order[i], page)
  }

  for (const question of questions) {
    let page = mapped.get(question.image_index)
    if (!page) page = group[0]

    question.page_number = page
  }

  return true
}

async function loadReference() {
  const raw = await readFile(REFERENCE, 'utf8')
  const parsed = JSON.parse(raw) as {runs: {pageNumber: number; questions: {ordinal: number}[]}[]}

  const byPage = new Map<number, number[]>()

  for (const run of parsed.runs) {
    const ordinals: number[] = []
    for (const question of run.questions) ordinals.push(question.ordinal)

    byPage.set(run.pageNumber, ordinals)
  }

  return byPage
}

async function loadPage(pageNumber: number) {
  let name = String(pageNumber)
  while (name.length < 3) name = '0' + name

  const body = await readFile(join(PAGES_DIR, 'page-' + name + '.webp'))
  const meta = await sharp(body).metadata()

  let width = 0
  if (meta.width) width = meta.width

  let height = 0
  if (meta.height) height = meta.height

  return {pageNumber: pageNumber, body: body, width: width, height: height}
}

async function runGroup(
  options: Options,
  apiKey: string,
  group: number[],
): Promise<GroupRun> {
  const loaded = []
  for (const pageNumber of group) loaded.push(await loadPage(pageNumber))

  const content: unknown[] = []

  for (const page of loaded) {
    const url = 'data:image/webp;base64,' + page.body.toString('base64')
    content.push({type: 'image_url', image_url: {url: url}})
  }

  content.push({type: 'text', text: userTextFor(loaded)})

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
          {role: 'system', content: EXTRACTION_SYSTEM + '\n' + PACKED_ADDENDUM},
          {role: 'user', content: content},
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {name: 'extraction', strict: true, schema: packedSchema()},
        },
      }),
    })
  } catch (error) {
    return {
      pages: group,
      questions: [],
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
      pages: group,
      questions: [],
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
      pages: group,
      questions: [],
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
        pages: group,
        questions: [],
        wallMs: wallMs,
        promptTokens: promptTokens,
        evalTokens: evalTokens,
        fenced: stripped.fenced,
        truncated: false,
        failed: 'unparseable: ' + (error as Error).message,
      }
    }
  }

  const questions = readQuestions(value)
  const recovered = resolvePages(questions, group)

  if (recovered) {
    console.log('    image_index was out of range; recovered by reading order')
  }

  return {
    pages: group,
    questions: questions,
    wallMs: wallMs,
    promptTokens: promptTokens,
    evalTokens: evalTokens,
    fenced: stripped.fenced,
    truncated: truncated,
    failed: null,
  }
}

function score(options: Options, reference: Map<number, number[]>, runs: GroupRun[]) {
  const expected = new Set<number>()

  for (const pageNumber of options.pages) {
    const ordinals = reference.get(pageNumber)
    if (!ordinals) continue

    for (const ordinal of ordinals) {
      if (ordinal >= 1 && ordinal <= EXPECTED_TOTAL) expected.add(ordinal)
    }
  }

  const seen = new Map<number, number>()
  const pageOf = new Map<number, number>()

  let rows = 0
  let choicesComplete = 0
  let emptyStems = 0
  let labelled = 0
  let wallMs = 0
  let promptTokens = 0
  let evalTokens = 0
  let failedGroups = 0
  let fencedGroups = 0
  let truncatedGroups = 0

  for (const run of runs) {
    wallMs = wallMs + run.wallMs
    promptTokens = promptTokens + run.promptTokens
    evalTokens = evalTokens + run.evalTokens

    if (run.failed) failedGroups = failedGroups + 1
    if (run.fenced) fencedGroups = fencedGroups + 1
    if (run.truncated) truncatedGroups = truncatedGroups + 1

    for (const question of run.questions) {
      rows = rows + 1

      if (question.choices.length === 4) choicesComplete = choicesComplete + 1
      if (question.prompt_text.trim().length === 0) emptyStems = emptyStems + 1
      if (question.topic_label.trim().length > 0) labelled = labelled + 1

      let count = seen.get(question.ordinal)
      if (!count) count = 0
      seen.set(question.ordinal, count + 1)

      if (!pageOf.has(question.ordinal)) pageOf.set(question.ordinal, question.page_number)
    }
  }

  const missed: number[] = []
  for (const ordinal of expected) {
    if (!seen.has(ordinal)) missed.push(ordinal)
  }
  missed.sort(function (a, b) {
    return a - b
  })

  const phantom: number[] = []
  const duplicated: number[] = []

  for (const [ordinal, count] of seen) {
    if (!expected.has(ordinal)) phantom.push(ordinal)
    if (count > 1) duplicated.push(ordinal)
  }

  phantom.sort(function (a, b) {
    return a - b
  })
  duplicated.sort(function (a, b) {
    return a - b
  })

  let pageCorrect = 0
  let pageChecked = 0

  for (const [ordinal, claimed] of pageOf) {
    let truePage = 0

    for (const pageNumber of options.pages) {
      const ordinals = reference.get(pageNumber)
      if (!ordinals) continue
      if (ordinals.includes(ordinal)) truePage = pageNumber
    }

    if (truePage === 0) continue

    pageChecked = pageChecked + 1
    if (claimed === truePage) pageCorrect = pageCorrect + 1
  }

  const found = expected.size - missed.length

  let recall = 0
  if (expected.size > 0) recall = found / expected.size

  let pageAccuracy = 0
  if (pageChecked > 0) pageAccuracy = pageCorrect / pageChecked

  let msPerPage = 0
  if (options.pages.length > 0) msPerPage = wallMs / options.pages.length

  return {
    model: options.model,
    perCall: options.perCall,
    calls: runs.length,
    pagesRun: options.pages.length,
    expectedFrom: 58,
    expectedTotal: EXPECTED_TOTAL,
    expectedHere: expected.size,
    referenceMissed: REFERENCE_MISSED,
    found: found,
    missed: missed,
    duplicated: duplicated,
    phantom: phantom,
    countRecall: recall,
    rowsEmitted: rows,
    choicesComplete: choicesComplete,
    emptyStems: emptyStems,
    topicLabelled: labelled,
    pageAttributionChecked: pageChecked,
    pageAttributionCorrect: pageCorrect,
    pageAttributionRate: pageAccuracy,
    failedGroups: failedGroups,
    fencedGroups: fencedGroups,
    truncatedGroups: truncatedGroups,
    totalWallMs: wallMs,
    msPerPage: msPerPage,
    promptTokens: promptTokens,
    evalTokens: evalTokens,
  }
}

function parsePages(value: string) {
  const pages: number[] = []

  for (const part of value.split(',')) {
    const range = part.trim()
    if (!range) continue

    const dash = range.indexOf('-')

    if (dash === -1) {
      pages.push(Number(range))
      continue
    }

    const start = Number(range.slice(0, dash))
    const end = Number(range.slice(dash + 1))

    for (let page = start; page <= end; page++) pages.push(page)
  }

  return pages
}

function readOptions(argv: string[]): Options {
  let model = ''
  let pages = parsePages('1-58')
  let perCall = 10
  let maxTokens = 16000

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]

    if (flag === '--model' && value) model = value
    if (flag === '--pages' && value) pages = parsePages(value)
    if (flag === '--per-call' && value) perCall = Number(value)
    if (flag === '--max-tokens' && value) maxTokens = Number(value)
  }

  return {model: model, pages: pages, perCall: perCall, maxTokens: maxTokens}
}

function slugify(model: string) {
  return model.replace(/[^a-zA-Z0-9]+/g, '_')
}

async function main() {
  const options = readOptions(process.argv.slice(2))

  if (!options.model) {
    console.error('Usage: tsx scripts/benchmark/openrouter.ts --model <id> [--pages 1-58] [--per-call 10] [--max-tokens 16000]')
    process.exit(1)
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set. Put it in .env.local.')
    process.exit(1)
  }

  const reference = await loadReference()

  const groups: number[][] = []
  for (let i = 0; i < options.pages.length; i = i + options.perCall) {
    groups.push(options.pages.slice(i, i + options.perCall))
  }

  console.log(
    options.model +
      ': ' +
      options.pages.length +
      ' pages in ' +
      groups.length +
      ' call(s), ' +
      options.perCall +
      ' pages per call',
  )

  const runs: GroupRun[] = []

  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]

    const run = await runGroup(options, apiKey, group)
    runs.push(run)

    let line =
      '  call ' +
      (index + 1) +
      '/' +
      groups.length +
      ' pages ' +
      group[0] +
      '-' +
      group[group.length - 1] +
      ': ' +
      run.questions.length +
      ' question(s), ' +
      Math.round(run.wallMs / 1000) +
      's, ' +
      run.evalTokens +
      ' out tokens'

    if (run.fenced) line = line + ', FENCED'
    if (run.truncated) line = line + ', TRUNCATED'
    if (run.failed) line = line + ', FAILED: ' + run.failed

    console.log(line)
  }

  const summary = score(options, reference, runs)

  const out = join(OUT_DIR, 'raw-openrouter-' + slugify(options.model) + '.json')
  await writeFile(out, JSON.stringify({score: summary, runs: runs}, null, 1))

  console.log('')
  console.log('recall            ' + (summary.countRecall * 100).toFixed(1) + '%')
  console.log('found             ' + summary.found + '/' + summary.expectedHere)
  console.log('missed            ' + summary.missed.join(', '))
  console.log('phantom           ' + summary.phantom.length)
  console.log('duplicated        ' + summary.duplicated.length)
  console.log('4-choice          ' + summary.choicesComplete + '/' + summary.rowsEmitted)
  console.log('empty stems       ' + summary.emptyStems)
  console.log('topic labelled    ' + summary.topicLabelled + '/' + summary.rowsEmitted)
  console.log(
    'page attribution  ' +
      summary.pageAttributionCorrect +
      '/' +
      summary.pageAttributionChecked +
      ' (' +
      (summary.pageAttributionRate * 100).toFixed(1) +
      '%)',
  )
  console.log('calls             ' + summary.calls)
  console.log('fenced calls      ' + summary.fencedGroups)
  console.log('truncated calls   ' + summary.truncatedGroups)
  console.log('failed calls      ' + summary.failedGroups)
  console.log('ms/page           ' + Math.round(summary.msPerPage))
  console.log('tokens in/out     ' + summary.promptTokens + '/' + summary.evalTokens)
  console.log('')
  console.log('wrote ' + out)
}

main().catch(function (error: unknown) {
  console.error((error as Error).message)
  process.exit(1)
})

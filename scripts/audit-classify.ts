import {config} from 'dotenv'

config({path: '.env.local'})

const GATE_LIVE_SINCE = '2026-09-09'

const SAMPLE_PARENT = 'competition-math.algebra'

type Row = {
  questionId: string
  promptText: string
  embedding: unknown
  assignedSlug: string | null
  subjectHint: string | null
  sampleSlug: string | null
}

type Replay = {
  questionId: string
  promptText: string
  assignedSlug: string | null
  subjectHint: string | null
  candidates: {slug: string; name: string; path: string; distance?: number}[]
  top1: string
  margin: number
  agrees: boolean
}

function asVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[]

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed as number[]
    } catch {
      return null
    }
  }

  return null
}

function pct(numerator: number, denominator: number) {
  if (denominator === 0) return '   -  '

  return ((numerator / denominator) * 100).toFixed(1).padStart(5) + '%'
}

function readFlag(name: string) {
  const argv = process.argv.slice(2)

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) return argv[i + 1]
  }

  return null
}

async function main() {
  const {db} = await import('../lib/db')
  const {and, eq, isNotNull, lt} = await import('drizzle-orm')
  const {questions, questionTopics, topics, worksheets} = await import('../lib/schema')
  const {CLASSIFY_BATCH, embed, shortlistByVector} = await import('../lib/taxonomy')

  const rows: Row[] = await db
    .select({
      questionId: questions.id,
      promptText: questions.promptText,
      embedding: questions.embedding,
      assignedSlug: topics.slug,
      subjectHint: worksheets.subjectHint,
      sampleSlug: worksheets.sampleSlug,
    })
    .from(questions)
    .innerJoin(worksheets, eq(worksheets.id, questions.worksheetId))
    .innerJoin(
      questionTopics,
      and(eq(questionTopics.questionId, questions.id), eq(questionTopics.isPrimary, true)),
    )
    .innerJoin(topics, eq(topics.id, questionTopics.topicId))
    .where(
      and(
        isNotNull(questions.embedding),
        eq(questionTopics.assignedBy, 'ai'),
        lt(worksheets.createdAt, new Date(GATE_LIVE_SINCE)),
      ),
    )

  console.log(
    rows.length +
      ' AI-tagged question(s) with embeddings from worksheets uploaded before ' +
      GATE_LIVE_SINCE,
  )

  const replays: Replay[] = []

  for (const row of rows) {
    if (row.sampleSlug) continue

    const vector = asVector(row.embedding)
    if (!vector) continue

    const candidates = await shortlistByVector(db, vector, {subjectHint: row.subjectHint})
    if (candidates.length < 2) continue

    const first = candidates[0]
    const second = candidates[1]
    if (first.distance === undefined || second.distance === undefined) continue

    replays.push({
      questionId: row.questionId,
      promptText: row.promptText,
      assignedSlug: row.assignedSlug,
      subjectHint: row.subjectHint,
      candidates: candidates,
      top1: first.slug,
      margin: second.distance - first.distance,
      agrees: first.slug === row.assignedSlug,
    })
  }

  let agreeAll = 0
  for (const replay of replays) {
    if (replay.agrees) agreeAll = agreeAll + 1
  }

  console.log('')
  console.log('Part 1. Could the embedding alone pick the topic?')
  console.log(
    '  Embedding top-1 matches what the model chose on ' +
      agreeAll +
      ' of ' +
      replays.length +
      ' (' +
      pct(agreeAll, replays.length).trim() +
      ')',
  )
  console.log('')
  console.log('  margin >=   settled   coverage   agree with model   wrong if settled')
  console.log('  ---------   -------   --------   ----------------   ----------------')

  for (let t = 0; t <= 0.1201; t = t + 0.02) {
    const threshold = Number(t.toFixed(2))

    let settled = 0
    let agree = 0

    for (const replay of replays) {
      if (replay.margin < threshold) continue

      settled = settled + 1
      if (replay.agrees) agree = agree + 1
    }

    console.log(
      '    ' +
        threshold.toFixed(2).padStart(5) +
        '     ' +
        String(settled).padStart(5) +
        '     ' +
        pct(settled, replays.length) +
        '     ' +
        pct(agree, settled) +
        '            ' +
        String(settled - agree).padStart(4),
    )
  }

  if (process.argv.includes('--tag-samples')) {
    const {resolveProvider} = await import('../lib/ai/resolve')
    const {users} = await import('../lib/schema')
    const {CACHED_SAMPLES} = await import('../lib/samples')

    const [admin] = await db
      .select({id: users.id})
      .from(users)
      .where(eq(users.role, 'admin'))
      .limit(1)

    if (!admin) throw new Error('No admin account to resolve the operator provider with.')

    const resolved = await resolveProvider(db, admin.id)
    if (resolved.executor !== 'server') {
      throw new Error('The operator provider did not resolve. Is OPENROUTER_API_KEY set?')
    }

    console.log('')
    console.log('Per-question topics for every cached sample, through ' + resolved.provider.model)

    for (const sample of CACHED_SAMPLES) {
      const flat: {ordinal: number; promptText: string}[] = []
      for (const page of sample.pages) {
        for (const question of page) {
          flat.push({ordinal: question.ordinal, promptText: question.prompt_text})
        }
      }

      const shortlisted = []
      for (const question of flat) {
        const vector = await embed(question.promptText)
        const candidates = await shortlistByVector(db, vector, {subjectHint: 'competition-math'})
        shortlisted.push({ordinal: question.ordinal, promptText: question.promptText, candidates})
      }

      const picked = new Map<number, string>()

      for (let start = 0; start < shortlisted.length; start = start + CLASSIFY_BATCH) {
        const batch = shortlisted.slice(start, start + CLASSIFY_BATCH)

        const inputs = []
        for (let index = 0; index < batch.length; index++) {
          inputs.push({
            index: index,
            promptText: batch[index].promptText,
            candidates: batch[index].candidates,
          })
        }

        const results = await resolved.provider.classifyBatch(inputs)

        for (const result of results) {
          const entry = batch[result.index]
          if (!entry) continue
          if (result.abstain || result.topic_slug === null) continue

          picked.set(entry.ordinal, result.topic_slug)
        }
      }

      console.log('')
      console.log('  ' + sample.slug + ' (' + flat.length + ' questions, ' + picked.size + ' tagged):')
      console.log('    topics: {')

      for (const question of flat) {
        const slug = picked.get(question.ordinal)
        let line = '      ' + question.ordinal + ': ' + (slug ? "'" + slug + "'," : 'null,')
        line = line.padEnd(84) + '// ' + question.promptText.replace(/\s+/g, ' ').slice(0, 44)
        console.log(line)
      }

      console.log('    },')
    }

    process.exit(0)
  }

  const live = readFlag('--live')
  if (!live) {
    console.log('')
    console.log('Pass --live N to re-classify N of those in batches through the operator key,')
    console.log('and --sample to check the algebra-25 sample against its known topic.')
    process.exit(0)
  }

  const {resolveProvider} = await import('../lib/ai/resolve')
  const {users} = await import('../lib/schema')

  const [admin] = await db
    .select({id: users.id})
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1)

  if (!admin) throw new Error('No admin account to resolve the operator provider with.')

  const resolved = await resolveProvider(db, admin.id)
  if (resolved.executor !== 'server') {
    throw new Error('The operator provider did not resolve. Is OPENROUTER_API_KEY set?')
  }

  const provider = resolved.provider

  const wanted = Number(live)
  const chosen = replays.slice(0, wanted)

  console.log('')
  console.log(
    'Part 2. Re-classifying ' +
      chosen.length +
      ' of them ' +
      CLASSIFY_BATCH +
      ' at a time through ' +
      provider.model,
  )

  let same = 0
  let different = 0
  let abstained = 0
  let missing = 0
  let calls = 0

  const disagreements: string[] = []

  for (let start = 0; start < chosen.length; start = start + CLASSIFY_BATCH) {
    const batch = chosen.slice(start, start + CLASSIFY_BATCH)

    const inputs = []
    for (let index = 0; index < batch.length; index++) {
      inputs.push({
        index: index,
        promptText: batch[index].promptText,
        candidates: batch[index].candidates,
      })
    }

    const results = await provider.classifyBatch(inputs)
    calls = calls + 1

    const byIndex = new Map<number, (typeof results)[number]>()
    for (const result of results) byIndex.set(result.index, result)

    for (let index = 0; index < batch.length; index++) {
      const result = byIndex.get(index)
      const replay = batch[index]

      if (!result) {
        missing = missing + 1
        continue
      }

      if (result.abstain || result.topic_slug === null) {
        abstained = abstained + 1
        continue
      }

      if (result.topic_slug === replay.assignedSlug) {
        same = same + 1
      } else {
        different = different + 1
        disagreements.push(
          '    "' +
            replay.promptText.replace(/\s+/g, ' ').slice(0, 60) +
            '"\n      one at a time: ' +
            replay.assignedSlug +
            '\n      in a batch:    ' +
            result.topic_slug,
        )
      }
    }
  }

  console.log('  calls           ' + calls)
  console.log('  same topic      ' + same + ' of ' + chosen.length)
  console.log('  different topic ' + different)
  console.log('  abstained       ' + abstained)
  console.log('  no entry back   ' + missing)

  if (disagreements.length > 0) {
    console.log('')
    console.log('  Where the batch disagreed with the one-at-a-time tag:')
    for (const line of disagreements) console.log(line)
  }

  if (readFlag('--sample') === null && !process.argv.includes('--sample')) {
    process.exit(0)
  }

  const {CACHED_SAMPLES} = await import('../lib/samples')

  let sample = null
  for (const candidate of CACHED_SAMPLES) {
    if (candidate.slug === 'algebra-25') sample = candidate
  }

  if (!sample) throw new Error('algebra-25 is not in CACHED_SAMPLES')

  const prompts: string[] = []
  for (const page of sample.pages) {
    for (const question of page) prompts.push(question.prompt_text)
  }

  console.log('')
  console.log(
    'Part 3. The algebra-25 sample, known topic ' +
      SAMPLE_PARENT +
      ': ' +
      prompts.length +
      ' question(s)',
  )

  const shortlisted = []
  let embeddingTop1Under = 0

  for (const promptText of prompts) {
    const vector = await embed(promptText)
    const candidates = await shortlistByVector(db, vector, {subjectHint: 'competition-math'})

    if (candidates.length > 0 && candidates[0].slug.startsWith(SAMPLE_PARENT + '.')) {
      embeddingTop1Under = embeddingTop1Under + 1
    }

    shortlisted.push({promptText: promptText, candidates: candidates})
  }

  console.log(
    '  embedding top-1 under it: ' + embeddingTop1Under + ' of ' + prompts.length,
  )

  let under = 0
  let elsewhere = 0
  let sampleAbstained = 0
  let sampleCalls = 0
  const strays: string[] = []

  for (let start = 0; start < shortlisted.length; start = start + CLASSIFY_BATCH) {
    const batch = shortlisted.slice(start, start + CLASSIFY_BATCH)

    const inputs = []
    for (let index = 0; index < batch.length; index++) {
      inputs.push({
        index: index,
        promptText: batch[index].promptText,
        candidates: batch[index].candidates,
      })
    }

    const results = await provider.classifyBatch(inputs)
    sampleCalls = sampleCalls + 1

    const byIndex = new Map<number, (typeof results)[number]>()
    for (const result of results) byIndex.set(result.index, result)

    for (let index = 0; index < batch.length; index++) {
      const result = byIndex.get(index)

      if (!result || result.abstain || result.topic_slug === null) {
        sampleAbstained = sampleAbstained + 1
        continue
      }

      if (result.topic_slug.startsWith(SAMPLE_PARENT + '.')) under = under + 1
      else elsewhere = elsewhere + 1

      strays.push(
        '    "' +
          batch[index].promptText.replace(/\s+/g, ' ').slice(0, 58).padEnd(58) +
          '" -> ' +
          result.topic_slug,
      )
    }
  }

  console.log('  calls                     ' + sampleCalls)
  console.log('  batch pick under it       ' + under + ' of ' + prompts.length)
  console.log('  batch pick elsewhere      ' + elsewhere)
  console.log('  abstained                 ' + sampleAbstained)

  if (strays.length > 0) {
    console.log('')
    console.log('  Every pick, for a human to judge:')
    for (const line of strays) console.log(line)
  }

  process.exit(0)
}

main().catch(function (error: unknown) {
  console.error((error as Error).message)
  process.exit(1)
})

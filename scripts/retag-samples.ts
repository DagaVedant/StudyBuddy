import {config} from 'dotenv'

config({path: '.env.local'})

const apply = process.argv.includes('--apply')

async function main() {
  const {db} = await import('../lib/db')
  const {and, eq, inArray} = await import('drizzle-orm')
  const {questions, questionTopics, topics, worksheets} = await import('../lib/schema')
  const {CACHED_SAMPLES} = await import('../lib/samples')

  const slugs = new Set<string>()
  for (const sample of CACHED_SAMPLES) {
    for (const ordinal of Object.keys(sample.topics)) slugs.add(sample.topics[Number(ordinal)])
  }

  const wanted: string[] = []
  for (const slug of slugs) wanted.push(slug)

  const topicRows = await db
    .select({id: topics.id, slug: topics.slug})
    .from(topics)
    .where(inArray(topics.slug, wanted))

  const topicIdBySlug = new Map<string, string>()
  for (const row of topicRows) topicIdBySlug.set(row.slug, row.id)

  for (const slug of wanted) {
    if (!topicIdBySlug.has(slug)) throw new Error('Topic ' + slug + ' is not in the database.')
  }

  let worksheetsMatched = 0
  let retagged = 0
  let alreadyRight = 0
  let heldForUser = 0

  for (const sample of CACHED_SAMPLES) {
    const prompts = new Map<string, number>()
    for (const page of sample.pages) {
      for (const question of page) prompts.set(question.prompt_text, question.ordinal)
    }

    const promptList: string[] = []
    for (const prompt of prompts.keys()) promptList.push(prompt)

    const hits = await db
      .select({
        questionId: questions.id,
        worksheetId: questions.worksheetId,
        promptText: questions.promptText,
      })
      .from(questions)
      .where(inArray(questions.promptText, promptList))

    const byWorksheet = new Map<string, typeof hits>()
    for (const hit of hits) {
      let list = byWorksheet.get(hit.worksheetId)
      if (!list) {
        list = []
        byWorksheet.set(hit.worksheetId, list)
      }
      list.push(hit)
    }

    for (const [worksheetId, rows] of byWorksheet) {
      const distinct = new Set<string>()
      for (const row of rows) distinct.add(row.promptText)

      if (distinct.size < prompts.size) continue

      const [sheet] = await db
        .select({title: worksheets.title})
        .from(worksheets)
        .where(eq(worksheets.id, worksheetId))
        .limit(1)

      worksheetsMatched = worksheetsMatched + 1

      let title = worksheetId
      if (sheet) title = sheet.title + ' (' + worksheetId + ')'

      console.log('')
      console.log(sample.slug + ' -> ' + title)

      for (const row of rows) {
        const ordinal = prompts.get(row.promptText)
        if (ordinal === undefined) continue

        const slug = sample.topics[ordinal]
        const topicId = topicIdBySlug.get(slug)
        if (!topicId) continue

        const current = await db
          .select({
            topicId: questionTopics.topicId,
            assignedBy: questionTopics.assignedBy,
            slug: topics.slug,
          })
          .from(questionTopics)
          .innerJoin(topics, eq(topics.id, questionTopics.topicId))
          .where(
            and(
              eq(questionTopics.questionId, row.questionId),
              eq(questionTopics.isPrimary, true),
            ),
          )

        let userSet = false
        let alreadyThere = false
        for (const tag of current) {
          if (tag.assignedBy === 'user') userSet = true
          if (tag.topicId === topicId) alreadyThere = true
        }

        if (userSet) {
          heldForUser = heldForUser + 1
          continue
        }

        if (alreadyThere && current.length === 1) {
          alreadyRight = alreadyRight + 1
          continue
        }

        let from = '(untagged)'
        if (current.length > 0) from = current[0].slug

        console.log('  #' + String(ordinal).padStart(2) + '  ' + from + '  ->  ' + slug)
        retagged = retagged + 1

        if (!apply) continue

        await db
          .delete(questionTopics)
          .where(
            and(
              eq(questionTopics.questionId, row.questionId),
              eq(questionTopics.assignedBy, 'ai'),
            ),
          )

        await db
          .insert(questionTopics)
          .values({
            questionId: row.questionId,
            topicId: topicId,
            confidence: 1,
            assignedBy: 'ai',
            isPrimary: true,
          })
          .onConflictDoNothing()
      }
    }
  }

  console.log('')
  console.log('worksheets matched  ' + worksheetsMatched)
  console.log('already right       ' + alreadyRight)
  console.log('held (user-set)     ' + heldForUser)
  console.log((apply ? 'retagged            ' : 'would retag         ') + retagged)

  if (!apply) {
    console.log('')
    console.log('Dry run. Pass --apply to write.')
  }

  process.exit(0)
}

main().catch(function (error: unknown) {
  console.error((error as Error).message)
  process.exit(1)
})

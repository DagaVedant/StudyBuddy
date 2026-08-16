import { config } from 'dotenv'

config({ path: '.env.local' })

import sharp from 'sharp'

import { EXTRACTION_JSON_SCHEMA, EXTRACTION_SYSTEM, extractionUserText } from '../../lib/ai/prompts'
import { parseExtraction } from '../../lib/ai/types'
import { storage } from '../../lib/storage'
import { openDatabase } from '../db'

const BASE = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'
const MODEL = process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl:7b'

async function main() {
  const [prefix, ...pageArgs] = process.argv.slice(2)
  if (!prefix || pageArgs.length === 0) {
    throw new Error('Usage: npx tsx scripts/benchmark/try-prompt.ts <title prefix> <page>...')
  }

  const sql = openDatabase()

  const [worksheet] = await sql`
    select id from worksheets where title like ${`${prefix}%`}
    order by created_at desc limit 1
  `
  if (!worksheet) throw new Error(`no worksheet matching "${prefix}"`)

  for (const raw of pageArgs) {
    const pageNumber = Number(raw)

    const [page] = await sql`
      select image_key, ocr_text, width, height from worksheet_pages
      where worksheet_id = ${worksheet.id} and page_number = ${pageNumber}
    `
    if (!page) {
      console.log(`page ${pageNumber}: not stored`)
      continue
    }

    const object = await storage.get(page.image_key)
    if (!object) {
      console.log(`page ${pageNumber}: image missing`)
      continue
    }

    const png =
      object.contentType === 'image/png' || object.contentType === 'image/jpeg'
        ? Buffer.from(object.body)
        : await sharp(Buffer.from(object.body)).png().toBuffer()

    const userText = extractionUserText({
      image: new Uint8Array(png),
      mediaType: 'image/png',
      text: page.ocr_text ?? '',
      width: page.width ?? 0,
      height: page.height ?? 0,
      pageNumber,
    })

    const response = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        format: EXTRACTION_JSON_SCHEMA,
        options: { temperature: 0, num_ctx: 32_768, num_predict: 8_192 },
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM },
          {
            role: 'user',
            content: userText,
            images: [png.toString('base64')],
          },
        ],
      }),
    })

    if (!response.ok) {
      console.log(`page ${pageNumber}: ollama ${response.status}`)
      continue
    }

    const body = (await response.json()) as { message?: { content?: string } }
    const content = body.message?.content ?? ''

    if (process.env.RAW) console.log(`\n[raw ${content.length}] ${content.slice(0, 600)}`)

    const { questions, rejected } = parseExtraction(JSON.parse(content || '{}'))

    console.log(
      `\npage ${pageNumber}: ${questions.length} questions` +
        (rejected ? ` (${rejected} rejected)` : ''),
    )
    for (const question of questions) {
      console.log(`   ${question.prompt_text.replace(/\s+/g, ' ').slice(0, 100)}`)
    }
  }

  await sql.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

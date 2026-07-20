import { config } from 'dotenv'

config({ path: '.env.local' })

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import sharp from 'sharp'

import { OllamaProvider } from '../lib/ai/ollama'
import type { TopicCandidate } from '../lib/ai/types'

const WORKSHEET_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1600">
  <rect width="1240" height="1600" fill="white"/>
  <style>
    .h { font: bold 34px Georgia, serif; fill: #111; }
    .q { font: 26px Georgia, serif; fill: #111; }
    .c { font: 24px Georgia, serif; fill: #222; }
  </style>
  <text x="70" y="90" class="h">Geometry — Unit 4 Practice</text>

  <text x="70" y="180" class="q">1. In triangle ABC, angle A = 40 and angle B = 65.</text>
  <text x="70" y="215" class="q">   What is the measure of angle C?</text>
  <text x="110" y="260" class="c">A. 75</text>
  <text x="310" y="260" class="c">B. 105</text>
  <text x="510" y="260" class="c">C. 115</text>
  <text x="710" y="260" class="c">D. 25</text>

  <text x="70" y="350" class="q">2. A right triangle has legs of length 6 and 8.</text>
  <text x="70" y="385" class="q">   Find the length of the hypotenuse.</text>
  <text x="110" y="430" class="c">A. 10</text>
  <text x="310" y="430" class="c">B. 12</text>
  <text x="510" y="430" class="c">C. 14</text>
  <text x="710" y="430" class="c">D. 48</text>

  <text x="70" y="520" class="q">3. Solve for x:  3x + 7 = 25</text>
  <text x="110" y="565" class="c">A. 4</text>
  <text x="310" y="565" class="c">B. 6</text>
  <text x="510" y="565" class="c">C. 9</text>
  <text x="710" y="565" class="c">D. 32</text>

  <text x="70" y="655" class="q">4. Factor completely:  x^2 - 49</text>
  <text x="110" y="700" class="c">A. (x-7)(x+7)</text>
  <text x="410" y="700" class="c">B. (x-7)^2</text>
  <text x="710" y="700" class="c">C. (x+7)^2</text>

  <text x="70" y="790" class="q">5. Explain why the exterior angle of a triangle equals</text>
  <text x="70" y="825" class="q">   the sum of the two remote interior angles.</text>
</svg>
`

const EXPECTED = 5

const CANDIDATES: TopicCandidate[] = [
  {
    slug: 'high-school-math.geometry.triangles.triangle-angle-sum',
    name: 'Triangle angle sum',
    path: 'Geometry › Triangles › Triangle angle sum',
  },
  {
    slug: 'high-school-math.geometry.right-triangles-and-trigonometry.pythagorean-theorem',
    name: 'Pythagorean theorem',
    path: 'Geometry › Right triangles and trigonometry › Pythagorean theorem',
  },
  {
    slug: 'high-school-math.algebra-1.factoring.difference-of-squares',
    name: 'Difference of squares',
    path: 'Algebra 1 › Factoring › Difference of squares',
  },
  {
    slug: 'high-school-math.algebra-1.linear-equations-and-inequalities.multi-step-equations',
    name: 'Multi-step equations',
    path: 'Algebra 1 › Linear equations and inequalities › Multi-step equations',
  },
  {
    slug: 'ela.rhetoric-and-argument.claim-and-thesis',
    name: 'Claim and thesis',
    path: 'ELA › Rhetoric and argument › Claim and thesis',
  },
]

function seconds(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`
}

async function main() {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'
  const visionModel = process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl:7b'

  const provider = new OllamaProvider({
    baseUrl,
    visionModel,
    textModel: visionModel,
    executionSite: 'operator_gpu',
  })

  console.log(`Ollama: ${baseUrl}`)
  console.log(`Model:  ${visionModel}\n`)

  const models = await provider.listModels()
  if (!models.includes(visionModel)) {
    throw new Error(`${visionModel} is not pulled. Have: ${models.join(', ')}`)
  }

  const png = await sharp(Buffer.from(WORKSHEET_SVG)).png().toBuffer()
  const outPath = join(process.cwd(), '.uploads', 'benchmark-page.png')
  await writeFile(outPath, png).catch(() => {})

  console.log('--- Extraction (vision) ---')
  let start = Date.now()
  const questions = await provider.extractQuestions({
    image: png,
    mediaType: 'image/png',
    text: '',
    width: 1240,
    height: 1600,
    pageNumber: 1,
  })
  const extractTime = seconds(start)

  console.log(`Found ${questions.length} of ${EXPECTED} questions in ${extractTime}`)
  for (const question of questions) {
    const choices = question.choices.map((c) => c.label).join('')
    console.log(
      `  ${String(question.ordinal).padStart(2)}. [${question.question_type}] ` +
        `${question.prompt_text.slice(0, 68)}${choices ? `  (${choices})` : ''}`,
    )
  }

  console.log('\n--- Classification (text) ---')
  const expectations: [string, string][] = [
    ['In triangle ABC, angle A = 40 and angle B = 65. What is angle C?', 'triangle-angle-sum'],
    ['A right triangle has legs 6 and 8. Find the hypotenuse.', 'pythagorean-theorem'],
    ['Factor completely: x^2 - 49', 'difference-of-squares'],
    ['Solve for x: 3x + 7 = 25', 'multi-step-equations'],
  ]

  let correct = 0
  for (const [question, expectedSuffix] of expectations) {
    start = Date.now()
    try {
      const result = await provider.classifyTopic(question, CANDIDATES)
      const hit = result.topic_slug?.endsWith(expectedSuffix) ?? false
      if (hit) correct += 1
      console.log(
        `  ${hit ? 'OK  ' : 'MISS'} ${question.slice(0, 46).padEnd(48)} -> ` +
          `${result.topic_slug?.split('.').pop() ?? '(abstain)'} ` +
          `[conf ${result.confidence.toFixed(2)}, ${seconds(start)}]`,
      )
    } catch (error) {
      console.log(
        `  ERR  ${question.slice(0, 46).padEnd(48)} -> ${(error as Error).message.slice(0, 80)}`,
      )
    }
  }
  console.log(`  ${correct}/${expectations.length} correct`)

  console.log('\n--- Explanation (text) ---')
  start = Date.now()
  const explanation = await provider.explain({
    promptText: 'In triangle ABC, angle A = 40 and angle B = 65. What is the measure of angle C?',
    choices: [
      { label: 'A', text: '75' },
      { label: 'B', text: '105' },
      { label: 'C', text: '115' },
      { label: 'D', text: '25' },
    ],
    correctAnswer: 'A',
    studentAnswer: 'B',
  })
  console.log(`  (${seconds(start)})`)
  console.log(`  ${explanation.body_md.replace(/\n/g, '\n  ').slice(0, 700)}`)
  console.log(`\n  misconception: ${explanation.misconception_note ?? '(none)'}`)

  console.log('\n=== Verdict ===')
  console.log(`Extraction recall : ${questions.length}/${EXPECTED}`)
  console.log(`Classification    : ${correct}/${expectations.length}`)
  console.log(`Extraction time   : ${extractTime} for one page`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

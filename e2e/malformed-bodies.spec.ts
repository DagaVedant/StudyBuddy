import { expect, test, type APIResponse, type Page } from '@playwright/test'

import { registerAndSignIn } from './support/helpers'
import { resetDatabase } from './support/reset'

test.describe.configure({ mode: 'serial' })

test.beforeAll(resetDatabase)

let page: Page
let worksheetId: string
let questionId: string

const NOT_JSON = {
  data: '{"title": "truncated',
  headers: { 'content-type': 'application/json' },
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await registerAndSignIn(page)

  const created = await page.request.post('/api/worksheets', {
    data: {
      title: 'Malformed body fixture',
      sourceType: 'pdf_digital',
      pageCount: 1,
    },
  })
  expect(created.status()).toBe(201)
  worksheetId = (await created.json()).worksheetId

  const question = await page.request.post(`/api/worksheets/${worksheetId}/questions`, {
    data: {
      ordinal: 1,
      promptText: 'What is 2 + 2?',
      questionType: 'free_response',
    },
  })
  expect(question.status()).toBe(201)
  questionId = (await question.json()).questionId
})

test.afterAll(async () => {
  await page.close()
})

async function expectBadRequest(response: APIResponse) {
  expect(response.status()).toBe(400)
  await expect(response.json()).resolves.toHaveProperty('error')
}

test('creating a worksheet with a body that is not JSON', async () => {
  await expectBadRequest(await page.request.post('/api/worksheets', NOT_JSON))
})

test('creating a question with a body that is not JSON', async () => {
  await expectBadRequest(
    await page.request.post(`/api/worksheets/${worksheetId}/questions`, NOT_JSON),
  )
})

test('marking attempts with a body that is not JSON', async () => {
  await expectBadRequest(
    await page.request.post(`/api/worksheets/${worksheetId}/attempts`, NOT_JSON),
  )
})

test('storing OCR text with a body that is not JSON', async () => {
  await expectBadRequest(
    await page.request.patch(`/api/worksheets/${worksheetId}/pages`, NOT_JSON),
  )
})

test('rating a review card with a body that is not JSON', async () => {
  await expectBadRequest(await page.request.post('/api/review/rate', NOT_JSON))
})

test('patching a question with a body that is not JSON is rejected, not silently ignored', async () => {
  const response = await page.request.patch(`/api/questions/${questionId}`, NOT_JSON)

  await expectBadRequest(response)

  const listed = await page.request.get(`/api/worksheets/${worksheetId}/questions`)
  const { questions } = await listed.json()
  expect(questions[0].promptText).toBe('What is 2 + 2?')
})

test('uploading a page with a body that is not multipart', async () => {
  await expectBadRequest(
    await page.request.post(`/api/worksheets/${worksheetId}/pages`, {
      data: 'not multipart at all',
      headers: { 'content-type': 'multipart/form-data; boundary=nonsense' },
    }),
  )
})

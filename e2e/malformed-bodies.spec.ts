import { expect, test, type APIResponse, type Page } from '@playwright/test'

import { registerAndSignIn } from './support/helpers'

/**
 * The six handlers that called `request.json()` bare, plus the multipart
 * upload, sent a body they cannot read.
 *
 * `request.json()` and `request.formData()` reject on a malformed body, and
 * these called them inside `safeParse(...)` with nothing to catch the
 * rejection, so it escaped and Next answered 500. A 500 says the server is
 * broken; a truncated upload, a proxy that mangled the body or a client that
 * got its Content-Type wrong is the caller's problem and has to read as 400,
 * or the client retries a request that can never succeed.
 *
 * The handlers are unit-tested in tests/unit/route-malformed-body.test.ts,
 * which is where the branch itself is pinned. What that cannot show is the
 * status that leaves the server: a handler resolving with a 400 Response and
 * Next serving 400 for the same request are different claims, and it was the
 * second one that was wrong. So these cases are here as well, deliberately.
 *
 * The other routes that read a body are not covered here. Each already caught
 * to `{}` against a schema with a required field or a discriminated union, so
 * `{}` fails safeParse and they answer 400 already.
 */
test.describe.configure({ mode: 'serial' })

let page: Page
let worksheetId: string
let questionId: string

/** A body with the JSON content type that is not JSON. */
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

  // The routes keyed by a question check ownership before they read the body,
  // so a made-up id would 404 and prove nothing about the parse.
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

/** 400 and not 500, and not a hang: the response has to arrive at all. */
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

/**
 * The one that would still be broken if the body had been caught to `{}`.
 *
 * This route parses through `questionInputSchema.partial()`, where every field
 * is optional, so `{}` is a valid patch. Catching to `{}` would have answered
 * 200 for a body nobody could read, having written nothing, and the client
 * would believe the edit had saved. Caught to `null`, which no object schema
 * accepts.
 */
test('patching a question with a body that is not JSON is rejected, not silently ignored', async () => {
  const response = await page.request.patch(`/api/questions/${questionId}`, NOT_JSON)

  await expectBadRequest(response)

  // And the question is untouched, which is the failure the status code stands
  // in for: an empty patch would have answered ok and saved nothing.
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

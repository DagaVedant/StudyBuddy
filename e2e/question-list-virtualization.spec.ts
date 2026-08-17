import { expect, test } from '@playwright/test'

import { registerAndSignIn, visible } from './support/helpers'
import { resetDatabase } from './support/reset'

test.beforeAll(resetDatabase)

const QUESTION_COUNT = 60
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('a long question list virtualizes without losing an in-progress edit off-screen', async ({
  page,
}) => {
  await registerAndSignIn(page)

  const created = await page.request.post('/api/worksheets', {
    data: { title: 'Virtualization Fixture', sourceType: 'pdf_digital', pageCount: 1 },
  })
  const { worksheetId } = (await created.json()) as { worksheetId: string }

  await page.request.post(`/api/worksheets/${worksheetId}/pages`, {
    multipart: {
      image: { name: 'p1.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG },
      pageNumber: '1',
    },
  })

  for (let i = 1; i <= QUESTION_COUNT; i += 1) {
    await page.request.post(`/api/worksheets/${worksheetId}/questions`, {
      data: { ordinal: i, promptText: `Question ${i}`, questionType: 'free_response' },
    })
  }

  await page.goto(`/worksheets/${worksheetId}/edit`)
  await expect(
    visible(page).getByRole('heading', { name: `${QUESTION_COUNT} questions found` }),
  ).toBeVisible()

  // The virtualizer measures its container before it knows which rows to render, so
  // the first paint carries no cards at all. count() takes one snapshot and does not
  // retry, so wait for a card to exist before counting them.
  const cards = visible(page).getByRole('button', { name: 'Fix' })
  await expect(cards.first()).toBeVisible()

  const renderedCards = await cards.count()
  expect(renderedCards).toBeGreaterThan(0)
  expect(renderedCards).toBeLessThan(QUESTION_COUNT / 2)

  await visible(page).getByRole('button', { name: 'Fix' }).first().click()

  const editedText = 'Question 1, now being edited mid-scroll'
  const promptBox = visible(page).getByLabel('Question text')
  await expect(promptBox).toBeVisible()
  await promptBox.fill(editedText)
  await expect(promptBox).toBeFocused()

  await page.mouse.wheel(0, 20_000)
  await page.waitForTimeout(200)

  await expect(promptBox).toBeVisible()
  await expect(promptBox).toBeFocused()
  await expect(promptBox).toHaveValue(editedText)

  await page.waitForResponse(
    (response) =>
      /\/api\/questions\/[^/]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'PATCH' &&
      response.ok(),
  )
})

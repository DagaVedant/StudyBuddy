import { expect, test } from '@playwright/test'

import { registerAndSignIn, visible } from './support/helpers'

/**
 * Finding 48. question-list.tsx rendered every card, unwindowed, and the
 * documented reason it stayed that way (fixes/AUDIT-ENGINEERING.md P-11)
 * was that virtualizing editable, variable-height, focus-bearing rows trades
 * a one-off first-paint cost for a permanent class of bug: a row scrolled
 * out of view unmounting mid-edit. The fix keeps that risk closed by pinning
 * whichever row is expanded into the virtualizer's rendered range
 * (question-list.tsx's `rangeExtractor`) regardless of where scrolling has
 * carried it, so this is the test for exactly that: expand a row, scroll it
 * far out of the viewport, and prove it is still mounted with the typed
 * text intact rather than reset or gone.
 */

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

  // The list is windowed: nowhere near sixty "Fix" buttons are actually in
  // the DOM for a viewport this size, which is the whole point of finding 48.
  const renderedCards = await visible(page).getByRole('button', { name: 'Fix' }).count()
  expect(renderedCards).toBeGreaterThan(0)
  expect(renderedCards).toBeLessThan(QUESTION_COUNT / 2)

  // Expand the first rendered card (Question 1, since nothing has scrolled
  // yet) and start editing it.
  await visible(page).getByRole('button', { name: 'Fix' }).first().click()

  const editedText = 'Question 1, now being edited mid-scroll'
  const promptBox = visible(page).getByLabel('Question text')
  await expect(promptBox).toBeVisible()
  await promptBox.fill(editedText)
  await expect(promptBox).toBeFocused()

  // Scroll the window far past where this row would naturally fall out of
  // the virtualizer's window.
  await page.mouse.wheel(0, 20_000)
  await page.waitForTimeout(200)

  // Still mounted, still focused, still carrying the edit - the row this
  // whole design exists to protect.
  await expect(promptBox).toBeVisible()
  await expect(promptBox).toBeFocused()
  await expect(promptBox).toHaveValue(editedText)

  // And the edit actually reaches the server, same as any other field.
  await page.waitForResponse(
    (response) =>
      /\/api\/questions\/[^/]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'PATCH' &&
      response.ok(),
  )
})

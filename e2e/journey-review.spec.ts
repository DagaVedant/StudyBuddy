import { expect, test, type Page } from '@playwright/test'

import { registerAndSignIn, seedReviewableWorksheet, visible } from './support/helpers'

/**
 * Finding 83. Verify through the review queue, split out of journey.spec.ts.
 *
 * That file's whole suite ran `mode: 'serial'` behind one hand-drawn
 * question, so a regression anywhere in the drag gesture - a rendering bug
 * unrelated to any screen tested here - silenced every assertion after it,
 * including the ones in this file, with the run just reporting "did not
 * run" for all of them. §7.2's fix was named at the time (an API-based
 * question fixture) and never landed; seedReviewableWorksheet is that
 * fixture. Independent fixture, independent file: a regression here can
 * only ever point at these screens.
 */
test.describe.configure({ mode: 'serial' })

let page: Page
let worksheetId: string
let questionId: string

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  const email = await registerAndSignIn(page)
  ;({ worksheetId, questionId } = await seedReviewableWorksheet(page, email))
})

test.afterAll(async () => {
  await page.close()
})

test('the verify flow shows a card and records a check', async () => {
  // Manual creation marks a question verified - a student who boxed it
  // themselves has already checked it - which is the wrong starting state
  // for a screen whose whole job is checking questions nobody has yet.
  await page.request.patch(`/api/questions/${questionId}`, {
    data: { userVerified: false },
  })

  await page.goto(`/worksheets/${worksheetId}/verify`)

  await expect(visible(page).getByRole('heading', { name: 'Check Your Questions' })).toBeVisible()
  await expect(visible(page).getByRole('progressbar', { name: 'Questions checked' })).toBeVisible()
  // Scoped to the page rather than the document. With a `loading.tsx` in the
  // tree this route streams, and Next parks the streamed content in a hidden
  // div at the end of <body> until an inline script moves it into place. That
  // copy is inert and nobody sees it, but it does match on text.
  await expect(visible(page).getByText(/0 of \d+ checked/)).toBeVisible()

  await visible(page).getByRole('button', { name: 'Looks right' }).click()

  // One question in this fixture, so accepting it finishes the worksheet.
  await expect(visible(page).getByText(/All \d+ questions? checked/)).toBeVisible()

  await page.goto(`/worksheets/${worksheetId}/review`)
})

test('confirming moves the worksheet to markup', async () => {
  await visible(page).getByRole('button', { name: /Looks right, mark \d+ question/ }).click()

  await page.waitForURL(/\/worksheets\/[^/]+\/markup/, { timeout: 30_000 })
  await expect(visible(page).getByRole('heading', { name: 'How Did You Do?' })).toBeVisible()
})

/**
 * Marking is one atomic post at the end, so everything decided before that
 * lives only in the tab. A reload used to lose the lot, and on a 114-question
 * paper that is a whole sitting.
 */
test('a mark survives a reload of the markup screen', async () => {
  await visible(page).getByText('Missed it').first().click()
  await expect(visible(page).getByText('1 of 1 marked')).toBeVisible()

  await page.reload()

  await expect(visible(page).getByText('1 of 1 marked')).toBeVisible()
  await expect(
    visible(page).getByText('Picked up where you left off on this device.'),
  ).toBeVisible()

  // And thrown away on request, which is also what hands the next step a clean
  // paper to mark.
  await visible(page).getByRole('button', { name: 'Start again' }).click()
  await expect(visible(page).getByText('0 of 1 marked')).toBeVisible()
})

test('marking a miss prompts for the answer actually given', async () => {
  await visible(page).getByText('Missed it').first().click()

  await expect(visible(page).getByText('1 of 1 marked')).toBeVisible()

  await visible(page).getByRole('button', { name: 'Next: What You Put' }).click()
  await expect(visible(page).getByText(/What did you put/)).toBeVisible()

  // Exact, because the question stem quotes every option, so a loose match
  // finds the prompt before it finds the choice.
  await visible(page).getByText('105', { exact: true }).click()
  await visible(page).getByRole('button', { name: 'Save and finish' }).click()

  await page.waitForURL('**/dashboard', { timeout: 30_000 })
})

test('the dashboard reflects the attempt', async () => {
  await expect(visible(page).getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await expect(visible(page).getByText('Nothing tracked yet')).toHaveCount(0)
  await expect(visible(page).getByText('Questions tracked')).toBeVisible()
  await expect(visible(page).getByText('Recent worksheets')).toBeVisible()
  await expect(visible(page).getByText('Unit 4 Practice')).toBeVisible()
})

test('a missed question comes back for review', async () => {
  // Not literally immediate. A miss grades as Again, and FSRS puts the first
  // learning step a minute out, so the queue is empty for that minute and the
  // screen correctly says "Nothing Due". Polled rather than slept so it moves
  // on as soon as the card lands.
  test.setTimeout(180_000)

  // Polls for the card itself, not for the page heading. The heading is on
  // /review whether or not anything is due: the empty state moved into the
  // session component so that finishing a session keeps the count on screen,
  // which means the heading no longer says anything about the queue.
  await expect(async () => {
    await page.goto('/review')
    await expect(visible(page).getByText(/triangle/i).first()).toBeVisible({
      timeout: 3_000,
    })
  }).toPass({ timeout: 150_000 })

  await expect(visible(page).getByRole('heading', { name: 'Answer' })).toHaveCount(0)
  await visible(page).getByRole('button', { name: 'Show answer' }).click()

  await expect(visible(page).getByRole('heading', { name: 'Answer' })).toBeVisible()
  await expect(visible(page).getByRole('heading', { name: 'You put' })).toBeVisible()
})

test('rating a card completes the session', async () => {
  await visible(page).getByRole('button', { name: 'Good' }).click()

  // Scoped, like the two above: the review route streams, and the copy Next
  // parks in a hidden div at the end of <body> matches on text as well.
  await expect(
    visible(page).getByRole('heading', { name: 'Session complete' }),
  ).toBeVisible({ timeout: 30_000 })
})

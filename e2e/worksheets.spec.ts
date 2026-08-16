import { expect, test, type Page } from '@playwright/test'

import { createWorksheet, registerAndSignIn, visible } from './support/helpers'

/**
 * The worksheet screens a student navigates, rather than the flow through one.
 *
 * The library first, which was a list of the fifty newest worksheets and
 * nothing else: no paging, no search, no filter and no rename, so the
 * fifty-first was gone from the interface while its row still counted towards
 * the dashboard, and the only handle on any of them was a title set once at
 * upload from the filename.
 *
 * Then the route names, at the bottom, because they are about the same URLs the
 * cards above link to. Uploading, checking and marking one worksheet is
 * journey.spec.ts and journey-review.spec.ts; nothing here opens that flow.
 */

/**
 * A worksheet's card, found by its title link.
 *
 * By role rather than by text, because the delete confirmation renders the same
 * title into a closed `<dialog>` that is still in the DOM: a plain text match
 * finds both and fails strict mode. The link is also the element that carries
 * the renamed title first, since the rename reads from local state rather than
 * waiting on the refresh.
 */
const card = (page: Page, title: string) =>
  visible(page).getByRole('link', { name: title, exact: true })

test('a title search finds one worksheet and hides the others', async ({ page }) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'Trigonometry Unit 7')
  await createWorksheet(page, 'Quadratics Practice')

  await page.goto('/worksheets')
  await expect(card(page, 'Trigonometry Unit 7')).toBeVisible()
  await expect(card(page, 'Quadratics Practice')).toBeVisible()

  await visible(page).getByRole('searchbox').fill('quadratic')
  await visible(page).getByRole('button', { name: 'Search' }).click()

  await expect(card(page, 'Quadratics Practice')).toBeVisible()
  await expect(card(page, 'Trigonometry Unit 7')).toHaveCount(0)

  // A search that matches nothing says so, and offers the way back rather than
  // claiming nothing was ever uploaded.
  await visible(page).getByRole('searchbox').fill('nothing called this')
  await visible(page).getByRole('button', { name: 'Search' }).click()
  await expect(visible(page).getByText(/Nothing matches/)).toBeVisible()

  await visible(page).getByRole('link', { name: 'Show all worksheets' }).click()
  await expect(card(page, 'Trigonometry Unit 7')).toBeVisible()
})

/**
 * The cursor, driven directly rather than by uploading fifty-one worksheets.
 * `?before=` is a position in the `createdAt` ordering, so a timestamp between
 * the two rows shows exactly the older one.
 */
test('the cursor shows what is older than it', async ({ page }) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'Older Paper')
  // Distinct timestamps, since the cursor is strictly less-than.
  await page.waitForTimeout(1_100)
  await createWorksheet(page, 'Newer Paper')

  await page.goto('/worksheets')
  await expect(card(page, 'Newer Paper')).toBeVisible()

  const between = new Date(Date.now() - 500).toISOString()
  await page.goto(`/worksheets?before=${encodeURIComponent(between)}`)

  await expect(card(page, 'Older Paper')).toBeVisible()
  await expect(card(page, 'Newer Paper')).toHaveCount(0)
  await expect(
    visible(page).getByRole('link', { name: 'Back to the newest' }),
  ).toBeVisible()
})

test('a cursor past the end says so instead of claiming nothing was uploaded', async ({
  page,
}) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'Only Paper')

  await page.goto('/worksheets?before=2000-01-01T00:00:00.000Z')

  await expect(visible(page).getByText('Nothing older to show')).toBeVisible()
  await expect(visible(page).getByText('Nothing uploaded yet')).toHaveCount(0)
})

/**
 * An unparseable cursor is a hand-edited URL or a link that has gone stale, and
 * the newest page is a better answer to both than an error.
 */
test('a nonsense cursor falls back to the newest', async ({ page }) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'Only Paper')

  await page.goto('/worksheets?before=not-a-date')

  await expect(card(page, 'Only Paper')).toBeVisible()
})

test('a worksheet can be renamed off the filename it arrived with', async ({ page }) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'scan_002')

  await page.goto('/worksheets')
  await visible(page).getByRole('button', { name: 'Rename scan_002' }).click()

  const field = visible(page).getByLabel('Worksheet title')
  await field.fill('Chapter 5 Review')
  await visible(page).getByRole('button', { name: 'Save' }).click()

  await expect(card(page, 'Chapter 5 Review')).toBeVisible()
  await expect(card(page, 'scan_002')).toHaveCount(0)

  // Written, not just shown. The rename reads from local state so it does not
  // wait on the refresh, which is exactly why this reloads to check.
  await page.reload()
  await expect(card(page, 'Chapter 5 Review')).toBeVisible()
})

test('cancelling a rename leaves the title alone', async ({ page }) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'Keep This Name')

  await page.goto('/worksheets')
  await visible(page).getByRole('button', { name: 'Rename Keep This Name' }).click()

  await visible(page).getByLabel('Worksheet title').fill('Discarded')
  await visible(page).getByRole('button', { name: 'Cancel' }).click()

  await expect(card(page, 'Keep This Name')).toBeVisible()
  await expect(card(page, 'Discarded')).toHaveCount(0)
})

/**
 * §2.4. Three screens shared two words: `/worksheets/[id]/review` and
 * `/worksheets/[id]/verify` were both about the extraction, while `/review` is
 * the practice queue the nav teaches. So the nav said Review, the worksheet card
 * said "Check questions", and an upload landed on a URL ending /review that was
 * not the Review in the nav.
 *
 * The old paths still have to work. A bookmark, a back button or a tab left open
 * since before the deploy names one of them, and the alternative to a redirect
 * is a 404 on the student's own worksheet.
 */
test('the old extraction URLs still reach their screens', async ({ page }) => {
  await registerAndSignIn(page)
  const id = await createWorksheet(page, 'Renamed Routes')

  await page.goto(`/worksheets/${id}/review`)
  await expect(page).toHaveURL(new RegExp(`/worksheets/${id}/edit`))

  await page.goto(`/worksheets/${id}/verify`)
  await expect(page).toHaveURL(new RegExp(`/worksheets/${id}/check`))
})

test('the practice queue keeps the word review to itself', async ({ page }) => {
  await registerAndSignIn(page)

  // The redirect is scoped under /worksheets/, so the top-level route this
  // rename exists to protect is untouched.
  await page.goto('/review')
  await expect(page).toHaveURL(/\/review$/)
  await expect(visible(page).getByRole('heading', { name: 'Review' })).toBeVisible()
})

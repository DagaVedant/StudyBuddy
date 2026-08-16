import { expect, test, type Page } from '@playwright/test'

import { registerAndSignIn, visible } from './support/helpers'

/**
 * The library screen, which was a list of the fifty newest worksheets and
 * nothing else. No paging, no search, no filter and no rename: the fifty-first
 * worksheet was gone from the interface, its row still counting towards the
 * dashboard, and the only handle on any of them was a title set once at upload
 * from the filename.
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

async function createWorksheet(page: Page, title: string): Promise<string> {
  const response = await page.request.post('/api/worksheets', {
    data: { title, sourceType: 'pdf_digital', pageCount: 1 },
  })

  if (!response.ok()) {
    throw new Error(`Could not create ${title}: ${await response.text()}`)
  }

  const { worksheetId } = (await response.json()) as { worksheetId: string }
  return worksheetId
}

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

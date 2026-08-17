import { expect, test, type Page } from '@playwright/test'

import { createWorksheet, registerAndSignIn, visible } from './support/helpers'

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

  await visible(page).getByRole('searchbox').fill('nothing called this')
  await visible(page).getByRole('button', { name: 'Search' }).click()
  await expect(visible(page).getByText(/Nothing matches/)).toBeVisible()

  await visible(page).getByRole('link', { name: 'Show all worksheets' }).click()
  await expect(card(page, 'Trigonometry Unit 7')).toBeVisible()
})

test('the cursor shows what is older than it', async ({ page }) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'Older Paper')
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

  await page.goto('/review')
  await expect(page).toHaveURL(/\/review$/)
  await expect(visible(page).getByRole('heading', { name: 'Review' })).toBeVisible()
})

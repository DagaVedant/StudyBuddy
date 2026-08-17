import { expect, test, type Page } from '@playwright/test'

import { registerAndSignIn, seedReviewableWorksheet, visible } from './support/helpers'

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
  await page.request.patch(`/api/questions/${questionId}`, {
    data: { userVerified: false },
  })

  await page.goto(`/worksheets/${worksheetId}/check`)

  await expect(visible(page).getByRole('heading', { name: 'Check Your Questions' })).toBeVisible()
  await expect(visible(page).getByRole('progressbar', { name: 'Questions checked' })).toBeVisible()
  await expect(visible(page).getByText(/0 of \d+ checked/)).toBeVisible()

  await visible(page).getByRole('button', { name: 'Looks right' }).click()

  await expect(visible(page).getByText(/All \d+ questions? checked/)).toBeVisible()

  await page.goto(`/worksheets/${worksheetId}/edit`)
})

test('confirming moves the worksheet to markup', async () => {
  await visible(page).getByRole('button', { name: /Looks right, mark \d+ question/ }).click()

  await page.waitForURL(/\/worksheets\/[^/]+\/markup/, { timeout: 30_000 })
  await expect(visible(page).getByRole('heading', { name: 'How Did You Do?' })).toBeVisible()
})

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

  await expect(
    visible(page).getByRole('heading', { name: 'Due for review' }),
  ).toBeVisible()
  await expect(visible(page).getByText('Nothing due in the next seven days')).toBeVisible()

  await expect(visible(page).getByText('0%')).toBeVisible()
})

test('a missed question comes back for review', async () => {
  test.setTimeout(180_000)

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

  await expect(
    visible(page).getByRole('heading', { name: 'Session complete' }),
  ).toBeVisible({ timeout: 30_000 })
})

test('an unknown topic falls back to the whole queue rather than an empty screen', async () => {
  await page.goto('/review?topic=not-a-real-topic')

  await expect(visible(page).getByRole('heading', { name: 'Review', exact: true })).toBeVisible()
  await expect(visible(page).getByText('Only questions filed under this topic')).toHaveCount(0)
})

test('a mis-tapped mark can be corrected on the worksheet it happened on', async () => {
  await page.goto(`/worksheets/${worksheetId}/markup`)

  await expect(
    visible(page).getByRole('heading', { name: 'What You Recorded' }),
  ).toBeVisible()

  const missed = visible(page).getByRole('button', { name: 'Missed it' })
  await expect(missed).toHaveAttribute('aria-pressed', 'true')

  await visible(page).getByRole('button', { name: 'Got it' }).click()

  await expect(visible(page).getByText('Saved.')).toBeVisible()
  await expect(
    visible(page).getByRole('button', { name: 'Got it' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(missed).toHaveAttribute('aria-pressed', 'false')

  await page.reload()
  await expect(
    visible(page).getByRole('button', { name: 'Got it' }),
  ).toHaveAttribute('aria-pressed', 'true')
})

test('a marked worksheet offers its marks from the library', async () => {
  await page.goto('/worksheets')

  await expect(
    visible(page).getByRole('link', { name: 'See your marks' }).first(),
  ).toBeVisible()
})

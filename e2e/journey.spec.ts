import { expect, test, type Page } from '@playwright/test'

import {
  closeDbClient,
  registerAndSignIn,
  setTrialPagesUsed,
  uploadWorksheet,
} from './support/helpers'

/**
 * The whole Tier A loop, in order: upload -> extract -> review -> markup ->
 * dashboard -> spaced repetition.
 *
 * This is the coverage unit tests cannot reach — pdf.js rasterizing in a real
 * browser, the text layer coming back with usable geometry, and the
 * drag-to-draw coordinate math that was previously unverified.
 */
test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()

  const email = await registerAndSignIn(page)

  // Burn the trial so the account is Tier A and lands in the manual editor
  // rather than queueing for a GPU worker that isn't running in tests.
  await setTrialPagesUsed(email, 10)
})

test.afterAll(async () => {
  await page.close()
  await closeDbClient()
})

test('a PDF is rasterized in the browser and its text layer extracted', async () => {
  await uploadWorksheet(page)

  await expect(page).toHaveURL(/\/worksheets\/[^/]+\/review/)
  await expect(page.getByRole('heading', { name: 'Review Questions' })).toBeVisible()

  // The page image came back through the ownership-checked file route.
  const image = page.getByRole('img', { name: /Page 1 of/ })
  await expect(image).toBeVisible()

  const natural = await image.evaluate(
    (element) => (element as HTMLImageElement).naturalWidth,
  )
  expect(natural).toBeGreaterThan(500)
})

test('dragging a region creates a question with its text filled in', async () => {
  const image = page.getByRole('img', { name: /Page 1 of/ })
  const box = await image.boundingBox()
  if (!box) throw new Error('page image has no layout box')

  // Sweep the upper part of the page, where the first question sits.
  await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.05)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.22, {
    steps: 12,
  })
  await page.mouse.up()

  const prompt = page.getByLabel('Question text')
  await expect(prompt).toBeVisible()

  // Auto-fill is the whole point of storing line geometry: the student edits
  // what came out rather than retyping it.
  await expect(prompt).toHaveValue(/triangle/i)
})

test('a topic can be assigned from the canonical tree', async () => {
  await page.getByRole('combobox', { name: 'Topic' }).fill('triangle angle')

  const option = page.getByRole('option').first()
  await expect(option).toBeVisible()
  await option.click()

  await expect(page.getByText(/Triangle angle sum/)).toBeVisible()
})

test('answer choices can be added and one marked correct', async () => {
  for (const label of ['A', 'B']) {
    await page.getByRole('button', { name: 'Add Choice' }).click()
    await page.getByLabel(`Text for choice ${label}`).fill(label === 'A' ? '75' : '105')
  }

  await page.getByRole('radio', { name: 'Mark choice A correct' }).check()
  await expect(page.getByRole('radio', { name: 'Mark choice A correct' })).toBeChecked()

  await expect(page.getByText('Saved')).toBeVisible()
})

test('confirming moves the worksheet to markup', async () => {
  await page.getByRole('button', { name: /Confirm 1 Question/ }).click()

  await page.waitForURL(/\/worksheets\/[^/]+\/markup/, { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'How Did You Do?' })).toBeVisible()
})

test('marking a miss prompts for the answer actually given', async () => {
  await page.getByText('Missed It').first().click()

  await expect(page.getByText('1 of 1 marked')).toBeVisible()

  await page.getByRole('button', { name: 'Next: What You Put' }).click()
  await expect(page.getByText(/What did you put/)).toBeVisible()

  // Capturing the chosen distractor is what lets explanations target the
  // actual mistake instead of re-solving the problem.
  await page.getByText('105').click()
  await page.getByRole('button', { name: 'Save and Finish' }).click()

  await page.waitForURL('**/dashboard', { timeout: 30_000 })
})

test('the dashboard reflects the attempt', async () => {
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await expect(page.getByText('Nothing tracked yet')).toHaveCount(0)
  await expect(page.getByText('Questions tracked')).toBeVisible()
  await expect(page.getByText('Recent worksheets')).toBeVisible()
  await expect(page.getByText('Unit 4 Practice')).toBeVisible()
})

test('a missed question is due for review immediately', async () => {
  await page.goto('/review')

  await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible()
  await expect(page.getByText(/triangle/i).first()).toBeVisible()

  // Answer stays hidden until asked for.
  await expect(page.getByRole('heading', { name: 'Answer' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show Answer' }).click()

  await expect(page.getByRole('heading', { name: 'Answer' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'You put' })).toBeVisible()
})

test('rating a card completes the session', async () => {
  await page.getByRole('button', { name: 'Good' }).click()

  await expect(page.getByText('Session complete')).toBeVisible({ timeout: 30_000 })
})

import { expect, test, type Page } from '@playwright/test'

import { TRIAL_WORKSHEET_LIMIT } from '../lib/ai/limits'

import {
  closeDbClient,
  registerAndSignIn,
  setTrialWorksheetsUsed,
  uploadWorksheet,
} from './support/helpers'

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()

  const email = await registerAndSignIn(page)

  await setTrialWorksheetsUsed(page, email, TRIAL_WORKSHEET_LIMIT)
})

test.afterAll(async () => {
  await page.close()
  await closeDbClient()
})

test('a PDF is rasterized in the browser and its text layer extracted', async () => {
  await uploadWorksheet(page)

  await expect(page).toHaveURL(/\/worksheets\/[^/]+\/review/)
  await expect(page.getByRole('heading', { name: 'Add Your Questions' })).toBeVisible()

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

  await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.05)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.22, {
    steps: 12,
  })
  await page.mouse.up()

  const prompt = page.getByLabel('Question text')
  await expect(prompt).toBeVisible()

  await expect(prompt).toHaveValue(/triangle/i)
})

test('a topic can be assigned from the canonical tree', async () => {
  await page.getByRole('combobox', { name: 'Topic' }).fill('triangle angle')

  // Scoped to the picker's own listbox: an unscoped option lookup matches the
  // question-type <select> first, whose native options a browser reports as
  // hidden, so the test failed on an element it was never looking for.
  const option = page
    .getByRole('listbox', { name: 'Topics' })
    .getByRole('option')
    .first()

  await expect(option).toBeVisible()
  await option.click()

  // The chosen topic is shown twice once assigned — beside the question in the
  // list, and as the full path in the editor — so this says which one it means
  // rather than failing for matching both.
  await expect(page.getByText(/Triangle angle sum/).first()).toBeVisible()
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
  await page.getByRole('button', { name: /Looks Right, Mark \d+ Question/ }).click()

  await page.waitForURL(/\/worksheets\/[^/]+\/markup/, { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'How Did You Do?' })).toBeVisible()
})

test('marking a miss prompts for the answer actually given', async () => {
  await page.getByText('Missed It').first().click()

  await expect(page.getByText('1 of 1 marked')).toBeVisible()

  await page.getByRole('button', { name: 'Next: What You Put' }).click()
  await expect(page.getByText(/What did you put/)).toBeVisible()

  // Exact, because the question stem quotes every option, so a loose match
  // finds the prompt before it finds the choice.
  await page.getByText('105', { exact: true }).click()
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

  await expect(page.getByRole('heading', { name: 'Answer' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show Answer' }).click()

  await expect(page.getByRole('heading', { name: 'Answer' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'You put' })).toBeVisible()
})

test('rating a card completes the session', async () => {
  await page.getByRole('button', { name: 'Good' }).click()

  await expect(page.getByText('Session complete')).toBeVisible({ timeout: 30_000 })
})

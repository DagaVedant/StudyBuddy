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

// KNOWN FAILURE. Everything below was measured, not guessed, and the pieces
// still contradict each other:
//
//  - Logging the handlers: pointermove and pointerup both reach the container,
//    pointerdown never does, so dragStart stays null and the box is null on
//    release. The log sits above the event.button guard, so the handler body
//    is genuinely not entered.
//  - The component holds exactly one onPointerDown and calls neither
//    stopPropagation nor preventDefault. Nothing in it intercepts the press.
//  - Every ancestor of the image reports pointer-events: auto and visible.
//  - locator.hover() times out after two minutes on "attempting hover action"
//    having resolved the image, so Playwright's actionability check never
//    passes either.
//  - boundingBox() says the image spans x 24-784, y 16-999 in a 1280x720
//    viewport, yet document.elementsFromPoint at a point well inside that
//    returns only <html>.
//
// The last two are the contradiction worth chasing: the element is where the
// box says it is, and the browser does not agree that anything is there. The
// container is lg:sticky lg:top-4, but that is ruled out: forcing it to
// position: static leaves the hit test still returning <html>. Moving the
// press inboard from the corner changes nothing either. Whatever it is, the
// two APIs disagree about where this element is, independent of positioning.
test('dragging a region creates a question with its text filled in', async () => {
  const image = page.getByRole('img', { name: /Page 1 of/ })

  await expect(image).toBeVisible()
  await image.evaluate((element: HTMLImageElement) =>
    element.complete ? undefined : element.decode().catch(() => undefined),
  )

  await image.scrollIntoViewIfNeeded()

  const box = await image.boundingBox()
  if (!box) throw new Error('page image has no layout box')

  const viewport = page.viewportSize()
  console.log('BOX', JSON.stringify(box), 'VIEWPORT', JSON.stringify(viewport))

  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.08)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.12, { steps: 8 })
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.22, { steps: 8 })
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

  // The chosen topic is shown twice once assigned: beside the question in the
  // list, and as the full path in the editor, so this says which one it means
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

test('the verify flow shows a card and records a check', async () => {
  const url = page.url()
  const worksheetId = url.match(/worksheets\/([^/]+)\//)?.[1]
  if (!worksheetId) throw new Error('no worksheet id in ' + url)

  await page.goto(`/worksheets/${worksheetId}/verify`)

  await expect(page.getByRole('heading', { name: 'Check Your Questions' })).toBeVisible()
  await expect(page.getByRole('progressbar', { name: 'Questions checked' })).toBeVisible()
  await expect(page.getByText(/0 of \d+ checked/)).toBeVisible()

  await page.getByRole('button', { name: 'Looks right' }).click()

  // One question in this fixture, so accepting it finishes the worksheet.
  await expect(page.getByText(/All \d+ questions checked/)).toBeVisible()

  await page.goto(`/worksheets/${worksheetId}/review`)
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

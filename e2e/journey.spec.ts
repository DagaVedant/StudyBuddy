import { expect, test, type Page } from '@playwright/test'

import { TRIAL_WORKSHEET_LIMIT } from '../lib/ai/limits'

import {
  visible,
  registerAndSignIn,
  setTrialWorksheetsUsed,
  uploadWorksheet,
} from './support/helpers'

/**
 * Finding 83. Upload through the review editor's own screen, and nothing
 * past it. Verify onward used to live here too, all one `mode: 'serial'`
 * block behind the drag test below: a regression in the drag gesture -
 * unrelated to verify, markup, the dashboard, or spaced repetition - used to
 * silence every one of those screens' tests at once, reporting them as
 * skipped rather than failed. That half now lives in
 * journey-review.spec.ts, on its own fixture (seedReviewableWorksheet in
 * support/helpers.ts) instead of the one question this file draws by hand.
 *
 * What stays serial here still earns it: each test operates on the same
 * open editor the one before it left mid-edit, which is what a real review
 * session is - one continuous pass over one question, not independent
 * screens.
 */
test.describe.configure({ mode: 'serial' })

let page: Page

/**
 * Resolves when the markup editor's debounced autosave actually lands.
 *
 * The "Saved" caption cannot stand in for this. It turns to "Saved" when a
 * question is created and never goes back to idle, so waiting on it passes
 * against a stale caption and the test then navigates away inside the 600ms
 * debounce, taking the edit with it. That is what left the choices unsaved and
 * this file's markup step looking at a free-text box.
 */
function editorSaved() {
  return page.waitForResponse(
    (response) =>
      /\/api\/questions\/[^/]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'PATCH' &&
      response.ok(),
  )
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()

  const email = await registerAndSignIn(page)

  await setTrialWorksheetsUsed(page, email, TRIAL_WORKSHEET_LIMIT)
})

test.afterAll(async () => {
  await page.close()
})

test('a PDF is rasterized in the browser and its text layer extracted', async () => {
  await uploadWorksheet(page)

  await expect(page).toHaveURL(/\/worksheets\/[^/]+\/edit/)
  await expect(visible(page).getByRole('heading', { name: 'Add Your Questions' })).toBeVisible()

  const image = visible(page).getByRole('img', { name: /Page 1 of/ })
  await expect(image).toBeVisible()

  const natural = await image.evaluate(
    (element) => (element as HTMLImageElement).naturalWidth,
  )
  expect(natural).toBeGreaterThan(500)
})

/**
 * One assertion, and it would have caught the bug above in seconds.
 *
 * The symptom was drag-to-add-a-question silently not working, which took four
 * commits and a full e2e run to chase each time. The cause was a stuck
 * ::view-transition tree in the top layer swallowing every press, and that is
 * visible directly: if hit testing at an arbitrary point reports <html>, or
 * anything is still animating after the page has settled, the screen is inert
 * whatever else the suite says.
 *
 * Placed here because reaching this route by clicking through the app is what
 * triggers it. A reload clears it, so a test that navigates directly cannot see
 * it at all.
 */
test('hit testing survives a client navigation', async () => {
  const inert = await page.evaluate(() => ({
    atTopbar: document.elementFromPoint(100, 28)?.tagName ?? 'null',
    depth: document.elementsFromPoint(100, 28).length,
    stuck: document
      .getAnimations()
      .filter((animation) => animation.playState === 'running')
      .map((animation) => {
        const effect = animation.effect as KeyframeEffect | null
        return effect?.pseudoElement ?? 'element'
      }),
  }))

  expect(inert.atTopbar).not.toBe('HTML')
  expect(inert.depth).toBeGreaterThan(1)
  expect(inert.stuck).toEqual([])
})

/**
 * The real gesture, with page.mouse, which is the point.
 *
 * This used to dispatch PointerEvents by hand because the browser's own hit
 * testing was dead on this screen after a client-side navigation: a press
 * anywhere landed on <html>. That was a stuck ::view-transition tree sitting in
 * the top layer, not a harness problem and not the sticky canvas card. It is
 * fixed in globals.css, and driving the drag through real input is what proves
 * it: a dispatched event would pass either way.
 */
test('dragging a region creates a question with its text filled in', async () => {
  const image = visible(page).getByRole('img', { name: /Page 1 of/ })

  await expect(image).toBeVisible()
  await image.evaluate((element: HTMLImageElement) =>
    element.complete ? undefined : element.decode().catch(() => undefined),
  )

  // Top fifth of the fixture page, which is where question 1 is printed.
  const box = (await image.boundingBox())!
  const at = (fx: number, fy: number) =>
    [box.x + box.width * fx, box.y + box.height * fy] as const

  await page.mouse.move(...at(0.04, 0.03))
  await page.mouse.down()
  await page.mouse.move(...at(0.5, 0.08))
  await page.mouse.move(...at(0.96, 0.17))
  await page.mouse.up()

  const prompt = visible(page).getByLabel('Question text')
  await expect(prompt).toBeVisible()

  await expect(prompt).toHaveValue(/triangle/i)
})

test('a topic can be assigned from the canonical tree', async () => {
  await visible(page).getByRole('combobox', { name: 'Topic' }).fill('triangle angle')

  // Scoped to the picker's own listbox: an unscoped option lookup matches the
  // question-type <select> first, whose native options a browser reports as
  // hidden, so the test failed on an element it was never looking for.
  const option = page
    .getByRole('listbox', { name: 'Topics' })
    .getByRole('option')
    .first()

  await expect(option).toBeVisible()

  const saved = editorSaved()
  await option.click()
  await saved

  // The chosen topic is shown twice once assigned: beside the question in the
  // list, and as the full path in the editor, so this says which one it means
  // rather than failing for matching both.
  await expect(visible(page).getByText(/Triangle angle sum/).first()).toBeVisible()
})

test('answer choices can be added and one marked correct', async () => {
  for (const label of ['A', 'B']) {
    let saved = editorSaved()
    await visible(page).getByRole('button', { name: 'Add choice' }).click()
    await saved

    saved = editorSaved()
    await visible(page).getByLabel(`Text for choice ${label}`).fill(label === 'A' ? '75' : '105')
    await saved
  }

  const marked = editorSaved()
  await visible(page).getByRole('radio', { name: 'Mark choice A correct' }).check()
  await marked

  await expect(visible(page).getByRole('radio', { name: 'Mark choice A correct' })).toBeChecked()
})


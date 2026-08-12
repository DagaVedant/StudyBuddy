import { expect, test, type Page } from '@playwright/test'

import { TRIAL_WORKSHEET_LIMIT } from '../lib/ai/limits'

import {
  visible,
  registerAndSignIn,
  setTrialWorksheetsUsed,
  uploadWorksheet,
} from './support/helpers'

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

  await expect(page).toHaveURL(/\/worksheets\/[^/]+\/review/)
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

test('the verify flow shows a card and records a check', async () => {
  const url = page.url()
  const worksheetId = url.match(/worksheets\/([^/]+)\//)?.[1]
  if (!worksheetId) throw new Error('no worksheet id in ' + url)

  // The only question here was drawn by hand in the drag test, and the create
  // endpoint marks those verified: a student who boxed a question themselves
  // has already checked it. Nothing extracts questions in this harness, so
  // without putting one back to unchecked the verify screen goes straight to
  // its "all checked" state and there is no card for this flow to show.
  const listed = await page.request.get(`/api/worksheets/${worksheetId}/questions`)
  const { questions } = (await listed.json()) as { questions: { id: string }[] }
  if (questions.length === 0) throw new Error('no questions to un-check')

  await page.request.patch(`/api/questions/${questions[0].id}`, {
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
  await visible(page).getByRole('button', { name: /Looks Right, Mark \d+ Question/ }).click()

  await page.waitForURL(/\/worksheets\/[^/]+\/markup/, { timeout: 30_000 })
  await expect(visible(page).getByRole('heading', { name: 'How Did You Do?' })).toBeVisible()
})

/**
 * Marking is one atomic post at the end, so everything decided before that
 * lives only in the tab. A reload used to lose the lot, and on a 114-question
 * paper that is a whole sitting.
 */
test('a mark survives a reload of the markup screen', async () => {
  await visible(page).getByText('Missed It').first().click()
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
  await visible(page).getByText('Missed It').first().click()

  await expect(visible(page).getByText('1 of 1 marked')).toBeVisible()

  await visible(page).getByRole('button', { name: 'Next: What You Put' }).click()
  await expect(visible(page).getByText(/What did you put/)).toBeVisible()

  // Exact, because the question stem quotes every option, so a loose match
  // finds the prompt before it finds the choice.
  await visible(page).getByText('105', { exact: true }).click()
  await visible(page).getByRole('button', { name: 'Save and Finish' }).click()

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


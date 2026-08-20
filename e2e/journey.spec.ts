import { expect, test, type Page } from '@playwright/test'

import { TRIAL_WORKSHEET_LIMIT } from '../lib/ai/limits'

import {
  visible,
  registerAndSignIn,
  setTrialWorksheetsUsed,
  uploadWorksheet,
} from './support/helpers'
import { resetDatabase } from './support/reset'

test.describe.configure({ mode: 'serial' })

test.beforeAll(resetDatabase)

let page: Page

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
  await expect(visible(page).getByRole('heading', { name: 'Add your questions' })).toBeVisible()

  const image = visible(page).getByRole('img', { name: /Page 1 of/ })
  await expect(image).toBeVisible()

  const natural = await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)
  expect(natural).toBeGreaterThan(500)
})

test('hit testing survives a client navigation', async () => {
  // The claim is that nothing is left *stuck* over the page. A view transition
  // still playing is not stuck, and one snapshot of elementFromPoint can land
  // inside that window, so give the transition a moment to finish and settle.
  await expect(async () => {
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
  }).toPass({ timeout: 15_000 })
})

test('dragging a region creates a question with its text filled in', async () => {
  const image = visible(page).getByRole('img', { name: /Page 1 of/ })

  await expect(image).toBeVisible()
  await image.evaluate((element: HTMLImageElement) =>
    element.complete ? undefined : element.decode().catch(() => undefined),
  )

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
  await visible(page).getByRole('combobox', { name: 'Topic' }).fill('triangles')

  const option = page
    .getByRole('listbox', { name: 'Topics' })
    .getByRole('option')
    .first()

  await expect(option).toBeVisible()

  const saved = editorSaved()
  await option.click()
  await saved

  await expect(visible(page).getByText(/Triangles/).first()).toBeVisible()
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


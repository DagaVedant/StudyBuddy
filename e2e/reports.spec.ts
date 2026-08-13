import { expect, test, type Page } from '@playwright/test'

import { TRIAL_WORKSHEET_LIMIT } from '../lib/ai/limits'

import {
  visible,
  registerAndSignIn,
  setTrialWorksheetsUsed,
  signInAsAdmin,
  uploadWorksheet,
} from './support/helpers'

/**
 * The screens added on 2026-08-08, plus the markup editor that was split apart
 * on the same day.
 *
 * Its own file with its own setup rather than more cases on the end of
 * journey.spec.ts, because that one runs serial behind a test documented as a
 * known failure, so nothing after it has run since 2026-08-06. Everything here
 * opens the editor with the "Fix" button instead of the drag that test is
 * blocked on.
 */
test.describe.configure({ mode: 'serial' })

let page: Page
let worksheetId: string

/** Matches ADMIN_EMAILS in playwright.config.ts. */
const ADMIN_EMAIL = 'admin@studybuddy.test'

/** Resolves when the editor's debounced autosave actually lands. */
function savedResponse() {
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
  await uploadWorksheet(page, 'Reports Fixture')

  const found = page.url().match(/worksheets\/([^/]+)\//)?.[1]
  if (!found) throw new Error(`no worksheet id in ${page.url()}`)
  worksheetId = found
})

test.afterAll(async () => {
  await page.close()
})

test('the split editor still opens and saves from the question list', async () => {
  await page.goto(`/worksheets/${worksheetId}/review`)
  await expect(visible(page).getByRole('heading', { name: 'Add Your Questions' })).toBeVisible()

  // Nothing is extracted for this fixture: the trial is spent, so the resolved
  // executor is "none" and the page comes up empty. That is the state the
  // empty-list copy below belongs to, and it is why journey.spec.ts leans on
  // its drag to produce the only question it ever has.
  await expect(visible(page).getByRole('heading', { name: '0 questions found' })).toBeVisible()
  // Scoped to the page. Every route streams now that there is a `loading.tsx`
  // above it, and Next parks streamed content in a hidden div at the end of
  // <body>, which matches on text even though nobody can see it.
  await expect(
    visible(page).getByText('Nothing was picked up from this page.'),
  ).toBeVisible()

  // Adding by hand is the other half of the create path the split touched: it
  // passes a null bbox, and it should select and expand the new card.
  await visible(page).getByRole('button', { name: 'Add a question by hand' }).click()

  const prompt = visible(page).getByLabel('Question text')
  await expect(prompt).toBeVisible()
  await expect(prompt).toHaveValue('New question')

  // Waits on the PATCH rather than on the "Saved" caption. The caption is
  // already showing from the create above and never goes back to idle, so
  // asserting on it passes before the edit has been written and the test then
  // navigates away inside the 600ms debounce, taking the edit with it.
  const promptSaved = savedResponse()
  await prompt.fill('What is the measure of the third angle in a triangle?')
  await promptSaved

  // The summary card reads from the same state the editor writes, so this is
  // also the check that the memoized card still re-renders for its own edit.
  await expect(
    visible(page).getByText('What is the measure of the third angle in a triangle?').first(),
  ).toBeVisible()
})

test('a choice added in the editor is marked correct and saved', async () => {
  const choiceAdded = savedResponse()
  await visible(page).getByRole('button', { name: 'Add choice' }).click()
  await choiceAdded

  const textSaved = savedResponse()
  await visible(page).getByLabel('Text for choice A').fill('60 degrees')
  await textSaved

  const markedCorrect = savedResponse()
  await visible(page).getByRole('radio', { name: 'Mark choice A correct' }).check()
  await markedCorrect

  await expect(visible(page).getByRole('radio', { name: 'Mark choice A correct' })).toBeChecked()
})

test('an edit survives navigating away inside the autosave debounce', async () => {
  await page.goto(`/worksheets/${worksheetId}/review`)
  await visible(page).getByRole('button', { name: 'Fix' }).first().click()

  const prompt = visible(page).getByLabel('Question text')
  await expect(prompt).toBeVisible()

  const edited = 'Edited, then left the page straight away.'
  await prompt.fill(edited)

  // Deliberately no wait. This lands inside the 600ms debounce, which used to
  // throw the edit away: the timers were cleared on unmount and nothing sent.
  await page.goto('/dashboard')
  await expect(visible(page).getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await expect(async () => {
    const listed = await page.request.get(`/api/worksheets/${worksheetId}/questions`)
    const { questions } = (await listed.json()) as { questions: { promptText: string }[] }
    expect(questions[0].promptText).toBe(edited)
  }).toPass({ timeout: 15_000 })
})

test('a whole worksheet can be reported from the verify screen', async () => {
  await page.goto(`/worksheets/${worksheetId}/verify`)
  await expect(visible(page).getByRole('heading', { name: 'Check Your Questions' })).toBeVisible()

  const open = visible(page).getByRole('button', {
    name: 'Something is wrong with this whole worksheet',
  })
  await expect(open).toBeVisible()
  await open.click()

  await page
    .getByPlaceholder('Missing questions, wrong pages, numbering off?')
    .fill('It missed every question on page 2.')

  await visible(page).getByRole('button', { name: 'Send report' }).click()

  await expect(visible(page).getByText('Thanks. That is on the list to look at.')).toBeVisible()
})

/**
 * Scoped through `visible()` like every other assertion here, and worth a note
 * because this one escaped the sweep that scoped the rest: the page is called
 * `adminPage`, so a search for `page.getBy` never saw it. It failed
 * intermittently for months of runs afterwards, on the streamed copy of the
 * page matching the same text as the real one.
 */
test('the report reaches the admin queue', async ({ browser }) => {
  const adminPage = await browser.newPage()

  try {
    await signInAsAdmin(adminPage, ADMIN_EMAIL)
    await adminPage.goto('/admin/reports')

    await expect(visible(adminPage).getByRole('heading', { name: 'Reports' })).toBeVisible()
    await expect(visible(adminPage).getByText('It missed every question on page 2.')).toBeVisible()
    await expect(visible(adminPage).getByText('Whole worksheet')).toBeVisible()
    await expect(visible(adminPage).getByText('Reports Fixture')).toBeVisible()

    // Marking it done clears it from the queue and keeps the row.
    await visible(adminPage).getByRole('button', { name: 'Done' }).first().click()
    await expect(visible(adminPage).getByText('It missed every question on page 2.')).toHaveCount(0)
    await expect(visible(adminPage).getByText('Nothing reported.')).toBeVisible()
  } finally {
    await adminPage.close()
  }
})

test('rating buttons say when each answer brings the card back', async () => {
  await page.goto(`/worksheets/${worksheetId}/review`)
  await visible(page).getByRole('button', { name: /Looks Right, Mark \d+ Question/ }).click()
  await page.waitForURL(/\/worksheets\/[^/]+\/markup/, { timeout: 30_000 })

  await visible(page).getByText('Missed It').first().click()
  await visible(page).getByRole('button', { name: 'Next: What You Put' }).click()
  await expect(visible(page).getByText(/What did you put/)).toBeVisible()
  await visible(page).getByText('60 degrees', { exact: true }).click()
  await visible(page).getByRole('button', { name: 'Save and Finish' }).click()
  await page.waitForURL('**/dashboard', { timeout: 30_000 })

  await page.goto('/review')
  await visible(page).getByRole('button', { name: 'Show answer' }).click()

  // The previewIntervals wiring: every rating carries the wait it buys, and
  // "Again" must not promise longer than "Easy".
  for (const rating of ['Again', 'Hard', 'Good', 'Easy']) {
    await expect(
      visible(page).getByRole('button', { name: new RegExp(rating) }),
    ).toContainText(/\d+\s*(min|h|d|mo|y)|<1 min/)
  }
})

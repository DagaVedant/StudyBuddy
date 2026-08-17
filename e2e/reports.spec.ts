import { expect, test, type Page } from '@playwright/test'

import { TRIAL_WORKSHEET_LIMIT } from '../lib/ai/limits'

import {
  visible,
  registerAndSignIn,
  setTrialWorksheetsUsed,
  signInAsAdmin,
  uploadWorksheet,
} from './support/helpers'

test.describe.configure({ mode: 'serial' })

let page: Page
let worksheetId: string

const ADMIN_EMAIL = 'admin@studybuddy.test'

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
  await page.goto(`/worksheets/${worksheetId}/edit`)
  await expect(visible(page).getByRole('heading', { name: 'Add Your Questions' })).toBeVisible()

  await expect(visible(page).getByRole('heading', { name: '0 questions found' })).toBeVisible()
  await expect(
    visible(page).getByText('Nothing was picked up from this page.'),
  ).toBeVisible()

  await visible(page).getByRole('button', { name: 'Add a question by hand' }).click()

  const prompt = visible(page).getByLabel('Question text')
  await expect(prompt).toBeVisible()
  await expect(prompt).toHaveValue('New question')

  const promptSaved = savedResponse()
  await prompt.fill('What is the measure of the third angle in a triangle?')
  await promptSaved

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
  await page.goto(`/worksheets/${worksheetId}/edit`)
  await visible(page).getByRole('button', { name: 'Fix' }).first().click()

  const prompt = visible(page).getByLabel('Question text')
  await expect(prompt).toBeVisible()

  const edited = 'Edited, then left the page straight away.'
  await prompt.fill(edited)

  await page.goto('/dashboard')
  await expect(visible(page).getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await expect(async () => {
    const listed = await page.request.get(`/api/worksheets/${worksheetId}/questions`)
    const { questions } = (await listed.json()) as { questions: { promptText: string }[] }
    expect(questions[0].promptText).toBe(edited)
  }).toPass({ timeout: 15_000 })
})

test('a whole worksheet can be reported from the verify screen', async () => {
  await page.goto(`/worksheets/${worksheetId}/check`)
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

test('the report reaches the admin queue', async ({ browser }) => {
  const adminPage = await browser.newPage()

  try {
    await signInAsAdmin(adminPage, ADMIN_EMAIL)
    await adminPage.goto('/admin/reports')

    await expect(visible(adminPage).getByRole('heading', { name: 'Reports' })).toBeVisible()
    await expect(visible(adminPage).getByText('It missed every question on page 2.')).toBeVisible()
    await expect(visible(adminPage).getByText('Whole worksheet')).toBeVisible()
    await expect(visible(adminPage).getByText('Reports Fixture')).toBeVisible()

    await visible(adminPage).getByRole('button', { name: 'Done' }).first().click()
    await expect(visible(adminPage).getByText('It missed every question on page 2.')).toHaveCount(0)
    await expect(visible(adminPage).getByText('Nothing reported.')).toBeVisible()
  } finally {
    await adminPage.close()
  }
})

test('rating buttons say when each answer brings the card back', async () => {
  await page.goto(`/worksheets/${worksheetId}/edit`)
  await visible(page).getByRole('button', { name: /Looks right, mark \d+ question/ }).click()
  await page.waitForURL(/\/worksheets\/[^/]+\/markup/, { timeout: 30_000 })

  await visible(page).getByText('Missed it').first().click()
  await visible(page).getByRole('button', { name: 'Next: What You Put' }).click()
  await expect(visible(page).getByText(/What did you put/)).toBeVisible()
  await visible(page).getByText('60 degrees', { exact: true }).click()
  await visible(page).getByRole('button', { name: 'Save and finish' }).click()
  await page.waitForURL('**/dashboard', { timeout: 30_000 })

  await page.goto('/review')
  await visible(page).getByRole('button', { name: 'Show answer' }).click()

  for (const rating of ['Again', 'Hard', 'Good', 'Easy']) {
    await expect(
      visible(page).getByRole('button', { name: new RegExp(rating) }),
    ).toContainText(/\d+\s*(min|h|d|mo|y)|<1 min/)
  }
})

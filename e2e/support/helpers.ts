import { expect, type Page } from '@playwright/test'

import { TRIAL_WORKSHEET_LIMIT } from '../../lib/ai/limits'

import { worksheetPdf } from './pdf'

export function visible(page: Page) {
  return page.locator('#main:visible')
}

export function alertBox(page: Page) {
  return page.locator('p[role="alert"]')
}

export function statusBox(page: Page) {
  return page.locator('p[role="status"]')
}

export function uniqueEmail(prefix = 'student'): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@studybuddy.test`
}

export function adultDob(): string {
  const now = new Date()
  return `${now.getFullYear() - 20}-01-15`
}

export function minorDob(): string {
  const now = new Date()
  return `${now.getFullYear() - 9}-01-15`
}

const PASSWORD = 'correct-horse-battery'

export async function registerAndSignIn(
  page: Page,
  email = uniqueEmail(),
): Promise<string> {
  await page.goto('/signup')
  await visible(page).getByLabel('Email').fill(email)
  await visible(page).getByLabel('Password').fill(PASSWORD)
  await visible(page).getByLabel('Date of birth').fill(adultDob())
  await visible(page).getByRole('button', { name: 'Create account', exact: true }).click()

  await expect(statusBox(page)).toBeVisible()

  await page.goto('/signin')
  await visible(page).getByLabel('Email').fill(email)
  await visible(page).getByLabel('Password').fill(PASSWORD)
  await visible(page).getByRole('button', { name: 'Sign in', exact: true }).click()

  await page.waitForURL('**/dashboard')
  return email
}

export async function signInAsAdmin(page: Page, email: string): Promise<void> {
  const created = await page.request.post('/api/test/admin-account', {
    data: { email, password: PASSWORD },
  })
  if (!created.ok()) throw new Error(`Could not create the admin account for ${email}`)

  await page.goto('/signin')
  await visible(page).getByLabel('Email').fill(email)
  await visible(page).getByLabel('Password').fill(PASSWORD)
  await visible(page).getByRole('button', { name: 'Sign in', exact: true }).click()

  await page.waitForURL('**/dashboard')
}

export async function uploadWorksheet(page: Page, title = 'Unit 4 Practice'): Promise<void> {
  await page.goto('/upload')

  await visible(page).locator('input[type="file"][accept*="pdf"]').setInputFiles({
    name: 'unit-4.pdf',
    mimeType: 'application/pdf',
    buffer: worksheetPdf(),
  })

  await expect(visible(page).getByText('unit-4.pdf')).toBeVisible()

  await visible(page).getByLabel('Worksheet name').fill(title)
  await visible(page).getByRole('button', { name: 'Start processing' }).click()

  await page.waitForURL(/\/worksheets\/[^/]+\/(edit|status)/, { timeout: 90_000 })
}

export async function createWorksheet(page: Page, title: string): Promise<string> {
  const response = await page.request.post('/api/worksheets', {
    data: { title, sourceType: 'pdf_digital', pageCount: 1 },
  })

  if (!response.ok()) {
    throw new Error(`Could not create ${title}: ${await response.text()}`)
  }

  const { worksheetId } = (await response.json()) as { worksheetId: string }
  return worksheetId
}

export async function connectCloudKey(page: Page): Promise<void> {
  const response = await page.request.post('/api/settings/credentials', {
    data: { provider: 'anthropic', apiKey: 'sk-ant-e2e-not-a-real-key' },
  })

  if (!response.ok()) {
    throw new Error(`Could not connect a cloud key: ${await response.text()}`)
  }
}

export async function setTrialWorksheetsUsed(
  page: Page,
  email: string,
  used: number,
): Promise<void> {
  const response = await page.request.post('/api/test/trial-worksheets-used', {
    data: { email, used },
  })
  if (!response.ok()) throw new Error(`Could not set trial usage for ${email}`)
}

export interface SeededWorksheet {
  worksheetId: string
  questionId: string
}

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

export async function seedReviewableWorksheet(
  page: Page,
  email: string,
  opts: {
    title?: string
    promptText?: string
    choices?: { label: string; text: string; isCorrect?: boolean }[]
  } = {},
): Promise<SeededWorksheet> {
  await setTrialWorksheetsUsed(page, email, TRIAL_WORKSHEET_LIMIT)

  const created = await page.request.post('/api/worksheets', {
    data: {
      title: opts.title ?? 'Unit 4 Practice',
      sourceType: 'pdf_digital',
      pageCount: 1,
    },
  })
  const { worksheetId } = (await created.json()) as { worksheetId: string }

  const paged = await page.request.post(`/api/worksheets/${worksheetId}/pages`, {
    multipart: {
      image: { name: 'page-1.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG },
      pageNumber: '1',
    },
  })
  if (!paged.ok()) {
    throw new Error(`Could not upload a page for ${worksheetId}: ${await paged.text()}`)
  }

  const made = await page.request.post(`/api/worksheets/${worksheetId}/questions`, {
    data: {
      ordinal: 1,
      promptText: opts.promptText ?? 'In triangle ABC, angle A is 75°. What is angle B?',
      questionType: 'multiple_choice',
      choices: opts.choices ?? [
        { label: 'A', text: '75', isCorrect: true },
        { label: 'B', text: '105', isCorrect: false },
      ],
    },
  })
  const { questionId } = (await made.json()) as { questionId: string }

  const completed = await page.request.post(`/api/worksheets/${worksheetId}/complete`)
  if (!completed.ok()) {
    throw new Error(`Could not complete worksheet ${worksheetId}: ${await completed.text()}`)
  }

  return { worksheetId, questionId }
}

import { expect, type Page } from '@playwright/test'

import { worksheetPdf } from './pdf'

export async function closeDbClient(): Promise<void> {}

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
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByLabel('Date of birth').fill(adultDob())
  await page.getByRole('button', { name: 'Create account' }).click()

  // No verification round-trip any more: nothing sends mail, so an account is
  // usable the moment it is made.
  await expect(statusBox(page)).toBeVisible()

  await page.goto('/signin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.waitForURL('**/dashboard')
  return email
}

/**
 * Signs in as an admin, Google link and all.
 *
 * Not `registerAndSignIn` with an admin address: signup refuses those, and the
 * role needs a linked Google account rather than a password. The test endpoint
 * creates both, so what is exercised here is the rule, not a way around it.
 */
export async function signInAsAdmin(page: Page, email: string): Promise<void> {
  const created = await page.request.post('/api/test/admin-account', {
    data: { email, password: PASSWORD },
  })
  if (!created.ok()) throw new Error(`Could not create the admin account for ${email}`)

  await page.goto('/signin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.waitForURL('**/dashboard')
}

export async function uploadWorksheet(page: Page, title = 'Unit 4 Practice'): Promise<void> {
  await page.goto('/upload')

  await page.locator('input[type="file"][accept*="pdf"]').setInputFiles({
    name: 'unit-4.pdf',
    mimeType: 'application/pdf',
    buffer: worksheetPdf(),
  })

  await expect(page.getByText('unit-4.pdf')).toBeVisible()

  await page.getByLabel('Worksheet name').fill(title)
  await page.getByRole('button', { name: 'Start Processing' }).click()

  await page.waitForURL(/\/worksheets\/[^/]+\/(review|status)/, { timeout: 90_000 })
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

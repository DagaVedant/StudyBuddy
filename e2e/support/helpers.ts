import { expect, type Page } from '@playwright/test'

import { CONTROL_URL } from './database'
import { worksheetPdf } from './pdf'

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const response = await fetch(CONTROL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  })

  const body = (await response.json()) as { rows?: T[]; error?: string }
  if (!response.ok) throw new Error(body.error ?? 'Control query failed')

  return body.rows ?? []
}

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

  await expect(statusBox(page)).toContainText('verification link')

  const rows = await query<{ token: string }>(
    'select token from verification_tokens where identifier = $1 limit 1',
    [email],
  )
  if (rows.length === 0) throw new Error(`No verification token issued for ${email}`)

  await page.goto(`/verify?token=${rows[0].token}&email=${encodeURIComponent(email)}`)
  await expect(statusBox(page)).toContainText('Email verified')

  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.waitForURL('**/dashboard')
  return email
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
  email: string,
  used: number,
): Promise<void> {
  await query('update users set trial_worksheets_used = $1 where email = $2', [
    used,
    email,
  ])
}

import { expect, type Page } from '@playwright/test'

import { CONTROL_URL } from './database'
import { worksheetPdf } from './pdf'

/**
 * Test helpers that talk to the same embedded Postgres the app is using, so
 * setup can drive the real flows rather than faking state.
 */

/**
 * Queries the in-process PGlite through the test control endpoint.
 *
 * The app owns the Postgres socket; opening a second client on it gets reset,
 * so specs read state this way instead.
 */
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

/** Kept so specs can call it; there is no long-lived connection to close. */
export async function closeDbClient(): Promise<void> {}

/**
 * Next.js renders a route announcer with role="alert", so an unscoped
 * getByRole('alert') matches two elements. Every alert this app renders is a
 * <p>, which disambiguates cleanly.
 */
export function alertBox(page: Page) {
  return page.locator('p[role="alert"]')
}

export function statusBox(page: Page) {
  return page.locator('p[role="status"]')
}

export function uniqueEmail(prefix = 'student'): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@studybuddy.test`
}

/** A date of birth that is comfortably over the 13+ gate. */
export function adultDob(): string {
  const now = new Date()
  return `${now.getFullYear() - 20}-01-15`
}

export function minorDob(): string {
  const now = new Date()
  return `${now.getFullYear() - 9}-01-15`
}

const PASSWORD = 'correct-horse-battery'

/**
 * Signs up through the real form, then completes the real email-verification
 * round trip by reading the token out of the database — the same link the
 * student would click.
 */
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

  // Completes the real verification round trip by reading the token the app
  // just issued — the same link the student would click.
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

/** Runs the browser ingest pipeline for real: pdf.js -> upload -> text layer. */
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

  // Ingest ends on the review editor (Tier A) or the status page (queued).
  await page.waitForURL(/\/worksheets\/[^/]+\/(review|status)/, { timeout: 90_000 })
}

export async function setTrialPagesUsed(email: string, used: number): Promise<void> {
  await query('update users set trial_pages_used = $1 where email = $2', [used, email])
}

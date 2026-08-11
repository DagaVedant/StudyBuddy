import { expect, type Page } from '@playwright/test'

import { worksheetPdf } from './pdf'

/**
 * The page as a reader sees it.
 *
 * Every route has a `loading.tsx` above it now, so every route streams, and
 * Next parks streamed content in a hidden div at the end of <body> until an
 * inline script moves it into place. That copy is inert and invisible, but it
 * matches on text and on selectors, so an unscoped locator can find two of
 * everything and fail Playwright's strict-mode check. Which of the two is
 * present depends on when the assertion samples the DOM, so it fails
 * intermittently, which is the worst way for it to fail.
 *
 * Use this for anything a page renders. The topbar is the exception: it sits
 * above the boundary and outside `#main`, so assertions about the nav, the
 * theme toggle and Sign out go through `page` directly.
 *
 * `#main` is the content wrapper each route group renders, and the buffer sits
 * outside it, so scoping to it is both the fix and a truer statement of what
 * these assertions mean: this text is on the page, not merely in the document.
 *
 * `:visible` is belt and braces. It costs nothing and it is what makes this
 * survive the boundary moving: put a `loading.tsx` above the wrapper rather
 * than below it and the buffer starts carrying a second `#main`, at which point
 * the id alone is ambiguous and every assertion in this suite fails at once.
 */
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
  await visible(page).getByRole('button', { name: 'Create account' }).click()

  // No verification round-trip any more: nothing sends mail, so an account is
  // usable the moment it is made.
  await expect(statusBox(page)).toBeVisible()

  await page.goto('/signin')
  await visible(page).getByLabel('Email').fill(email)
  await visible(page).getByLabel('Password').fill(PASSWORD)
  await visible(page).getByRole('button', { name: 'Sign in' }).click()

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
  await visible(page).getByLabel('Email').fill(email)
  await visible(page).getByLabel('Password').fill(PASSWORD)
  await visible(page).getByRole('button', { name: 'Sign in' }).click()

  await page.waitForURL('**/dashboard')
}

export async function uploadWorksheet(page: Page, title = 'Unit 4 Practice'): Promise<void> {
  await page.goto('/upload')

  // Scoped like every text assertion in this suite, and for the same reason:
  // the streamed copy of the page carries its own file input, so an unscoped
  // selector resolves to two and fails strict mode.
  await visible(page).locator('input[type="file"][accept*="pdf"]').setInputFiles({
    name: 'unit-4.pdf',
    mimeType: 'application/pdf',
    buffer: worksheetPdf(),
  })

  await expect(visible(page).getByText('unit-4.pdf')).toBeVisible()

  await visible(page).getByLabel('Worksheet name').fill(title)
  await visible(page).getByRole('button', { name: 'Start processing' }).click()

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

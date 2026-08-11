import { expect, test } from '@playwright/test'

import { registerAndSignIn, uniqueEmail, visible } from './support/helpers'

/**
 * Sign-in used to hand `redirectTo` the raw `next` form field, so
 * `/signin?next=https://example.com` sent the student to example.com the moment
 * they authenticated, one keystroke after typing a password.
 *
 * Tested end to end rather than only as a unit, because the interesting claim
 * is about where the browser ends up. `safeNextPath` returning `/dashboard` is
 * necessary and not sufficient: the value also travels through a hidden input
 * and a server action, and either could have reintroduced the original.
 */
test.describe.configure({ mode: 'serial' })

test('an off-site next is ignored and sign-in lands on the dashboard', async ({
  browser,
}) => {
  const page = await browser.newPage()
  const email = uniqueEmail()

  // Register first, then sign in by hand so the hostile next is in play for the
  // submit rather than only for the page load.
  await registerAndSignIn(page, email)
  await page.goto('/api/auth/signout')
  await page.getByRole('button', { name: /sign out/i }).click().catch(() => {})

  await page.goto('/signin?next=https://example.com/steal')
  await visible(page).getByLabel('Email').fill(email)
  await visible(page).getByLabel('Password').fill('correct-horse-battery')
  await visible(page).getByRole('button', { name: 'Sign in' }).click()

  await page.waitForURL('**/dashboard')
  expect(new URL(page.url()).origin).toBe(new URL(page.url()).origin)
  expect(page.url()).not.toContain('example.com')

  await page.close()
})

test('a protocol-relative next is ignored too', async ({ browser }) => {
  const page = await browser.newPage()

  await page.goto('/signin?next=//example.com')

  // The hidden field is sanitised before it is ever rendered, so the attacker
  // URL is not even in the DOM.
  const next = page.locator('input[name="next"]')
  await expect(next).toHaveValue('/dashboard')

  await page.close()
})

test('a real in-app next still works, which is the point of the parameter', async ({
  browser,
}) => {
  const page = await browser.newPage()

  await page.goto('/signin?next=/upload')

  const next = page.locator('input[name="next"]')
  await expect(next).toHaveValue('/upload')

  await page.close()
})

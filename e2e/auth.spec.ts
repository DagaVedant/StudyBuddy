import { expect, test } from '@playwright/test'

import {
  adultDob,
  alertBox,
  statusBox,
  closeDbClient,
  minorDob,
  registerAndSignIn,
  signInAsAdmin,
  uniqueEmail,
} from './support/helpers'

test.afterAll(async () => {
  await closeDbClient()
})

test('signed-out visitors are sent to sign in, with a return path', async ({ page }) => {
  await page.goto('/dashboard')

  await page.waitForURL(/\/signin/)
  expect(page.url()).toContain('next=%2Fdashboard')
})

test('the 13+ gate is enforced on the server, not just the date input', async ({
  page,
}) => {
  await page.goto('/signup')
  await page.getByLabel('Email').fill(uniqueEmail('minor'))
  await page.getByLabel('Password').fill('correct-horse-battery')
  await page.getByLabel('Date of birth').fill(minorDob())
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(alertBox(page)).toContainText('at least 13')
})

test('signup does not reveal whether an email is already registered', async ({
  page,
}) => {
  const email = uniqueEmail('dupe')

  const signUp = async () => {
    await page.goto('/signup')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill('correct-horse-battery')
    await page.getByLabel('Date of birth').fill(adultDob())
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(statusBox(page)).toBeVisible()
    return statusBox(page).textContent()
  }

  const first = await signUp()
  const second = await signUp()

  expect(second).toBe(first)
})

test('a new password account can sign in straight away', async ({ page }) => {
  const email = uniqueEmail('unverified')

  await page.goto('/signup')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('correct-horse-battery')
  await page.getByLabel('Date of birth').fill(adultDob())
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(statusBox(page)).toBeVisible()

  await page.goto('/signin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('correct-horse-battery')
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Nothing sends mail any more, so an account is usable as soon as it is
  // made. This used to assert the opposite.
  await page.waitForURL(/\/dashboard/)
})

test('a wrong password is rejected', async ({ page }) => {
  const email = await registerAndSignIn(page)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.waitForURL(/\/signin/)

  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('not-the-password')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(alertBox(page)).toBeVisible()
})

test('verify and sign in reaches the dashboard', async ({ page }) => {
  await registerAndSignIn(page)

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText('Nothing tracked yet')).toBeVisible()
})

test('the admin console is hidden from students', async ({ page }) => {
  await registerAndSignIn(page)

  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0)

  await page.goto('/admin/topics')
  await expect(page.getByRole('heading', { name: 'Admin' })).toHaveCount(0)
})

test('an account in ADMIN_EMAILS gets the admin console', async ({ page }) => {
  await signInAsAdmin(page, 'admin@studybuddy.test')

  await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible()

  await page.goto('/admin/topics')
  await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible()
  await expect(page.getByText('Workers & queue')).toBeVisible()
})

// The escalation this used to allow: register an admin address with a password
// before its owner does and inherit the console. Signup refuses the address,
// and the role needs a Google link the account has no way to get, so both
// halves have to fail for the attack to be closed.
test('a password signup cannot take an admin address', async ({ page }) => {
  await page.goto('/signup')
  await page.getByLabel('Email').fill('boss@studybuddy.test')
  await page.getByLabel('Password').fill('correct-horse-battery')
  await page.getByLabel('Date of birth').fill(adultDob())
  await page.getByRole('button', { name: 'Create account' }).click()

  // The same reply every other outcome gives, so it does not say which
  // addresses are admin.
  await expect(statusBox(page)).toBeVisible()

  // Nothing was created, so there is nothing to sign in to.
  await page.goto('/signin')
  await page.getByLabel('Email').fill('boss@studybuddy.test')
  await page.getByLabel('Password').fill('correct-horse-battery')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(alertBox(page)).toBeVisible()
  await expect(page).toHaveURL(/\/signin/)
})

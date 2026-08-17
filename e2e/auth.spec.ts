import { expect, test } from '@playwright/test'

import {
  visible,
  adultDob,
  alertBox,
  statusBox,
  minorDob,
  registerAndSignIn,
  signInAsAdmin,
  uniqueEmail,
} from './support/helpers'
import { resetDatabase } from './support/reset'

test.beforeAll(resetDatabase)

const UNCLAIMED_ADMIN_EMAIL = 'unclaimed@studybuddy.test'

test('signed-out visitors are sent to sign in, with a return path', async ({ page }) => {
  await page.goto('/dashboard')

  await page.waitForURL(/\/signin/)
  expect(page.url()).toContain('next=%2Fdashboard')
})

test('the 13+ gate is enforced on the server, not just the date input', async ({
  page,
}) => {
  await page.goto('/signup')
  await visible(page).getByLabel('Email').fill(uniqueEmail('minor'))
  await visible(page).getByLabel('Password').fill('correct-horse-battery')
  await visible(page).getByLabel('Date of birth').fill(minorDob())
  await visible(page).getByRole('button', { name: 'Create account' }).click()

  await expect(alertBox(page)).toContainText('at least 13')
})

test('signup does not reveal whether an email is already registered', async ({
  page,
}) => {
  const email = uniqueEmail('dupe')

  const signUp = async () => {
    await page.goto('/signup')
    await visible(page).getByLabel('Email').fill(email)
    await visible(page).getByLabel('Password').fill('correct-horse-battery')
    await visible(page).getByLabel('Date of birth').fill(adultDob())
    await visible(page).getByRole('button', { name: 'Create account' }).click()
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
  await visible(page).getByLabel('Email').fill(email)
  await visible(page).getByLabel('Password').fill('correct-horse-battery')
  await visible(page).getByLabel('Date of birth').fill(adultDob())
  await visible(page).getByRole('button', { name: 'Create account' }).click()
  await expect(statusBox(page)).toBeVisible()

  await page.goto('/signin')
  await visible(page).getByLabel('Email').fill(email)
  await visible(page).getByLabel('Password').fill('correct-horse-battery')
  await visible(page).getByRole('button', { name: 'Sign in' }).click()

  await page.waitForURL(/\/dashboard/)
})

test('a wrong password is rejected', async ({ page }) => {
  const email = await registerAndSignIn(page)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.waitForURL(/\/signin/)

  await visible(page).getByLabel('Email').fill(email)
  await visible(page).getByLabel('Password').fill('not-the-password')
  await visible(page).getByRole('button', { name: 'Sign in' }).click()

  await expect(alertBox(page)).toBeVisible()
})

test('verify and sign in reaches the dashboard', async ({ page }) => {
  await registerAndSignIn(page)

  await expect(visible(page).getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(visible(page).getByText('Nothing tracked yet')).toBeVisible()
})

test('the admin console is hidden from students', async ({ page }) => {
  await registerAndSignIn(page)

  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0)

  await page.goto('/admin/topics')
  await expect(visible(page).getByRole('heading', { name: 'Admin' })).toHaveCount(0)
})

test('an account in ADMIN_EMAILS gets the admin console', async ({ page }) => {
  await signInAsAdmin(page, 'admin@studybuddy.test')

  await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible()

  await page.goto('/admin/topics')
  await expect(visible(page).getByRole('heading', { name: 'Admin' })).toBeVisible()
  await expect(visible(page).getByText('Workers & queue')).toBeVisible()
})

test('a password signup cannot take an admin address', async ({ page }) => {
  await page.goto('/signup')
  await visible(page).getByLabel('Email').fill(UNCLAIMED_ADMIN_EMAIL)
  await visible(page).getByLabel('Password').fill('correct-horse-battery')
  await visible(page).getByLabel('Date of birth').fill(adultDob())
  await visible(page).getByRole('button', { name: 'Create account' }).click()

  await expect(statusBox(page)).toBeVisible()

  await page.goto('/signin')
  await visible(page).getByLabel('Email').fill(UNCLAIMED_ADMIN_EMAIL)
  await visible(page).getByLabel('Password').fill('correct-horse-battery')
  await visible(page).getByRole('button', { name: 'Sign in' }).click()

  await expect(alertBox(page)).toBeVisible()
  await expect(page).toHaveURL(/\/signin/)
})

test('a forgotten password is reachable from sign in', async ({ page }) => {
  await page.goto('/signin')
  await visible(page).getByRole('link', { name: 'Forgot your password?' }).click()

  await page.waitForURL(/\/forgot/)
  await expect(visible(page).getByLabel('Email')).toBeVisible()
})

test('a deployment that cannot send email says so rather than promising a link', async ({
  page,
}) => {
  await page.goto('/forgot')
  await visible(page).getByLabel('Email').fill(uniqueEmail('forgot'))
  await visible(page).getByRole('button', { name: 'Email me a link' }).click()

  await expect(alertBox(page)).toContainText('cannot send email')
})

test('a reset link that was never issued is refused', async ({ page }) => {
  await page.goto('/reset/not-a-real-token')

  await expect(visible(page).getByRole('link', { name: 'Send me another' })).toBeVisible()
  await expect(visible(page).getByLabel('New password')).toHaveCount(0)
})

test('the pitch offers a signed-in reader the dashboard', async ({ page }) => {
  await registerAndSignIn(page, `pitch-${Date.now()}@example.com`)

  await page.goto('/')

  await expect(
    visible(page).getByRole('link', { name: 'Go to your dashboard' }),
  ).toBeVisible()
  await expect(
    visible(page).getByRole('link', { name: 'Get started' }),
  ).toHaveCount(0)
})

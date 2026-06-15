import { expect, test } from '@playwright/test'

import {
  closeDbClient,
  registerAndSignIn,
  setTrialPagesUsed,
  uploadWorksheet,
} from './support/helpers'

test.afterAll(async () => {
  await closeDbClient()
})

test('a fresh account queues its upload for the GPU worker', async ({ page }) => {
  await registerAndSignIn(page)
  await uploadWorksheet(page, 'Queued Set')

  await expect(page).toHaveURL(/\/worksheets\/[^/]+\/status/)
  await expect(page.getByRole('heading', { name: 'Working on It' })).toBeVisible()

  // No worker is running in tests, which is exactly the "operator's machine is
  // asleep" case: the job queues rather than failing (spec §3.3).
  await expect(page.getByText(/queue|offline/i).first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to Dashboard' })).toBeVisible()
})

test('an exhausted trial falls through to the manual editor, not a dead end', async ({
  page,
}) => {
  const email = await registerAndSignIn(page)
  await setTrialPagesUsed(email, 10)

  await uploadWorksheet(page, 'After Trial')

  await expect(page).toHaveURL(/\/worksheets\/[^/]+\/review/)
  await expect(page.getByRole('heading', { name: 'Review Questions' })).toBeVisible()
})

test('settings offers both upgrade paths and states where trial pages go', async ({
  page,
}) => {
  await registerAndSignIn(page)
  await page.goto('/settings')

  await expect(page.getByRole('heading', { name: 'How StudyBuddy Thinks' })).toBeVisible()

  // The processing-location disclosure is required at the point of use
  // (spec §8), not buried in a policy page.
  await expect(page.getByText(/hardware we operate/i)).toBeVisible()
  await expect(page.getByText(/never used for training/i)).toBeVisible()

  await expect(page.getByRole('heading', { name: 'Your own API key' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your own GPU (Ollama)' })).toBeVisible()

  // The tab-must-stay-open constraint is stated up front (spec §3.4).
  await expect(page.getByText(/tab has to stay open/i)).toBeVisible()
})

test('an Ollama address outside localhost is rejected', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/settings')

  await page.getByLabel('Ollama address').fill('http://169.254.169.254')
  await page.getByRole('button', { name: 'Connect Ollama' }).click()

  await expect(page.getByRole('alert')).toContainText(/localhost/i)
})

test('a saved API key is never shown again', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/settings')

  const secret = 'sk-ant-e2e-secret-value-do-not-echo-4f2a'
  await page.getByLabel('API key').fill(secret)
  await page.getByRole('button', { name: 'Save Key' }).click()

  await expect(page.getByText(/key ending 4f2a/)).toBeVisible()

  // Only the last four characters may ever come back (spec §3.6).
  await page.reload()
  expect(await page.content()).not.toContain(secret)
})

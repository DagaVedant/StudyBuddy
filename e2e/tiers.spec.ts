import { expect, test } from '@playwright/test'

import { TRIAL_WORKSHEET_LIMIT } from '../lib/ai/limits'

import {
  alertBox,
  closeDbClient,
  registerAndSignIn,
  setTrialWorksheetsUsed,
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

  await expect(page.getByText(/queue|offline/i).first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to Dashboard' })).toBeVisible()
})

test('an exhausted trial falls through to the manual editor, not a dead end', async ({
  page,
}) => {
  const email = await registerAndSignIn(page)
  await setTrialWorksheetsUsed(page, email, TRIAL_WORKSHEET_LIMIT)

  await uploadWorksheet(page, 'After Trial')

  await expect(page).toHaveURL(/\/worksheets\/[^/]+\/review/)
  await expect(page.getByRole('heading', { name: 'Add Your Questions' })).toBeVisible()
})

test('settings offers both upgrade paths and states where trial work runs', async ({
  page,
}) => {
  await registerAndSignIn(page)
  await page.goto('/settings')

  await expect(page.getByRole('heading', { name: 'How StudyBuddy Thinks' })).toBeVisible()

  await expect(page.getByText(/hardware we operate/i)).toBeVisible()
  await expect(page.getByText(/never used for training/i)).toBeVisible()

  await expect(page.getByRole('heading', { name: 'Your own API key' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your own GPU (Ollama)' })).toBeVisible()

  await expect(page.getByText(/still being built/i)).toBeVisible()
})

test('an Ollama address outside localhost is rejected', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/settings')

  await page.getByLabel('Ollama address').fill('http://169.254.169.254')
  await page.getByRole('button', { name: 'Connect Ollama' }).click()

  await expect(alertBox(page)).toContainText(/localhost/i)
})

test('a saved API key is never shown again', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/settings')

  const secret = 'sk-ant-e2e-secret-value-do-not-echo-4f2a'
  await page.getByRole('textbox', { name: 'API key' }).fill(secret)
  await page.getByRole('button', { name: 'Save Key' }).click()

  await expect(page.getByText(/key ending 4f2a/)).toBeVisible()

  await page.reload()
  expect(await page.content()).not.toContain(secret)
})

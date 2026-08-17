import { expect, test } from '@playwright/test'

import { TRIAL_WORKSHEET_LIMIT } from '../lib/ai/limits'

import {
  alertBox,
  registerAndSignIn,
  setTrialWorksheetsUsed,
  uploadWorksheet,
  visible,
} from './support/helpers'

test('a fresh account queues its upload for the GPU worker', async ({ page }) => {
  await registerAndSignIn(page)
  await uploadWorksheet(page, 'Queued Set')

  await expect(page).toHaveURL(/\/worksheets\/[^/]+\/status/)
  await expect(visible(page).getByRole('heading', { name: 'Working on It' })).toBeVisible()

  await expect(
    visible(page).getByText('Queued. The processing machine is offline right now'),
  ).toBeVisible()

  await expect(visible(page).getByText(/Reading your worksheet/)).toHaveCount(0)

  await expect(visible(page).getByRole('link', { name: 'Back to dashboard' })).toBeVisible()
})

test('an exhausted trial falls through to the manual editor, not a dead end', async ({
  page,
}) => {
  const email = await registerAndSignIn(page)
  await setTrialWorksheetsUsed(page, email, TRIAL_WORKSHEET_LIMIT)

  await uploadWorksheet(page, 'After Trial')

  await expect(page).toHaveURL(/\/worksheets\/[^/]+\/edit/)
  await expect(visible(page).getByRole('heading', { name: 'Add Your Questions' })).toBeVisible()
})

test('settings offers both upgrade paths and states where trial work runs', async ({
  page,
}) => {
  await registerAndSignIn(page)
  await page.goto('/settings')

  await expect(visible(page).getByRole('heading', { name: 'How StudyBuddy Thinks' })).toBeVisible()

  await expect(visible(page).getByText(/hardware we operate/i)).toBeVisible()
  await expect(visible(page).getByText(/never used for training/i)).toBeVisible()

  await expect(visible(page).getByRole('heading', { name: 'Your own API key' })).toBeVisible()
  await expect(visible(page).getByRole('heading', { name: 'Your own GPU (Ollama)' })).toBeVisible()

  await expect(visible(page).getByText(/tab has to stay open/i)).toBeVisible()
  await expect(
    visible(page).getByRole('button', { name: 'Test connection' }),
  ).toBeVisible()
})

test('an Ollama address outside localhost is rejected', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/settings')

  await visible(page).getByLabel('Ollama address').fill('http://169.254.169.254')
  await visible(page).getByRole('button', { name: 'Connect Ollama' }).click()

  await expect(alertBox(page)).toContainText(/localhost/i)
})

test('a saved API key is never shown again', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/settings')

  const secret = 'sk-ant-e2e-secret-value-do-not-echo-4f2a'
  await visible(page).getByRole('textbox', { name: 'API key' }).fill(secret)
  await visible(page).getByRole('button', { name: 'Save key' }).click()

  await expect(visible(page).getByText(/key ending 4f2a/)).toBeVisible()

  await page.reload()
  expect(await page.content()).not.toContain(secret)
})

test('an account can be deleted, and only by typing its own address', async ({
  page,
}) => {
  const email = await registerAndSignIn(page)
  await page.goto('/settings')

  await visible(page).getByRole('button', { name: 'Delete account' }).click()

  const confirm = visible(page).getByRole('button', { name: 'Delete everything' })
  await expect(confirm).toBeDisabled()

  await visible(page).getByLabel(/Type .* to confirm/).fill('someone-else@example.com')
  await expect(confirm).toBeDisabled()

  await visible(page).getByLabel(/Type .* to confirm/).fill(email)
  await expect(confirm).toBeEnabled()
  await confirm.click()

  await page.waitForURL('**/', { timeout: 30_000 })
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/signin/)
})

test('one worksheet left offers the setup choice where it can still be acted on', async ({
  page,
}) => {
  const email = await registerAndSignIn(page)
  await setTrialWorksheetsUsed(page, email, TRIAL_WORKSHEET_LIMIT - 1)

  await page.goto('/dashboard')
  await expect(
    visible(page).getByRole('heading', { name: 'One trial worksheet left' }),
  ).toBeVisible()

  await page.goto('/upload')
  await expect(
    visible(page).getByRole('heading', { name: 'One trial worksheet left' }),
  ).toBeVisible()
  await expect(
    visible(page).getByRole('link', { name: 'Choose how StudyBuddy thinks' }),
  ).toBeVisible()
})

test('a fresh account is not nagged about a trial it has barely started', async ({
  page,
}) => {
  await registerAndSignIn(page)

  await page.goto('/dashboard')
  await expect(
    visible(page).getByRole('heading', { name: 'One trial worksheet left' }),
  ).toHaveCount(0)
})

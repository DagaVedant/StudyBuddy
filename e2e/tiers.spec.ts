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

  /*
   * The exact sentence, where this used to be `/queue|offline/i`.
   *
   * That regex could only ever pass down one branch, and not the one the test
   * is named for. The offline copy contains both "Queued" and "offline", so it
   * matched twice over; none of the three online phases contains either word,
   * so a run against a live worker would have failed here. It asserted the
   * offline branch while reading as though it proved queueing.
   *
   * Being exact is better than deleting it, because the sentence is real
   * evidence. The status page renders it only when the job's executor is not
   * `server` and no worker has a live heartbeat, which is the operator-GPU
   * queue this test is named for. No worker runs in the e2e environment, so
   * that is the branch every run takes, and pinning it means a change that
   * starts routing a fresh account somewhere else fails here instead of
   * passing quietly.
   */
  await expect(
    visible(page).getByText('Queued. The processing machine is offline right now'),
  ).toBeVisible()

  // And not the server-side path, which would say this instead.
  await expect(visible(page).getByText(/Reading your worksheet/)).toHaveCount(0)

  await expect(visible(page).getByRole('link', { name: 'Back to dashboard' })).toBeVisible()
})

test('an exhausted trial falls through to the manual editor, not a dead end', async ({
  page,
}) => {
  const email = await registerAndSignIn(page)
  await setTrialWorksheetsUsed(page, email, TRIAL_WORKSHEET_LIMIT)

  await uploadWorksheet(page, 'After Trial')

  await expect(page).toHaveURL(/\/worksheets\/[^/]+\/review/)
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

  // This used to assert Tier C was "still being built". It is built now, so
  // what is asserted instead is the thing that did not change and never will:
  // the reading happens in the tab, so the tab has to stay open. That is the
  // one fact a student has to know before choosing this tier, and the screen
  // saying so is the difference between an honest option and a trap.
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

/**
 * The one irreversible action in the product, so the flow is asserted end to
 * end rather than only the function behind it: the wrong address must not
 * enable the button, and a real delete must actually sign the account out
 * rather than leaving a cookie pointing at a row that is gone.
 */
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

  // Signed out and back on the public site.
  await page.waitForURL('**/', { timeout: 30_000 })
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/signin/)
})

/**
 * spec.md:339's first moment. The second, settings, always existed; this one
 * did not, so the trial ended as a surprise on the completion route with the
 * worksheet already uploaded.
 */
test('one worksheet left offers the setup choice where it can still be acted on', async ({
  page,
}) => {
  const email = await registerAndSignIn(page)
  await setTrialWorksheetsUsed(page, email, TRIAL_WORKSHEET_LIMIT - 1)

  await page.goto('/dashboard')
  await expect(
    visible(page).getByRole('heading', { name: 'One trial worksheet left' }),
  ).toBeVisible()

  // And on upload, which is the screen where the choice actually costs
  // something: the tier is decided the moment the form is submitted.
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

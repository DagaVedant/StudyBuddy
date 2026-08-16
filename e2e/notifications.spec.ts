import { expect, test } from '@playwright/test'

import { registerAndSignIn, uploadWorksheet, visible } from './support/helpers'

/**
 * §1.2. There was no notification system of any kind: no email, no push, no
 * in-app inbox. The queue, the heartbeat and the status UI were all built, and
 * the piece that makes them useful was not, so "safe to close this page" was
 * true and useless.
 *
 * Driven through Tier B, which is the only tier this harness can carry from
 * upload to finished: it runs in-process off the completion route's `after()`,
 * so no worker has to exist. The trial tier would queue for a GPU nothing here
 * runs, and an exhausted trial completes synchronously inside the request,
 * where there is no job to finish and so nothing to announce.
 *
 * The e2e server has no VAPID keys, so push is off here by construction. That
 * is the point of what this asserts: the in-app half is what works with no
 * setup at all, and it is what a student who declines push, or whose browser
 * cannot do it, is left with.
 */
test('a finished worksheet turns up in the bell', async ({ page }) => {
  await registerAndSignIn(page)

  await page.goto('/dashboard')
  const bell = page.getByRole('button', { name: /Notifications/ })
  await expect(bell).toBeVisible()

  await bell.click()
  await expect(page.getByText(/Nothing yet/)).toBeVisible()
  await page.keyboard.press('Escape')

  // A cloud key routes the upload to Tier B, which the mock provider answers.
  await page.goto('/settings')
  await visible(page)
    .getByRole('textbox', { name: 'API key' })
    .fill('sk-ant-e2e-notification-check')
  await visible(page).getByRole('button', { name: 'Save key' }).click()
  await expect(visible(page).getByText(/key ending/)).toBeVisible()

  await uploadWorksheet(page, 'Notified Set')

  // The drain runs in `after()`, so this polls rather than assuming it has
  // landed by the time the response came back.
  await expect(async () => {
    await page.goto('/dashboard')
    await expect(page.getByRole('button', { name: /unread/ })).toBeVisible({
      timeout: 3_000,
    })
  }).toPass({ timeout: 90_000 })

  await page.getByRole('button', { name: /Notifications/ }).click()

  // The bell's own row, by its full accessible name. The worksheet title alone
  // now matches three elements: this, the recent-worksheets panel and the
  // library card behind it.
  await expect(
    page.getByRole('link', { name: /Notified Set.*ready to check/ }),
  ).toBeVisible()

  // Opening it is the student seeing them, so the badge clears and stays clear.
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByRole('button', { name: /unread/ })).toHaveCount(0)
})

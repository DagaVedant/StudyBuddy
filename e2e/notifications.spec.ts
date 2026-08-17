import { expect, test } from '@playwright/test'

import { registerAndSignIn, uploadWorksheet, visible } from './support/helpers'

test('a finished worksheet turns up in the bell', async ({ page }) => {
  await registerAndSignIn(page)

  await page.goto('/dashboard')
  const bell = page.getByRole('button', { name: /Notifications/ })
  await expect(bell).toBeVisible()

  await bell.click()
  await expect(page.getByText(/Nothing yet/)).toBeVisible()
  await page.keyboard.press('Escape')

  await page.goto('/settings')
  await visible(page)
    .getByRole('textbox', { name: 'API key' })
    .fill('sk-ant-e2e-notification-check')
  await visible(page).getByRole('button', { name: 'Save key' }).click()
  await expect(visible(page).getByText(/key ending/)).toBeVisible()

  await uploadWorksheet(page, 'Notified Set')

  await expect(async () => {
    await page.goto('/dashboard')
    await expect(page.getByRole('button', { name: /unread/ })).toBeVisible({
      timeout: 3_000,
    })
  }).toPass({ timeout: 90_000 })

  await page.getByRole('button', { name: /Notifications/ }).click()

  await expect(
    page.getByRole('link', { name: /Notified Set.*ready to check/ }),
  ).toBeVisible()

  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByRole('button', { name: /unread/ })).toHaveCount(0)
})

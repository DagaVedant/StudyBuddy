import { expect, test } from '@playwright/test'

import { closeDbClient, registerAndSignIn } from './support/helpers'

test.afterAll(async () => {
  await closeDbClient()
})

test('the toggle switches theme, persists it, and survives reload', async ({ page }) => {
  await registerAndSignIn(page)

  const toggle = page.getByRole('switch', { name: 'Dark mode' })
  await expect(toggle).toBeVisible()

  const before = await toggle.getAttribute('aria-checked')
  await toggle.click()

  const after = await toggle.getAttribute('aria-checked')
  expect(after).not.toBe(before)

  const applied = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  )
  expect(applied).toBe(after === 'true' ? 'dark' : 'light')

  await page.reload()
  await expect(page.getByRole('switch', { name: 'Dark mode' })).toHaveAttribute(
    'aria-checked',
    after!,
  )
})

test('the stored theme is applied before first paint', async ({ page }) => {
  await registerAndSignIn(page)

  await page.getByRole('switch', { name: 'Dark mode' }).click()
  const chosen = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  )

  await page.goto('/dashboard')
  const atLoad = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  )

  expect(atLoad).toBe(chosen)
})

test('an explicit choice overrides the OS preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await registerAndSignIn(page)

  const toggle = page.getByRole('switch', { name: 'Dark mode' })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await page.reload()
  await expect(page.getByRole('switch', { name: 'Dark mode' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
})

test('the skip link is reachable by keyboard', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/dashboard')

  await page.keyboard.press('Tab')

  const focused = await page.evaluate(() => document.activeElement?.textContent)
  expect(focused).toContain('Skip to content')
})

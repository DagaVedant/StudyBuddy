import { expect, test } from '@playwright/test'

import { registerAndSignIn, visible } from './support/helpers'

test('saves a name and username, and shows them after a reload', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/profile')

  await visible(page).getByLabel('Name', { exact: true }).fill('Ada Lovelace')
  await visible(page).getByLabel('Username').fill('ada_l')
  await visible(page).getByRole('button', { name: 'Save' }).click()

  await expect(visible(page).getByText('Saved.')).toBeVisible()

  await page.reload()

  await expect(visible(page).getByLabel('Name', { exact: true })).toHaveValue('Ada Lovelace')
  await expect(visible(page).getByLabel('Username')).toHaveValue('ada_l')
  await expect(visible(page).getByText('AL', { exact: true })).toBeVisible()
})

test('rejects a malformed username without touching the stored one', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/profile')

  await visible(page).getByLabel('Username').fill('good_name')
  await visible(page).getByRole('button', { name: 'Save' }).click()
  await expect(visible(page).getByText('Saved.')).toBeVisible()

  await visible(page).getByLabel('Username').fill('not a valid username')
  await visible(page).getByRole('button', { name: 'Save' }).click()

  await expect(
    visible(page).getByText('Letters, numbers and underscores only, starting with a letter.'),
  ).toBeVisible()

  await page.reload()
  await expect(visible(page).getByLabel('Username')).toHaveValue('good_name')
})

test('two accounts cannot hold the same username', async ({ page, browser }) => {
  await registerAndSignIn(page)
  await page.goto('/profile')
  await visible(page).getByLabel('Username').fill('firstclaim')
  await visible(page).getByRole('button', { name: 'Save' }).click()
  await expect(visible(page).getByText('Saved.')).toBeVisible()

  const second = await browser.newContext()
  const secondPage = await second.newPage()
  await registerAndSignIn(secondPage)
  await secondPage.goto('/profile')

  await visible(secondPage).getByLabel('Username').fill('firstclaim')
  await visible(secondPage).getByRole('button', { name: 'Save' }).click()

  await expect(visible(secondPage).getByText('That username is taken.')).toBeVisible()

  await second.close()
})

test('the record panel shows worksheets, streak and accuracy', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/profile')

  await expect(visible(page).getByRole('heading', { name: 'Your record' })).toBeVisible()
  await expect(visible(page).getByText('Worksheets')).toBeVisible()
  await expect(visible(page).getByText('Study streak')).toBeVisible()
  await expect(visible(page).getByText('0/5 answered')).toBeVisible()
  await expect(visible(page).getByText('—')).toBeVisible()
})

test('sign out and the delete-account link both reach the right place', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/profile')

  await visible(page).getByRole('link', { name: 'Delete account' }).click()
  await expect(page).toHaveURL(/\/settings$/)

  await page.goto('/profile')
  await visible(page)
    .getByRole('region', { name: 'Account' })
    .getByRole('button', { name: 'Sign out' })
    .click()
  await page.waitForURL('**/signin')
})

test('profile is reachable from settings rather than the nav', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/dashboard')

  await expect(page.getByRole('link', { name: 'Profile', exact: true })).toHaveCount(0)

  await page.goto('/settings')
  await visible(page).getByRole('link', { name: 'Open your profile' }).click()

  await expect(page).toHaveURL(/\/profile/)
})

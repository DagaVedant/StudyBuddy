import { expect, test, type Locator, type Page } from '@playwright/test'

import { signInAsAdmin, visible } from './support/helpers'

async function fillAndClose(input: Locator, value: string) {
  await input.fill(value)
  await input.press('Escape')
}

async function submit(
  page: Page,
  section: Locator,
  buttonName: string,
  timeout?: number,
): Promise<void> {
  const response = page.waitForResponse(
    (res) => res.url().endsWith('/admin/tree') && res.request().method() === 'POST',
    { timeout },
  )
  await section.getByRole('button', { name: buttonName }).click()
  expect((await response).ok()).toBe(true)

  await page.goto('/admin/tree')
}

const ADMIN_EMAIL = 'admin@studybuddy.test'
const OTHER_ADMIN_EMAIL = 'boss@studybuddy.test'

test('every admin page renders for an admin', async ({ browser }) => {
  const page = await browser.newPage()
  try {
    await signInAsAdmin(page, ADMIN_EMAIL)

    await page.goto('/admin/topics')
    await expect(visible(page).getByRole('heading', { name: 'Admin' })).toBeVisible()
    await expect(
      visible(page).getByRole('heading', { name: 'Workers & queue' }),
    ).toBeVisible()

    await page.goto('/admin/tree')
    await expect(
      visible(page).getByRole('heading', { name: 'Canonical tree' }),
    ).toBeVisible()
    await expect(visible(page).getByRole('heading', { name: 'Add a topic' })).toBeVisible()
    await expect(
      visible(page).getByRole('heading', { name: 'Rename a topic' }),
    ).toBeVisible()
    await expect(visible(page).getByRole('heading', { name: 'Move a leaf' })).toBeVisible()

    await page.goto('/admin/queue')
    await expect(visible(page).getByRole('heading', { name: 'Queue' })).toBeVisible()
    await expect(visible(page).getByText('Nothing needs attention.')).toBeVisible()

    await page.goto('/admin/usage')
    await expect(visible(page).getByRole('heading', { name: 'Usage' })).toBeVisible()
    await expect(
      visible(page).getByRole('heading', { name: 'Trial quota, most used first' }),
    ).toBeVisible()

    await page.goto('/admin/reports')
    await expect(visible(page).getByRole('heading', { name: 'Reports' })).toBeVisible()
  } finally {
    await page.close()
  }
})

test('admin can add, rename, and move a topic in the canonical tree', async ({ browser }) => {
  const page = await browser.newPage()
  try {
    await signInAsAdmin(page, OTHER_ADMIN_EMAIL)
    await page.goto('/admin/tree')

    const options = visible(page).locator('#all-topics option')
    const originalParent = await options.nth(0).getAttribute('value')
    const otherParent = await options.nth(1).getAttribute('value')
    if (!originalParent || !otherParent) throw new Error('expected a seeded taxonomy')

    const addSection = visible(page).locator('section:has(#add-heading)')
    const renameSection = visible(page).locator('section:has(#rename-heading)')
    const moveSection = visible(page).locator('section:has(#reparent-heading)')

    const name = `E2E Topic ${Date.now()}`
    await fillAndClose(addSection.locator('input[name="parentSlug"]'), originalParent)
    await fillAndClose(addSection.locator('input[name="name"]'), name)
    await submit(page, addSection, 'Add', 90_000)

    const created = visible(page).locator('#all-topics option', { hasText: name })
    await expect(created).toHaveCount(1)
    const slug = await created.getAttribute('value')
    if (!slug) throw new Error('created topic carried no slug')
    expect(slug.startsWith(`${originalParent}.`)).toBe(true)

    const renamed = `${name} Renamed`
    await fillAndClose(renameSection.locator('input[name="targetSlug"]'), slug)
    await fillAndClose(renameSection.locator('input[name="name"]'), renamed)
    await submit(page, renameSection, 'Rename')

    await expect(visible(page).locator(`#all-topics option[value="${slug}"]`)).toHaveText(
      renamed,
    )

    await fillAndClose(moveSection.locator('input[name="targetSlug"]'), slug)
    await fillAndClose(moveSection.locator('input[name="parentSlug"]'), otherParent)
    await submit(page, moveSection, 'Move')

    await expect(
      visible(page).locator(`#all-topics option[value="${slug}"]`),
    ).toHaveCount(0)
    const moved = visible(page).locator(`#all-topics option[value^="${otherParent}."]`, {
      hasText: renamed,
    })
    await expect(moved).toHaveCount(1)
  } finally {
    await page.close()
  }
})

import { expect, test, type Page } from '@playwright/test'

import { createWorksheet, registerAndSignIn, visible } from './support/helpers'

async function seedWorksheet(page: Page, count: number): Promise<string> {
  const id = await createWorksheet(page, 'Bulk Accept Fixture')

  for (let i = 0; i < count; i += 1) {
    const made = await page.request.post(`/api/worksheets/${id}/questions`, {
      data: {
        ordinal: i + 1,
        promptText: `Question ${i + 1}`,
        questionType: 'free_response',
      },
    })
    const { questionId } = (await made.json()) as { questionId: string }

    await page.request.patch(`/api/questions/${questionId}`, {
      data: { userVerified: false },
    })
  }

  return id
}

test('accepting the remaining questions asks first, and can be undone', async ({ page }) => {
  await registerAndSignIn(page)
  const id = await seedWorksheet(page, 3)

  await page.goto(`/worksheets/${id}/check`)
  await expect(visible(page).getByRole('heading', { name: 'Check Your Questions' })).toBeVisible()

  const acceptLink = visible(page).getByRole('button', {
    name: /Accept the remaining \d+ as they are/,
  })
  await expect(acceptLink).toBeVisible()
  await acceptLink.click()

  await expect(visible(page).getByText(/Accept all \d+ without checking each one\?/)).toBeVisible()
  await visible(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(acceptLink).toBeVisible()

  await acceptLink.click()
  await visible(page)
    .getByRole('button', { name: /Yes, accept \d+/ })
    .click()

  await expect(visible(page).getByText(/\d+ questions? accepted\./)).toBeVisible()
  await expect(visible(page).getByRole('heading', { name: 'Check Your Questions' })).toBeVisible()
  await expect(visible(page).getByText(/All \d+ questions? checked/)).toBeVisible()

  await visible(page).getByRole('button', { name: 'Undo' }).click()

  await expect(acceptLink).toBeVisible()
  await expect(visible(page).getByText(/0 of \d+ checked/)).toBeVisible()
})

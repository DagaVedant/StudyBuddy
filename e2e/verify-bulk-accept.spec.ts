import { expect, test, type Page } from '@playwright/test'

import { registerAndSignIn, visible } from './support/helpers'

/**
 * Accepting every remaining question at once: the confirm step and the undo
 * that follows it. Self-contained rather than appended to journey.spec.ts's
 * shared serial suite, since this needs several unverified questions and that
 * suite's fixture carries exactly one, hand-drawn.
 *
 * Built from the create-worksheet and create-question routes directly rather
 * than a PDF upload, because a real upload's extraction runs on the trial
 * tier's queue (`executor: 'operator_gpu'`), which nothing in this harness
 * ever claims: the worksheet would sit in `processing` forever with no
 * questions on it at all, which is the failure this fixture avoids by not
 * depending on extraction to produce anything.
 */

async function seedWorksheet(page: Page, count: number): Promise<string> {
  const created = await page.request.post('/api/worksheets', {
    data: {
      title: 'Bulk Accept Fixture',
      sourceType: 'pdf_digital',
      pageCount: 1,
    },
  })
  const { worksheetId: id } = (await created.json()) as { worksheetId: string }

  for (let i = 0; i < count; i += 1) {
    const made = await page.request.post(`/api/worksheets/${id}/questions`, {
      data: {
        ordinal: i + 1,
        promptText: `Question ${i + 1}`,
        questionType: 'free_response',
      },
    })
    const { questionId } = (await made.json()) as { questionId: string }

    // Manual creation marks a question verified, since a student who boxed
    // it themselves has already checked it. That is the wrong starting state
    // for a screen whose whole job is checking questions nobody has yet.
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

  // The confirm step, not an immediate write. Cancelling it leaves every
  // question exactly as unverified as before.
  await expect(visible(page).getByText(/Accept all \d+ without checking each one\?/)).toBeVisible()
  await visible(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(acceptLink).toBeVisible()

  await acceptLink.click()
  await visible(page)
    .getByRole('button', { name: /Yes, accept \d+/ })
    .click()

  // Every question checked, and the undo offer up.
  await expect(visible(page).getByText(/\d+ questions? accepted\./)).toBeVisible()
  await expect(visible(page).getByRole('heading', { name: 'Check Your Questions' })).toBeVisible()
  await expect(visible(page).getByText(/All \d+ questions? checked/)).toBeVisible()

  await visible(page).getByRole('button', { name: 'Undo' }).click()

  // Back to needing a check, for the same count that was just accepted.
  await expect(acceptLink).toBeVisible()
  await expect(visible(page).getByText(/0 of \d+ checked/)).toBeVisible()
})

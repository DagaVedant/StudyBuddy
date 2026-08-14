import { expect, test, type Locator, type Page } from '@playwright/test'

import { signInAsAdmin, visible } from './support/helpers'

/**
 * `.fill()` on an `<input list="…">` can leave the browser's native datalist
 * suggestion popup open. It is outside the DOM and, intermittently, swallows
 * the very next click - the submit button click lands on the popup instead
 * of the button, and no request is ever sent. Escape closes it.
 */
async function fillAndClose(input: Locator, value: string) {
  await input.fill(value)
  await input.press('Escape')
}

/**
 * Clicks a form's submit button and waits for the server action's own POST
 * to come back, rather than polling the DOM for however long the datalist
 * popup above happens to have swallowed the click for. A submit that never
 * reaches the server fails here, clearly, instead of the DOM assertion below
 * it timing out with nothing to say why.
 */
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

  // The POST resolving only means the write landed; whether the in-place RSC
  // patch has actually reached the DOM yet is a second, separate race this
  // suite's own streaming (every route has a loading.tsx, see support/helpers.ts's
  // `visible()`) makes intermittent. A fresh navigation re-renders from
  // scratch server-side, so what this reads next is never mid-patch.
  await page.goto('/admin/tree')
}

/**
 * Finding 118. spec.md §2.1 lists five admin capabilities; before this,
 * app/(app)/admin/ had reports and the proposal queue's accept/reject and
 * nothing else. Covers the two new pages end to end (tree editing, since it
 * is the one with real multi-step state to get wrong) and smoke-checks the
 * rest, since queue and merge both need a fixture (a stuck job, a topic
 * proposal) that nothing in the e2e harness can seed without opening a
 * second connection PGlite's single-socket server does not allow - see
 * e2e/support/database.ts. Those two are covered at the integration level
 * instead (tests/integration/queue.test.ts, tests/integration/proposals.test.ts).
 */

/** Matches ADMIN_EMAILS in playwright.config.ts. */
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

    // Two distinct seeded topics to move between, read before anything is
    // created so neither can be the topic this test is about to add.
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
    // 90s rather than the default: the embedding model loads cold on the
    // server's first call in this run, which is well past Playwright's usual
    // wait on some hosts (see tests/integration/classify-worksheet.test.ts's
    // own extended timeouts for the same reason).
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

    // Same slug, new name: rename never touches the slug.
    await expect(visible(page).locator(`#all-topics option[value="${slug}"]`)).toHaveText(
      renamed,
    )

    await fillAndClose(moveSection.locator('input[name="targetSlug"]'), slug)
    await fillAndClose(moveSection.locator('input[name="parentSlug"]'), otherParent)
    await submit(page, moveSection, 'Move')

    // The old slug is gone; a new one under the new parent has the renamed topic.
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

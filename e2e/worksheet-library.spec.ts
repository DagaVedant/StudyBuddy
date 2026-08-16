import { expect, test, type Page } from '@playwright/test'

import { registerAndSignIn, uploadWorksheet, visible } from './support/helpers'

/**
 * The library screen, which was a list of the fifty newest worksheets and
 * nothing else. No paging, no search, no filter and no rename: the fifty-first
 * worksheet was gone from the interface, its row still counting towards the
 * dashboard, and the only handle on any of them was a title set once at upload
 * from the filename.
 */

/**
 * A worksheet's card, found by its title link.
 *
 * By role rather than by text, because the delete confirmation renders the same
 * title into a closed `<dialog>` that is still in the DOM: a plain text match
 * finds both and fails strict mode. The link is also the element that carries
 * the renamed title first, since the rename reads from local state rather than
 * waiting on the refresh.
 */
const card = (page: Page, title: string) =>
  visible(page).getByRole('link', { name: title, exact: true })

async function createWorksheet(page: Page, title: string): Promise<string> {
  const response = await page.request.post('/api/worksheets', {
    data: { title, sourceType: 'pdf_digital', pageCount: 1 },
  })

  if (!response.ok()) {
    throw new Error(`Could not create ${title}: ${await response.text()}`)
  }

  const { worksheetId } = (await response.json()) as { worksheetId: string }
  return worksheetId
}

test('a title search finds one worksheet and hides the others', async ({ page }) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'Trigonometry Unit 7')
  await createWorksheet(page, 'Quadratics Practice')

  await page.goto('/worksheets')
  await expect(card(page, 'Trigonometry Unit 7')).toBeVisible()
  await expect(card(page, 'Quadratics Practice')).toBeVisible()

  await visible(page).getByRole('searchbox').fill('quadratic')
  await visible(page).getByRole('button', { name: 'Search' }).click()

  await expect(card(page, 'Quadratics Practice')).toBeVisible()
  await expect(card(page, 'Trigonometry Unit 7')).toHaveCount(0)

  // A search that matches nothing says so, and offers the way back rather than
  // claiming nothing was ever uploaded.
  await visible(page).getByRole('searchbox').fill('nothing called this')
  await visible(page).getByRole('button', { name: 'Search' }).click()
  await expect(visible(page).getByText(/Nothing matches/)).toBeVisible()

  await visible(page).getByRole('link', { name: 'Show all worksheets' }).click()
  await expect(card(page, 'Trigonometry Unit 7')).toBeVisible()
})

/**
 * The cursor, driven directly rather than by uploading fifty-one worksheets.
 * `?before=` is a position in the `createdAt` ordering, so a timestamp between
 * the two rows shows exactly the older one.
 */
test('the cursor shows what is older than it', async ({ page }) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'Older Paper')
  // Distinct timestamps, since the cursor is strictly less-than.
  await page.waitForTimeout(1_100)
  await createWorksheet(page, 'Newer Paper')

  await page.goto('/worksheets')
  await expect(card(page, 'Newer Paper')).toBeVisible()

  const between = new Date(Date.now() - 500).toISOString()
  await page.goto(`/worksheets?before=${encodeURIComponent(between)}`)

  await expect(card(page, 'Older Paper')).toBeVisible()
  await expect(card(page, 'Newer Paper')).toHaveCount(0)
  await expect(
    visible(page).getByRole('link', { name: 'Back to the newest' }),
  ).toBeVisible()
})

test('a cursor past the end says so instead of claiming nothing was uploaded', async ({
  page,
}) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'Only Paper')

  await page.goto('/worksheets?before=2000-01-01T00:00:00.000Z')

  await expect(visible(page).getByText('Nothing older to show')).toBeVisible()
  await expect(visible(page).getByText('Nothing uploaded yet')).toHaveCount(0)
})

/**
 * An unparseable cursor is a hand-edited URL or a link that has gone stale, and
 * the newest page is a better answer to both than an error.
 */
test('a nonsense cursor falls back to the newest', async ({ page }) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'Only Paper')

  await page.goto('/worksheets?before=not-a-date')

  await expect(card(page, 'Only Paper')).toBeVisible()
})

test('a worksheet can be renamed off the filename it arrived with', async ({ page }) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'scan_002')

  await page.goto('/worksheets')
  await visible(page).getByRole('button', { name: 'Rename scan_002' }).click()

  const field = visible(page).getByLabel('Worksheet title')
  await field.fill('Chapter 5 Review')
  await visible(page).getByRole('button', { name: 'Save' }).click()

  await expect(card(page, 'Chapter 5 Review')).toBeVisible()
  await expect(card(page, 'scan_002')).toHaveCount(0)

  // Written, not just shown. The rename reads from local state so it does not
  // wait on the refresh, which is exactly why this reloads to check.
  await page.reload()
  await expect(card(page, 'Chapter 5 Review')).toBeVisible()
})

test('cancelling a rename leaves the title alone', async ({ page }) => {
  await registerAndSignIn(page)
  await createWorksheet(page, 'Keep This Name')

  await page.goto('/worksheets')
  await visible(page).getByRole('button', { name: 'Rename Keep This Name' }).click()

  await visible(page).getByLabel('Worksheet title').fill('Discarded')
  await visible(page).getByRole('button', { name: 'Cancel' }).click()

  await expect(card(page, 'Keep This Name')).toBeVisible()
  await expect(card(page, 'Discarded')).toHaveCount(0)
})

/**
 * §3.2. There are 341 topics and a student could reach one in exactly two ways:
 * by being ranked weak at it on the dashboard, or by following a link from a
 * question. No index, no browse, no search. That also left the lesson feature
 * mostly unreachable, since it lives on a topic page.
 */
test('every topic can be browsed, including the ones never started', async ({ page }) => {
  await registerAndSignIn(page)

  // From the nav, which is the slot Profile used to hold. Unscoped, because
  // `visible()` scopes to #main and the nav lives in the banner.
  await page.goto('/dashboard')
  await page.getByRole('link', { name: 'Topics', exact: true }).click()

  await expect(visible(page).getByRole('heading', { name: 'Topics' })).toBeVisible()

  // Subjects open on arrival, their children folded away.
  const geometry = visible(page).getByText('Geometry', { exact: true }).first()
  await expect(geometry).toBeVisible()

  // A topic with nothing recorded reads as neutral rather than as zero percent,
  // which would be a score the student never earned.
  await expect(visible(page).getByText('Not started').first()).toBeVisible()
})

test('profile is reachable from settings rather than the nav', async ({ page }) => {
  await registerAndSignIn(page)
  await page.goto('/dashboard')

  // The slot it used to occupy on a 375px strip. Unscoped for the same reason:
  // this is asserting the absence of a nav item, and the nav is not in #main.
  await expect(page.getByRole('link', { name: 'Profile', exact: true })).toHaveCount(0)

  await page.goto('/settings')
  await visible(page).getByRole('link', { name: 'Open your profile' }).click()

  await expect(page).toHaveURL(/\/profile/)
})

/**
 * §2.4. Three screens shared two words: `/worksheets/[id]/review` and
 * `/worksheets/[id]/verify` were both about the extraction, while `/review` is
 * the practice queue the nav teaches. So the nav said Review, the worksheet card
 * said "Check questions", and an upload landed on a URL ending /review that was
 * not the Review in the nav.
 *
 * The old paths still have to work. A bookmark, a back button or a tab left open
 * since before the deploy names one of them, and the alternative to a redirect
 * is a 404 on the student's own worksheet.
 */
test('the old extraction URLs still reach their screens', async ({ page }) => {
  await registerAndSignIn(page)
  const id = await createWorksheet(page, 'Renamed Routes')

  await page.goto(`/worksheets/${id}/review`)
  await expect(page).toHaveURL(new RegExp(`/worksheets/${id}/edit`))

  await page.goto(`/worksheets/${id}/verify`)
  await expect(page).toHaveURL(new RegExp(`/worksheets/${id}/check`))
})

test('the practice queue keeps the word review to itself', async ({ page }) => {
  await registerAndSignIn(page)

  // The redirect is scoped under /worksheets/, so the top-level route this
  // rename exists to protect is untouched.
  await page.goto('/review')
  await expect(page).toHaveURL(/\/review$/)
  await expect(visible(page).getByRole('heading', { name: 'Review' })).toBeVisible()
})

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

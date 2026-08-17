import { expect, test, type Page } from '@playwright/test'

import { connectCloudKey, registerAndSignIn, visible } from './support/helpers'
import { resetDatabase } from './support/reset'

test.beforeAll(resetDatabase)

const TOPIC = 'sat-math.problem-solving-and-data-analysis.percentages'
const TOPIC_NAME = 'Percentages'

const WRITE = 'Write me practice questions'

async function topicId(page: Page, slug: string): Promise<string> {
  const response = await page.request.post('/api/test/topic-lesson', { data: { slug } })
  if (!response.ok()) throw new Error(`Could not reach ${slug} (${response.status()})`)

  const body = (await response.json()) as { topicId: string }
  return body.topicId
}

test('a topic offers practice, and says where the questions came from', async ({
  page,
}) => {
  await registerAndSignIn(page)

  await page.goto(`/topics/${await topicId(page, TOPIC)}`)

  await expect(
    visible(page).getByRole('heading', { name: 'Practice questions' }),
  ).toBeVisible()
  await expect(visible(page).getByText(/came off a paper you uploaded/)).toBeVisible()
  await expect(visible(page).getByRole('button', { name: WRITE })).toBeVisible()
})

test('a trial account is told what it needs rather than left waiting', async ({ page }) => {
  await registerAndSignIn(page)

  await page.goto(`/topics/${await topicId(page, TOPIC)}`)
  await visible(page).getByRole('button', { name: WRITE }).click()

  await expect(visible(page).getByText(/needs a connected AI provider/)).toBeVisible()
})

test('generated practice lands in the review queue and stays out of the library', async ({
  page,
}) => {
  await registerAndSignIn(page)
  await connectCloudKey(page)

  const id = await topicId(page, TOPIC)

  await page.goto(`/topics/${id}`)
  await visible(page).getByRole('button', { name: WRITE }).click()

  await expect(visible(page).getByText(/4 new questions added/)).toBeVisible()

  await page.reload()
  await expect(visible(page).getByText(/4 written for you so far/)).toBeVisible()
  await expect(visible(page).getByText(/kept out of your accuracy/)).toBeVisible()

  await page.goto(`/review?topic=${id}`)

  await expect(
    visible(page).getByRole('heading', { name: `Review: ${TOPIC_NAME}` }),
  ).toBeVisible()
  await expect(visible(page).getByText(/4 questions are due/)).toBeVisible()

  await visible(page).getByRole('button', { name: 'Show answer' }).click()
  await expect(visible(page).getByText(/AI-derived, not from an answer key/)).toBeVisible()

  await visible(page).getByRole('button', { name: 'Good' }).click()

  await page.goto('/worksheets')
  await expect(
    visible(page).getByText('Nothing uploaded yet. Your worksheets will appear here once you add one.'),
  ).toBeVisible()
})

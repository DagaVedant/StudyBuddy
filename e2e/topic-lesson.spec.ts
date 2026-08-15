import { expect, test, type Page } from '@playwright/test'

import { registerAndSignIn, visible } from './support/helpers'

/**
 * The topic page, with and without a lesson on it.
 *
 * This page is the only place on the site that shows a reader prose a model
 * wrote. A topic with no lesson yet shows a "Generate lesson overview"
 * button instead of the lesson content, rather than the section vanishing
 * outright, so there is always something inviting the student to ask for
 * one. One test proves the lesson reaches the reader, the other pins down
 * what a topic without one is supposed to look like.
 */

const TAUGHT = 'sat-math.algebra.linear-equations-in-one-variable'
const TAUGHT_NAME = 'Linear equations in one variable'

const UNTAUGHT = 'sat-math.advanced-math.equivalent-expressions'
const UNTAUGHT_NAME = 'Equivalent expressions'

const LESSON = {
  bodyMd:
    'A linear equation says two expressions are equal, and solving it means ' +
    'getting the unknown by itself.\n\n' +
    '## The method\n\n' +
    'Undo what was done to the unknown, in reverse order, doing the same ' +
    'thing to both sides every time.',
  examples: [
    {
      question: 'Solve for x: 3x + 7 = 25',
      working: 'Subtract 7 from both sides: 3x = 18. Divide both sides by 3.',
      answer: 'x = 6',
    },
    {
      question: 'Solve for y: 2(y - 4) = 10',
      working: 'Divide both sides by 2: y - 4 = 5. Add 4 to both sides.',
      answer: 'y = 9',
    },
  ],
  commonErrors: [
    {
      mistake: 'Adding to one side only.',
      why: 'An equation is a balance, and changing one side alone tips it.',
      fix: 'Write the same operation under both sides before doing either.',
    },
  ],
  model: 'a-test-model',
}

/** The topic id for a slug, giving it a lesson on the way when one is passed. */
async function topicId(
  page: Page,
  slug: string,
  lesson?: typeof LESSON,
): Promise<string> {
  const response = await page.request.post('/api/test/topic-lesson', {
    data: lesson ? { slug, lesson } : { slug },
  })
  if (!response.ok()) throw new Error(`Could not reach ${slug} (${response.status()})`)

  const body = (await response.json()) as { topicId: string }
  return body.topicId
}

test('a topic with a lesson teaches the topic', async ({ page }) => {
  await registerAndSignIn(page)

  await page.goto(`/topics/${await topicId(page, TAUGHT, LESSON)}`)

  await expect(
    visible(page).getByRole('heading', { name: TAUGHT_NAME, level: 1 }),
  ).toBeVisible()

  // The walkthrough, including a heading that exists only inside the markdown
  // body, which is what says `Prose` rendered it rather than printing it.
  await expect(visible(page).getByText(/two expressions are equal/)).toBeVisible()
  await expect(visible(page).getByRole('heading', { name: 'The method' })).toBeVisible()

  // Both worked examples, each with its own answer.
  await expect(visible(page).getByText('Solve for x: 3x + 7 = 25')).toBeVisible()
  await expect(visible(page).getByText('x = 6')).toBeVisible()
  await expect(visible(page).getByText('Solve for y: 2(y - 4) = 10')).toBeVisible()
  await expect(visible(page).getByText('y = 9')).toBeVisible()

  await expect(
    visible(page).getByRole('heading', { name: 'Where people go wrong' }),
  ).toBeVisible()
  await expect(visible(page).getByText('Adding to one side only.')).toBeVisible()
  await expect(visible(page).getByText(/Write the same operation/)).toBeVisible()

  // The disclaimer is load-bearing rather than decoration. The lesson above it
  // is machine-written and the questions below it are the student's own work,
  // and this line is the only thing on the page that tells them apart.
  await expect(
    visible(page).getByText(/Written by a-test-model, not by a teacher/),
  ).toBeVisible()
})

test('a topic nobody has written a lesson for still renders', async ({ page }) => {
  await registerAndSignIn(page)

  // Resolved without seeding, so this really is a topic with no lesson: the
  // state every topic in the tree starts in and most will stay in.
  await page.goto(`/topics/${await topicId(page, UNTAUGHT)}`)

  await expect(
    visible(page).getByRole('heading', { name: UNTAUGHT_NAME, level: 1 }),
  ).toBeVisible()
  await expect(visible(page).getByRole('heading', { name: 'Accuracy' })).toBeVisible()

  // The teaching section is present but empty of any lesson content: an
  // invitation to generate one rather than a claim that a model wrote
  // something when none did.
  await expect(visible(page).getByRole('heading', { name: 'How this works' })).toBeVisible()
  await expect(
    visible(page).getByText('Nobody has written an explanation for this topic yet.'),
  ).toBeVisible()
  await expect(
    visible(page).getByRole('button', { name: 'Generate lesson overview' }),
  ).toBeVisible()
  await expect(visible(page).getByText(/not by a teacher/)).toHaveCount(0)
})

test('generating a lesson overview on demand writes and shows one', async ({ page }) => {
  await registerAndSignIn(page)

  // Same unseeded topic as above: nothing has written a lesson for it yet,
  // so the only way a lesson appears is the button actually doing its job.
  await page.goto(`/topics/${await topicId(page, UNTAUGHT)}`)

  await visible(page)
    .getByRole('button', { name: 'Generate lesson overview' })
    .click()

  // Mock AI answers fast, but this still crosses a real request and a real
  // `router.refresh()`, so the disclaimer line is the thing to wait on: it
  // only ever prints once a lesson row exists.
  await expect(visible(page).getByText(/not by a teacher/)).toBeVisible()
  await expect(
    visible(page).getByRole('button', { name: 'Generate lesson overview' }),
  ).toHaveCount(0)

  // Reloading proves the lesson was actually persisted, not just held in
  // client state from the POST response.
  await page.reload()
  await expect(visible(page).getByText(/not by a teacher/)).toBeVisible()
})

test('the accuracy panel and the revisit list stand alone', async ({ page }) => {
  await registerAndSignIn(page)

  await page.goto(`/topics/${await topicId(page, TAUGHT, LESSON)}`)

  await expect(visible(page).getByRole('heading', { name: 'Accuracy' })).toBeVisible()

  // A fresh account has answered nothing, so the page has to say so rather
  // than showing an empty meter above an empty list.
  await expect(visible(page).getByText(/Not enough answers here yet/)).toBeVisible()
  await expect(
    visible(page).getByText(/You have not missed a question in this topic/),
  ).toBeVisible()
})

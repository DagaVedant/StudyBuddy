import { describe, expect, it } from 'vitest'

import { trimLessonBody } from '@/lib/topics/lesson-body'

describe('trimLessonBody', () => {
  it('leaves a walkthrough that duplicates nothing alone', () => {
    const body = [
      'A composite figure is one you can cut into simpler shapes.',
      '',
      '## When you need it',
      '',
      'Any question about the area of a shape made of other shapes.',
      '',
      '## The method',
      '',
      '1. Cut it into pieces you know.',
      '2. Add the pieces up.',
    ].join('\n')

    expect(trimLessonBody(body)).toBe(body)
  })

  it('drops a worked examples section the page renders itself', () => {
    const body = [
      'The idea, in one line.',
      '',
      '## The method',
      '',
      'Do the thing.',
      '',
      '## Worked examples',
      '',
      '### Example 1',
      'Solve for x: 3x = 9. x = 3.',
    ].join('\n')

    expect(trimLessonBody(body)).toBe(
      ['The idea, in one line.', '', '## The method', '', 'Do the thing.'].join('\n'),
    )
  })

  /**
   * The spelling that got past the prompt. Forbidding "## Common errors" by
   * name produced this instead, with the same four mistakes in it.
   */
  it('drops a bold pitfalls list, not only a heading', () => {
    const body = [
      'The idea.',
      '',
      '**Common pitfalls to avoid**',
      '- Adding the hole instead of subtracting it.',
      '- Using diameter where radius is needed.',
    ].join('\n')

    expect(trimLessonBody(body)).toBe('The idea.')
  })

  it('resumes at the next section, so only the duplicate is lost', () => {
    const body = [
      'Opening.',
      '',
      '## Common errors',
      '',
      '- One.',
      '- Two.',
      '',
      '## Why it works',
      '',
      'Because areas add.',
    ].join('\n')

    expect(trimLessonBody(body)).toBe(
      ['Opening.', '', '## Why it works', '', 'Because areas add.'].join('\n'),
    )
  })

  it('takes a trailing line that belongs to the dropped section with it', () => {
    const body = [
      'Opening.',
      '',
      '## Common errors',
      '',
      '- One.',
      '',
      'These pitfalls often arise from misreading the question.',
    ].join('\n')

    expect(trimLessonBody(body)).toBe('Opening.')
  })

  it('removes the title the page already prints', () => {
    const body = ['# Composite figures', '', 'A composite figure is one you can cut up.'].join('\n')

    expect(trimLessonBody(body)).toBe('A composite figure is one you can cut up.')
  })

  /**
   * The rule is about collecting mistakes, not mentioning them. A method step
   * warning about a trap where the trap arises is the lesson doing its job.
   */
  it('keeps a trap named inside a step', () => {
    const body = [
      '## The method',
      '',
      '1. Halve the diameter first. Using the diameter here is the usual mistake.',
      '2. Square it.',
    ].join('\n')

    expect(trimLessonBody(body)).toBe(body)
  })

  it('is empty for an empty body', () => {
    expect(trimLessonBody('')).toBe('')
    expect(trimLessonBody('\n\n  \n')).toBe('')
  })
})

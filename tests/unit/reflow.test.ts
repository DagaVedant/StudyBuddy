import { describe, expect, it } from 'vitest'

import { reflowText } from '@/lib/questions/reflow'

describe('reflowText', () => {
  // The dice question shipped broken after `rolled`, because that is where the
  // printed column ran out.
  it('joins a stem the printed column wrapped', () => {
    expect(
      reflowText(
        'Aaliyah rolls two standard 6-sided dice. She notices that the product of the two numbers rolled\nis a multiple of 6. Which of the following integers cannot be the sum of the two numbers?',
      ),
    ).toBe(
      'Aaliyah rolls two standard 6-sided dice. She notices that the product of the two numbers rolled is a multiple of 6. Which of the following integers cannot be the sum of the two numbers?',
    )
  })

  it('keeps a roman numeral list one item per line', () => {
    expect(reflowText('Which are true?\nI. x > 0\nII. x is even\nIII. x < 10')).toBe(
      'Which are true?\nI. x > 0\nII. x is even\nIII. x < 10',
    )
  })

  it('keeps choices a lead-in carried into the prompt on their own lines', () => {
    expect(reflowText('The answer is one of\nA) 4\nB) 6\nC) 8')).toBe(
      'The answer is one of\nA) 4\nB) 6\nC) 8',
    )
  })

  it('keeps a blank line as a paragraph break', () => {
    expect(reflowText('Read the passage.\n\nThen answer the\nquestion below.')).toBe(
      'Read the passage.\n\nThen answer the question below.',
    )
  })

  it('rejoins a word the column split across the wrap', () => {
    expect(reflowText('How many num-\nbers are prime?')).toBe('How many numbers are prime?')
  })

  it('leaves a hyphen that belongs to the words alone', () => {
    expect(reflowText('She rolls two 6-sided dice\ntwice.')).toBe(
      'She rolls two 6-sided dice twice.',
    )
  })

  it('drops the padding a wrap left at the ends of lines', () => {
    expect(reflowText('  What is the ones digit of  \n  222,222 - 22,222?  ')).toBe(
      'What is the ones digit of 222,222 - 22,222?',
    )
  })

  it('is idempotent, so re-running it changes nothing', () => {
    const once = reflowText('Which are true?\nI. x > 0\nII. x is even')
    expect(reflowText(once)).toBe(once)
  })
})

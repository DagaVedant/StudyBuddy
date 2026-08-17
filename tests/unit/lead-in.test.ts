import { describe, expect, it } from 'vitest'

import { foldLeadInChoices } from '@/lib/questions/lead-in'

const COMBINE =
  'What is the best way to combine these sentences to clarify the relationship between ideas?'

const SENTENCES = [
  { label: '1', text: 'The International Space Station has been inhabited by crew members since 2000.' },
  { label: '2', text: 'Tourists will soon be allowed to pay for visits to the space station.' },
  { label: '3', text: 'Because the cost is $52-$58 million round trip, few people will be able to take advantage of the opportunity.' },
]

const OPTIONS = [
  { label: 'A', text: 'The International Space Station has been inhabited by crew members since 2000, but tourists will soon be allowed to pay for visits to the space station, and because the cost is $52-$58 million round trip, few people will be able to take advantage of the opportunity.' },
  { label: 'B', text: 'The International Space Station has been inhabited by crew members since 2000 and tourists will soon be allowed to pay for visits to the space station, though because the cost is $52-$58 million round trip, few people will be able to take advantage of the opportunity.' },
  { label: 'C', text: 'The International Space Station has been inhabited by crew members since 2000, but tourists will soon be allowed to pay for visits to the space station, so because the cost is $52-$58 million round trip, few people will be able to take advantage of the opportunity.' },
  { label: 'D', text: 'The International Space Station has been inhabited by crew members since 2000, and tourists will soon be allowed to pay for visits to the space station because the cost is $52-$58 million round trip, few people will be able to take advantage of the opportunity.' },
]

describe('foldLeadInChoices', () => {
  it('leaves the lettered options as the only answer list', () => {
    const folded = foldLeadInChoices({
      prompt_text: COMBINE,
      choices: [...SENTENCES, ...OPTIONS],
    })

    expect(folded.choices.map((choice) => choice.label)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('keeps the sentences by moving them into the stem', () => {
    const folded = foldLeadInChoices({
      prompt_text: COMBINE,
      choices: [...SENTENCES, ...OPTIONS],
    })

    expect(folded.prompt_text).toBe(
      [
        COMBINE,
        `1. ${SENTENCES[0].text}`,
        `2. ${SENTENCES[1].text}`,
        `3. ${SENTENCES[2].text}`,
      ].join('\n'),
    )
  })

  it('puts the sentences in printed order however they arrived', () => {
    const folded = foldLeadInChoices({
      prompt_text: COMBINE,
      choices: [SENTENCES[2], SENTENCES[0], ...OPTIONS, SENTENCES[1]],
    })

    expect(folded.prompt_text.split('\n').slice(1)).toEqual([
      `1. ${SENTENCES[0].text}`,
      `2. ${SENTENCES[1].text}`,
      `3. ${SENTENCES[2].text}`,
    ])
  })

  it('leaves a question whose options are genuinely numbered alone', () => {
    const question = {
      prompt_text: 'Which sentence contains an error in its construction and should be revised?',
      choices: [
        { label: '1', text: 'In 1976, the NBA absorbed four teams from the ABA.' },
        { label: '2', text: 'The owner of the Nets decided to take the team to New Jersey.' },
        { label: '3', text: 'The New Jersey Nets had sixteen playoff appearances.' },
        { label: '4', text: 'In 2012, the team changed ownership and returned to New York.' },
      ],
    }

    expect(foldLeadInChoices(question)).toEqual(question)
  })

  it('leaves an ordinary lettered question alone', () => {
    const question = { prompt_text: 'What is the value of x?', choices: OPTIONS }

    expect(foldLeadInChoices(question)).toEqual(question)
  })

  it('will not act on a single lettered choice', () => {
    const question = {
      prompt_text: 'Which sentence should be revised?',
      choices: [
        { label: '1', text: 'A sentence long enough to be compared properly.' },
        { label: 'A', text: 'Another sentence long enough to be compared properly.' },
      ],
    }

    expect(foldLeadInChoices(question)).toEqual(question)
  })

  it('does not repeat a sentence the stem already contains', () => {
    const folded = foldLeadInChoices({
      prompt_text: `${COMBINE}\n${SENTENCES[0].text}`,
      choices: [SENTENCES[0], ...OPTIONS],
    })

    expect(folded.prompt_text).toBe(`${COMBINE}\n${SENTENCES[0].text}`)
    expect(folded.choices).toEqual(OPTIONS)
  })

  it('drops a numbered line that came back empty rather than numbering nothing', () => {
    const folded = foldLeadInChoices({
      prompt_text: COMBINE,
      choices: [{ label: '1', text: '   ' }, ...OPTIONS],
    })

    expect(folded.prompt_text).toBe(COMBINE)
    expect(folded.choices).toEqual(OPTIONS)
  })
})

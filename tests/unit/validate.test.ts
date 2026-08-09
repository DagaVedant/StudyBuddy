import { describe, expect, it } from 'vitest'

import {
  isOptionRun,
  modalChoiceCount,
  validateQuestion,
  worthRereading,
  type ValidatableQuestion,
} from '@/lib/questions/validate'
import { planReview, type ReviewableQuestion } from '@/lib/worker/review'

function question(over: Partial<ValidatableQuestion> = {}): ValidatableQuestion {
  return {
    printedNumber: 1,
    promptText: 'Which sentence best states the central idea of the passage?',
    questionType: 'multiple_choice',
    choices: [
      { label: 'A', text: 'The narrator regrets leaving.' },
      { label: 'B', text: 'The narrator has never travelled.' },
      { label: 'C', text: 'The narrator prefers the city.' },
      { label: 'D', text: 'The narrator misses the sea.' },
    ],
    ...over,
  }
}

const codes = (q: ValidatableQuestion, expected: number | null = 4) =>
  validateQuestion(q, { expectedChoiceCount: expected }).map((f) => f.code)

/**
 * `topic_test13_20` stores twenty rows for a twenty-question paper with no gap
 * in the numbering, and row 17 is an orphaned option block. Every count-based
 * check passes and the real stem for 17 is gone.
 */
describe('isOptionRun', () => {
  it('recognises an option block stored as a question', () => {
    expect(
      isOptionRun('A. 1 hole   B. 4 holes   C. 2 holes same side   D. 2 holes opposite sides'),
    ).toBe(true)
  })

  it('recognises one printed a line at a time', () => {
    expect(isOptionRun('A. 12\nB. 314\nC. 25\nD. 79')).toBe(true)
  })

  it('reads the bracketed style too', () => {
    expect(isOptionRun('(A) 28 (B) 29 (C) 30 (D) 31 (E) 32')).toBe(true)
  })

  // Everything below is a question, and dropping one would be the failure this
  // whole document is about.

  it('leaves an ordinary question alone', () => {
    expect(isOptionRun('A rectangular garden measures 12 m by 8 m. What is its area?')).toBe(false)
  })

  it('leaves a stem that happens to open with a letter and a full stop', () => {
    expect(isOptionRun('A. Smith drove 40 miles in 50 minutes. What was the average speed?')).toBe(
      false,
    )
  })

  it('leaves a question that carries its own options after the stem', () => {
    expect(isOptionRun('What is 8 x 9 - 7 x 6?\nA. 43\nB. 45\nC. -45\nD. 44')).toBe(false)
  })

  it('needs three labels before it will call anything a list', () => {
    expect(isOptionRun('A. True   B. False')).toBe(false)
  })

  it('needs them in order', () => {
    expect(isOptionRun('A. 12   C. 25   B. 314')).toBe(false)
    expect(isOptionRun('A. 12   B. 314   D. 79')).toBe(false)
  })

  // Used to require the run to start at A. A page break that takes the stem
  // takes the options above it too, so what is left starts partway down the
  // list: re-reading topic_test8_15 stored "B. 18  C. 144  D. 81" as a second
  // question 14, beside the real one.
  it('catches a run whose first options went with the stem', () => {
    expect(isOptionRun('B. 18   C. 144   D. 81')).toBe(true)
    expect(isOptionRun('C. 25   D. 79   E. 81')).toBe(true)
  })

  // Single letters outside the range papers label options with. Roman numeral
  // lists are the reason this matters: "i." is a letter too.
  it('stays inside the A-E range options are labelled with', () => {
    expect(isOptionRun('i. one   j. two   k. three')).toBe(false)
    expect(isOptionRun('x. one   y. two   z. three')).toBe(false)
  })

  it('is not fooled by prose punctuated like a list', () => {
    const prose =
      `A. ${'word '.repeat(80)}\nB. ${'word '.repeat(80)}\nC. ${'word '.repeat(80)}`

    expect(isOptionRun(prose)).toBe(false)
  })

  it('says nothing about empty text', () => {
    expect(isOptionRun('')).toBe(false)
    expect(isOptionRun('   \n ')).toBe(false)
  })
})

describe('validateQuestion', () => {
  it('passes a well-formed question', () => {
    expect(codes(question())).toEqual([])
  })

  // The prose check above cannot see this one: four short answers are four
  // ordinary sentences as far as it is concerned.
  it('catches an option block stored as a question', () => {
    const stem = 'A. 1 hole   B. 4 holes   C. 2 holes same side   D. 2 holes opposite sides'

    expect(codes(question({ promptText: stem }))).toContain('stem_is_only_options')
    expect(codes(question({ promptText: stem }))).not.toContain('stem_is_not_a_question')
  })

  it('catches a stem with nothing in it', () => {
    expect(codes(question({ promptText: '  ?  ' }))).toContain('empty_stem')
  })

  it('catches multiple choice with no options at all', () => {
    expect(codes(question({ choices: [] }))).toContain('no_choices')
  })

  it('catches an option count below what the rest of the paper uses', () => {
    const two = question({ choices: question().choices.slice(0, 2) })
    expect(codes(two)).toContain('too_few_choices')
  })

  it('says nothing about the count when the paper has no settled one', () => {
    const two = question({ choices: question().choices.slice(0, 2) })
    expect(codes(two, null)).not.toContain('too_few_choices')
  })

  it('catches the same option text twice', () => {
    const repeated = question({
      choices: [
        { label: 'A', text: 'The narrator misses the sea.' },
        { label: 'B', text: 'The narrator misses the sea.' },
        { label: 'C', text: 'Something else entirely.' },
        { label: 'D', text: 'A fourth option.' },
      ],
    })
    expect(codes(repeated)).toContain('duplicate_choices')
  })

  it('catches a label used twice', () => {
    const repeated = question({
      choices: [
        { label: 'A', text: 'First option.' },
        { label: 'A', text: 'Second option.' },
        { label: 'C', text: 'Third option.' },
        { label: 'D', text: 'Fourth option.' },
      ],
    })
    expect(codes(repeated)).toContain('duplicate_labels')
  })

  // The shape the page-3 split produced: the stem swallowed the options and
  // then they were listed again underneath.
  it('notices an option repeated inside the stem', () => {
    const swallowed = question({
      promptText:
        'Which sentence best states the central idea? The narrator misses the sea. Or something else.',
    })
    expect(codes(swallowed)).toContain('choice_text_in_stem')
  })

  it('treats a stem finished by its options as fine, not truncated', () => {
    // Real SHSAT phrasing. Flagging these marked a fifth of a clean run.
    const opener = question({
      promptText:
        'The author’s use of the phrase “tall grasses” affects the tone of the excerpt by suggesting',
    })
    expect(codes(opener)).not.toContain('stem_looks_truncated')
  })

  it('flags a stem that stops on a comma', () => {
    const cut = question({
      promptText: 'According to the passage, the expedition failed because the crew,',
    })
    expect(codes(cut)).toContain('stem_looks_truncated')
  })

  it('flags a stem with a quote left open', () => {
    const cut = question({
      promptText: 'What does the author mean by “the weight of the afternoon',
    })
    expect(codes(cut)).toContain('stem_looks_truncated')
  })

  it('flags passage text captured as a question', () => {
    const passage = question({
      promptText: `${'The harbour was quiet that morning and the boats had not yet gone out. '.repeat(10)}`,
      choices: [],
      questionType: 'free_response',
    })
    expect(codes(passage)).toContain('stem_reads_like_passage')
  })

  it('does not ask for options on a question type that has none', () => {
    const grid = question({ questionType: 'grid_in', choices: [] })
    expect(codes(grid)).not.toContain('no_choices')
  })
})

describe('worthRereading', () => {
  it('acts on a single serious flag', () => {
    expect(worthRereading([{ code: 'empty_stem', detail: '', severity: 'high' }])).toBe(true)
  })

  it('ignores one weak flag on its own', () => {
    expect(
      worthRereading([{ code: 'stem_looks_truncated', detail: '', severity: 'low' }]),
    ).toBe(false)
  })

  it('acts once weak flags pile up', () => {
    expect(
      worthRereading([
        { code: 'stem_looks_truncated', detail: '', severity: 'low' },
        { code: 'choice_text_in_stem', detail: '', severity: 'low' },
      ]),
    ).toBe(true)
  })
})

describe('modalChoiceCount', () => {
  it('reports the count the paper settles on', () => {
    const four = Array.from({ length: 5 }, () => question())
    const odd = question({ choices: question().choices.slice(0, 3) })
    expect(modalChoiceCount([...four, odd])).toBe(4)
  })

  it('stays quiet when two counts are equally common', () => {
    const four = Array.from({ length: 3 }, () => question())
    const three = Array.from({ length: 3 }, () =>
      question({ choices: question().choices.slice(0, 3) }),
    )
    expect(modalChoiceCount([...four, ...three])).toBeNull()
  })

  it('stays quiet on too little evidence', () => {
    expect(modalChoiceCount([question()])).toBeNull()
  })
})

function reviewable(over: Partial<ReviewableQuestion>): ReviewableQuestion {
  return { id: 'q1', pageNumber: 1, ...question(), ...over }
}

describe('planReview', () => {
  it('sends a broken question back to its page', async () => {
    const plan = await planReview([
      reviewable({ id: 'a', printedNumber: 1 }),
      reviewable({ id: 'b', pageNumber: 2, printedNumber: 2, choices: [] }),
    ])

    expect(plan.suspects.map((s) => s.id)).toEqual(['b'])
    expect(plan.reread).toEqual([{ pageNumber: 2, expect: [2] }])
  })

  it('leaves a clean worksheet alone', async () => {
    const plan = await planReview([
      reviewable({ id: 'a', printedNumber: 1 }),
      reviewable({ id: 'b', printedNumber: 2 }),
    ])

    expect(plan.suspects).toEqual([])
    expect(plan.reread).toEqual([])
  })

  it('asks the model only about questions the cheap checks cleared', async () => {
    const asked: number[][] = []

    await planReview(
      [
        reviewable({ id: 'a', printedNumber: 1, choices: [] }),
        reviewable({ id: 'b', printedNumber: 2 }),
      ],
      async (candidates) => {
        asked.push(candidates.map((c) => c.number))
        return []
      },
    )

    expect(asked).toEqual([[2]])
  })

  it('takes the reviewer at its word when it calls a question damaged', async () => {
    const plan = await planReview(
      [reviewable({ id: 'a', pageNumber: 4, printedNumber: 7 })],
      async () => [{ number: 7, intact: false, reason: 'options answer a different question' }],
    )

    expect(plan.suspects[0].reasons).toEqual(['options answer a different question'])
    expect(plan.reread).toEqual([{ pageNumber: 4, expect: [7] }])
    expect(plan.modelConsulted).toBe(true)
  })

  it('keeps going when the reviewer throws', async () => {
    const plan = await planReview(
      [reviewable({ id: 'a', printedNumber: 1 })],
      async () => {
        throw new Error('ollama is down')
      },
    )

    expect(plan.suspects).toEqual([])
    expect(plan.modelConsulted).toBe(false)
  })

  it('caps how much of the worksheet can be re-read', async () => {
    // Ten pages, every question broken. Re-reading all ten would double the
    // job for an extraction that is wrong throughout anyway.
    const all = Array.from({ length: 10 }, (_, i) =>
      reviewable({ id: `q${i}`, pageNumber: i + 1, printedNumber: i + 1, choices: [] }),
    )

    const plan = await planReview(all)

    expect(plan.suspects).toHaveLength(10)
    expect(plan.reread).toHaveLength(3)
    expect(plan.skippedPages).toHaveLength(7)
  })

  it('spends the cap on the worst pages first', async () => {
    const questions: ReviewableQuestion[] = [
      reviewable({ id: 'a', pageNumber: 1, printedNumber: 1, choices: [] }),
      reviewable({ id: 'b', pageNumber: 2, printedNumber: 2, choices: [] }),
      reviewable({ id: 'c', pageNumber: 2, printedNumber: 3, choices: [] }),
      reviewable({ id: 'd', pageNumber: 3, printedNumber: 4 }),
    ]

    // Three pages at a third of them apiece leaves room for exactly one.
    const plan = await planReview(questions, undefined, { maxRereadShare: 0.33 })

    expect(plan.reread).toEqual([{ pageNumber: 2, expect: [2, 3] }])
    expect(plan.skippedPages).toEqual([1])
  })
})

describe('stem_is_not_a_question', () => {
  // Coordinate labels lifted off a diagram, filed as their own question.
  it('catches figure labels captured as a question', () => {
    expect(codes(question({ promptText: 'C(3,y)nA(5,7) B(11,7)' }))).toContain(
      'stem_is_not_a_question',
    )
  })

  it('catches page furniture', () => {
    expect(codes(question({ promptText: 'CONTINUE ON TO THE NEXT PAGE' }))).toContain(
      'stem_is_not_a_question',
    )
    expect(codes(question({ promptText: 'FORM B' }))).toContain('stem_is_not_a_question')
  })

  it('catches a stray option letter', () => {
    expect(codes(question({ promptText: '(C)' }))).toContain('stem_is_not_a_question')
  })

  // The reason the first version of this rule was wrong. These are real
  // questions on a real paper and carry almost no words at all.
  it('leaves a bare calculation alone', () => {
    for (const stem of [
      '3.6 ÷ 0.018 =',
      '3(0.01) − 3(0.1) =',
      '4 _ 2 ÷ 2 _ 1 =',
      'Evaluate: |(−8) − 12 + (−17) − (−31)| − |24|',
      'Simplify: 8x − (7 + 2.5x) + 2',
    ]) {
      expect(codes(question({ promptText: stem }))).not.toContain('stem_is_not_a_question')
    }
  })

  it('leaves an ordinary worded question alone', () => {
    expect(codes(question())).not.toContain('stem_is_not_a_question')
  })
})

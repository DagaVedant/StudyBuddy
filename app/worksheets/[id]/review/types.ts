import type { BBox, TextLine } from '@/lib/db/schema'

export interface EditablePage {
  id: string
  pageNumber: number
  imageSrc: string
  width: number
  height: number
  textLines: TextLine[]
}

export type QuestionType =
  | 'multiple_choice'
  | 'free_response'
  | 'true_false'
  | 'fill_blank'
  | 'grid_in'

export interface EditableQuestion {
  id: string
  pageId: string | null
  ordinal: number
  /** The number printed on the paper. Null when the sheet numbers nothing. */
  printedNumber: number | null
  promptText: string
  questionType: QuestionType
  bbox: BBox | null
  correctAnswer: string | null
  choices: { label: string; text: string; isCorrect: boolean }[]
  topicId: string | null
}

export const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: 'multiple_choice', label: 'Multiple Choice' },
  { value: 'free_response', label: 'Free Response' },
  { value: 'true_false', label: 'True or False' },
  { value: 'fill_blank', label: 'Fill in the Blank' },
  { value: 'grid_in', label: 'Grid-In' },
]

export const CHOICE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F']

/**
 * What to show beside a question.
 *
 * The number printed on the paper, so the label matches what the student is
 * looking at. Ordinal is a row counter and only ever coincided with the paper
 * by luck; it once put "138" beside question 25 of 114. It stays as the
 * fallback for worksheets that print no numbers at all, where a position is
 * better than nothing.
 */
export function questionLabel(question: EditableQuestion): number {
  return question.printedNumber ?? question.ordinal
}

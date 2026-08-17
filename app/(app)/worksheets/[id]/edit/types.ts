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
  printedNumber: number | null
  promptText: string
  questionType: QuestionType
  bbox: BBox | null
  correctAnswer: string | null
  choices: { id: string; label: string; text: string; isCorrect: boolean }[]
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

export function questionLabel(question: EditableQuestion): number {
  return question.printedNumber ?? question.ordinal
}

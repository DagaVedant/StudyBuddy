import Link from 'next/link'
import {Fragment, type ReactNode} from 'react'

import {MIN_ATTEMPTS} from '@/lib/upload'
import {type QuestionEvidence} from '@/lib/questions/shape'
import {type StudyDay} from '@/lib/dashboard'

import styles from './styles.module.css'
export function Mark({className}: {className?: string}) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="3.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.6 13.9C4.3 15.4 5.9 17.4 7.5 19.7 11.7 13.7 16.3 8.3 21.4 4.4" />
    </svg>
  )
}

export function MainRegion({
  children,
}: Readonly<{children: React.ReactNode}>) {
  return (
    <div id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
      {children}
    </div>
  )
}

export function PageHead({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string
  title: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="max-w-2xl">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="mt-1.5 text-balance font-display text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
          {title}
        </h1>
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  )
}
const PERCENT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})

type Band = 'critical' | 'serious' | 'warning' | 'good' | 'unknown'

function band(accuracy: number, ranked: boolean): Band {
  if (!ranked) return 'unknown'
  if (accuracy < 0.5) return 'critical'
  if (accuracy < 0.7) return 'serious'
  if (accuracy < 0.85) return 'warning'
  return 'good'
}

const FILL: Record<Band, string> = {
  critical: 'bg-danger',
  serious: 'bg-warning',
  warning: 'bg-caution',
  good: 'bg-success',
  unknown: 'bg-muted/40',
}

export function Meter({
  accuracy,
  ranked = true,
  label,
  thick = false,
}: {
  accuracy: number
  ranked?: boolean
  label: string
  thick?: boolean
}) {
  const pct = Math.round(accuracy * 100)

  const measured = ranked
    ? {
        role: 'meter' as const,
        'aria-valuenow': pct,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-label': `${label}: ${PERCENT.format(accuracy)} correct`,
      }
    : {'aria-hidden': true as const}

  return (
    <div
      {...measured}
      className={`w-full overflow-hidden bg-fg/15 ${thick ? 'h-3' : 'h-1.5'}`}
    >
      <div
        className={`h-full ${FILL[band(accuracy, ranked)]}`}
        style={{width: `${ranked ? Math.max(pct, 2) : 100}%`}}
      />
    </div>
  )
}

export function AccuracyLabel({
  accuracy,
  ranked,
  attempts,
}: {
  accuracy: number
  ranked: boolean
  attempts: number
}) {
  if (!ranked) {
    return (
      <span className="text-sm text-muted">
        {attempts}/{MIN_ATTEMPTS} answered
      </span>
    )
  }

  return <span className="text-sm font-medium tabular-nums">{PERCENT.format(accuracy)}</span>
}
function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      )
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

type Block =
  | {kind: 'heading'; level: 2 | 3; text: string}
  | {kind: 'paragraph'; text: string}
  | {kind: 'list'; ordered: boolean; items: string[]}

export function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: {ordered: boolean; items: string[]} | null = null

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({kind: 'paragraph', text: paragraph.join(' ')})
      paragraph = []
    }
    if (list) {
      blocks.push({kind: 'list', ...list})
      list = null
    }
  }

  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()

    if (!line) {
      flush()
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({kind: 'heading', level: heading[1].length <= 2 ? 2 : 3, text: heading[2]})
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line)

    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      const item = (bullet ?? numbered)![1]

      if (list && list.ordered !== ordered) flush()

      if (paragraph.length > 0) {
        blocks.push({kind: 'paragraph', text: paragraph.join(' ')})
        paragraph = []
      }

      list = list ?? {ordered, items: []}
      list.items.push(item)
      continue
    }

    if (list) flush()
    paragraph.push(line)
  }

  flush()
  return blocks
}

export function Prose({markdown}: {markdown: string}) {
  const blocks = blocksOf(markdown)

  return (
    <div className="space-y-3 text-sm">
      {blocks.map((block, index) => {
        const key = `b-${index}`

        if (block.kind === 'heading') {
          return block.level === 2 ? (
            <h3 key={key} className="mt-5 text-sm font-semibold tracking-tight">
              {inline(block.text, key)}
            </h3>
          ) : (
            <h4 key={key} className="mt-4 text-sm font-medium">
              {inline(block.text, key)}
            </h4>
          )
        }

        if (block.kind === 'list') {
          const items = block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`} className="text-pretty">
              {inline(item, `${key}-${itemIndex}`)}
            </li>
          ))

          return block.ordered ? (
            <ol key={key} className="ml-5 list-decimal space-y-1.5">
              {items}
            </ol>
          ) : (
            <ul key={key} className="ml-5 list-disc space-y-1.5">
              {items}
            </ul>
          )
        }

        return (
          <p key={key} className="text-pretty">
            {inline(block.text, key)}
          </p>
        )
      })}
    </div>
  )
}

export function Underline({className = ''}: {className?: string}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 300 14"
      preserveAspectRatio="none"
      fill="none"
      className={`pointer-events-none absolute left-0 top-[92%] h-[0.26em] w-full ${className}`}
    >
      <path
        d="M3 8.5C52 4.2 104 10.4 152 6.1 200 1.8 249 9.7 297 5"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Tick({className = ''}: {className?: string}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3.4 12.8C5.1 14.1 6.6 16 8.1 18.6 11.6 12.1 15.9 6.6 21 2.6" />
    </svg>
  )
}
const CROP_MARGIN = 0.04

export function QuestionCrop({
  image,
  alt,
}: {
  image: QuestionEvidence
  alt: string
}) {
  const [x0, y0, x1, y1] = image.bbox

  const padX = (x1 - x0) * CROP_MARGIN
  const padY = (y1 - y0) * CROP_MARGIN
  const left = Math.max(0, x0 - padX)
  const top = Math.max(0, y0 - padY)
  const cropWidth = Math.min(image.width, x1 + padX) - left
  const cropHeight = Math.min(image.height, y1 + padY) - top

  return (
    <div className="my-0.5 overflow-hidden rounded-lg [rotate:0.35deg]">
      <div className="relative" style={{aspectRatio: `${cropWidth} / ${cropHeight}`}}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.src}
          alt={alt}
          width={image.width}
          height={image.height}
          className="absolute max-w-none"
          style={{
            left: `${(-left / cropWidth) * 100}%`,
            top: `${(-top / cropHeight) * 100}%`,
            width: `${(image.width / cropWidth) * 100}%`,
            height: 'auto',
          }}
        />
      </div>
    </div>
  )
}
export function AiSetupPrompt() {
  return (
    <section
      aria-labelledby="ai-setup-prompt-heading"
      className="card my-8 p-4"
    >
      <h2 id="ai-setup-prompt-heading" className="text-sm font-medium">
        One trial worksheet left
      </h2>
      <p className="hint text-pretty">
        After that, StudyBuddy stops reading worksheets for you. Everything else
        keeps working: marking, review, explanations you have already generated,
        and your whole dashboard. Three ways forward.
      </p>

      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="font-medium">Your own API key</dt>
          <dd className="text-muted">
            Best extraction quality. You pay Anthropic or OpenAI directly, per
            worksheet, and nothing is capped.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Your own GPU</dt>
          <dd className="text-muted">
            Free and private if you already run Ollama. Reading happens in your
            browser, so the tab has to stay open while it works.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Stay free</dt>
          <dd className="text-muted">
            Do nothing. You type each worksheet&rsquo;s questions in yourself,
            and every other feature is unchanged.
          </dd>
        </div>
      </dl>

      <Link href="/settings" className="btn btn-primary mt-4 sm:w-auto sm:px-6">
        Choose how StudyBuddy thinks
      </Link>
    </section>
  )
}

export function Note({
  labelledBy,
  className = '',
  children,
}: {
  labelledBy?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={`border border-rule bg-surface p-5 ${className}`}
    >
      {children}
    </section>
  )
}

export function SectionHead({id, title}: {id: string; title: string}) {
  return (
    <div className="mb-4 border-b border-fg/20 pb-2">
      <h2
        id={id}
        className="font-display text-lg font-semibold tracking-tight sm:text-xl"
      >
        {title}
      </h2>
    </div>
  )
}

export function Callout({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Note>
      <p className="eyebrow">{label}</p>
      <div className="mt-2">{children}</div>
    </Note>
  )
}

export function MarginNote({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Note>
      <h2 className="eyebrow">{label}</h2>
      <div className="mt-2">{children}</div>
    </Note>
  )
}

export function PageFoot({running}: {running: string}) {
  return (
    <footer className="mt-14 border-t border-rule-heavy pt-3">
      <p className="eyebrow">{running}</p>
    </footer>
  )
}
export const TOPICS = [
  {name: 'Ratios and rates', count: 6}, {name: 'Linear equations', count: 5},
  {name: 'Inferences', count: 8}, {name: 'Words in context', count: 5},
] as const

const TOTAL = TOPICS.reduce((sum, topic) => sum + topic.count, 0)

const CURVE =
  'M6,24 C18,48 26,56 34,57 L34,36 C44,58 52,66 62,67 L62,42 C76,64 86,70 98,71 L98,50 C116,68 134,74 154,76'

const REVIEWS = [
  {left: '21.25%', top: '40%'}, {left: '38.75%', top: '46.7%'},
  {left: '61.25%', top: '55.6%'},
] as const

const QUESTIONS = [
  'A child grows 1 1/4 inches in 1/3 of a year. What would be his yearly growth rate in inches per year?',
  'If (3/5 − 1/2)x = 1/4 + 2/3, what is the value of x?',
  'The narrator’s actions in paragraph 5 reveal that he is',
  'In paragraph 3, the phrase “the butterflies of the sea” conveys the idea that',
] as const

export function Hero({children}: {children: React.ReactNode}) {
  return (
    <section className={styles.hero}>
      <Curve />

      <div className={styles.stack}>
        <Link href="/" className={styles.brand}>
          <Mark className={styles.mark} />
          StudyBuddy
        </Link>

        <h1 className={styles.blurb}>
          Turn the worksheets you have already done into a record of what you
          actually know.
        </h1>

        <div className={styles.panel}>
          <div>
            <p className={styles.count}>{TOTAL} questions</p>
            <p className="hint mt-1">
              found in one worksheet, pulled out, tagged and ready to mark
            </p>

            <ul className={styles.topics}>
              {TOPICS.map((topic) => (
                <li key={topic.name} className={styles.topic}>
                  {topic.name} <b>{topic.count}</b>
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.sheet} aria-hidden="true">
            {QUESTIONS.map((stem) => (
              <div key={stem} className={styles.q}>
                <p className={styles.stem}>{stem}</p>
                <span className={styles.qbox} />
              </div>
            ))}
          </div>
        </div>

        {children}

        <p className={`${styles.caption} text-sm text-pretty text-muted`}>
          Then the ones you missed are waiting in review, spaced to the day you
          are about to forget them. That is the curve behind this page.
        </p>
      </div>

      <div className={styles.axis} aria-hidden="true">
        <span>Today</span>
        <span>Day 30</span>
      </div>
    </section>
  )
}

function Curve() {
  return (
    <div className={styles.plot} aria-hidden="true">
      <svg viewBox="0 0 160 90" preserveAspectRatio="none">
        <path
          className={styles.area}
          d="M6,24 C18,48 26,56 34,57 L34,36 C44,58 52,66 62,67 L62,42 C76,64 86,70 98,71 L98,50 C116,68 134,74 154,76 L154,90 L6,90 Z"
        />
        <path
          className={styles.curve}
          vectorEffect="non-scaling-stroke"
          d={CURVE}
        />
      </svg>

      {REVIEWS.map((review) => (
        <span
          key={review.left}
          className={styles.dot}
          style={{left: review.left, top: review.top}}
        />
      ))}
    </div>
  )
}
const STATS = [
  {label: 'Due now', value: 12, link: true, pin: 3}, {label: 'Later this week', value: 41},
  {label: 'Questions tracked', value: 218, pin: 1}, {label: 'Worksheets', value: 9},
] as const

const WEAKEST = [
  {
    name: 'Nonlinear functions',
    path: 'SAT Math › Advanced Math › Nonlinear functions',
    correct: 6,
    unsure: 2,
    wrong: 6,
  },
  {
    name: 'Ratios, rates, and proportional relationships',
    path: 'SAT Math › Problem-Solving and Data Analysis › Ratios, rates, and proportional relationships',
    correct: 11,
    unsure: 3,
    wrong: 5,
  },
  {
    name: 'Command of evidence: textual',
    path: 'SAT Reading and Writing › Information and Ideas › Command of evidence: textual',
    correct: 11,
    unsure: 2,
    wrong: 4,
  },
  {
    name: 'Right triangles and trigonometry',
    path: 'SAT Math › Geometry and Trigonometry › Right triangles and trigonometry',
    correct: 9,
    unsure: 0,
    wrong: 3,
  },
] as const

export const SUBJECTS = [
  {name: 'Competition Math', correct: 28, attempts: 32},
  {name: 'SAT Math', correct: 71, attempts: 104},
  {name: 'SAT Reading and Writing', correct: 65, attempts: 82},
] as const

const FRAGILE = [
  {name: 'Words in context', unsureRate: 38}, {name: 'Percentages', unsureRate: 31},
  {name: 'Transitions', unsureRate: 27},
] as const

const NOTES = [
  {
    term: 'Every question',
    detail:
      'Not just the ones you got wrong. 218 counted is what makes 43% on nonlinear functions mean something instead of nothing.',
  },
  {
    term: 'Sorted by topic',
    detail:
      'Each question lands somewhere in a subject tree, so the grey line under a row names a skill rather than the worksheet it came from.',
  },
  {
    term: 'Scheduled to stick',
    detail:
      'Spaced repetition sets the day each question comes back. Twelve of them are due today, and that number is the whole to-do list.',
  },
] as const

const CAL_PERCENT = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 0,
})

export function DashboardPreview() {
  return (
    <section className={styles.section} aria-labelledby="preview-title">
      <p className="eyebrow">The dashboard</p>
      <h2 id="preview-title" className={styles.title}>
        After nine worksheets, it looks like this.
      </h2>
      <p className={`${styles.lede} text-pretty text-muted`}>
        Every question you have marked, rolled up into the topics that are
        actually costing you marks, and a queue of what to review today.
      </p>

      <div className={styles.stage}>
        <div className={styles.mock} aria-hidden="true">
          <div className={styles.bar}>
            <span className={styles.screen}>Dashboard</span>
            <span className={styles.cta}>Upload a worksheet</span>
          </div>

          <dl className="mt-5 grid grid-cols-2 sm:grid-cols-[1.3fr_1.3fr_1fr_1fr]">
            {STATS.map((stat) => (
              <div
                key={stat.label}
                className="py-3 pr-6"
              >
                <dt className="eyebrow flex items-center gap-1.5">
                  {'pin' in stat && <span className={styles.pin}>{stat.pin}</span>}
                  {stat.label}
                </dt>
                <dd
                  className={`mt-1 font-display font-semibold tabular-nums text-fg ${
                    'link' in stat ? 'text-3xl' : 'text-xl'
                  }`}
                >
                  {'link' in stat ? (
                    <span className="text-accent underline decoration-1 underline-offset-4">
                      {stat.value}
                    </span>
                  ) : (
                    stat.value
                  )}
                </dd>
              </div>
            ))}
          </dl>

          <div className="card mt-4 p-4">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <span className={styles.pin}>2</span>
              Weakest topics
            </h3>
            <p className="hint mb-3 text-pretty">
              Ranked by how confident we can be that the misses are real, not by
              raw percentage. A topic needs {MIN_ATTEMPTS} attempts before it
              appears here.
            </p>
            <ul className="">
              {WEAKEST.map((topic) => {
                const attempts = topic.correct + topic.unsure + topic.wrong
                const accuracy = topic.correct / attempts

                return (
                  <li key={topic.name} className="py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {topic.name}
                      </span>
                      <AccuracyLabel
                        accuracy={accuracy}
                        ranked
                        attempts={attempts}
                      />
                    </div>
                    <p className="truncate text-xs text-muted">{topic.path}</p>
                    <div className="mt-2">
                      <Meter accuracy={accuracy} label={topic.name} />
                    </div>
                    <p className="mt-1 text-xs tabular-nums text-muted">
                      {topic.wrong} missed of {attempts}
                      {topic.unsure > 0 && ` · ${topic.unsure} unsure`}
                    </p>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="card p-4">
              <h3 className="text-sm font-medium">By subject</h3>
              <p className="hint mb-3">
                Rolled up from every question you have marked.
              </p>
              <ul className="space-y-3">
                {SUBJECTS.map((subject) => {
                  const accuracy = subject.correct / subject.attempts

                  return (
                    <li key={subject.name}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-sm">{subject.name}</span>
                        <span className="shrink-0 text-sm tabular-nums text-muted">
                          {CAL_PERCENT.format(accuracy)}
                        </span>
                      </div>
                      <div className="mt-1.5">
                        <Meter accuracy={accuracy} label={subject.name} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>

            <div className={`card p-4 ${styles.aside}`}>
              <h3 className="text-sm font-medium">Right but guessed</h3>
              <p className="hint mb-3 text-pretty">
                High accuracy with a high unsure rate is fragile, not strong.
              </p>
              <ul className="space-y-2">
                {FRAGILE.map((topic) => (
                  <li key={topic.name} className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {topic.name}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-muted">
                      {topic.unsureRate}% guessed
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      <p className="sr-only">
        An example dashboard: 218 questions tracked across 9 worksheets, 12 due
        for review today, and a ranked list of the weakest topics with an
        accuracy meter on each.
      </p>

      <ol className={styles.notes}>
        {NOTES.map((note, index) => (
          <li key={note.term} className={styles.note}>
            <span aria-hidden="true" className={styles.pin}>
              {index + 1}
            </span>
            <p className="text-sm text-pretty text-muted">
              <b className={styles.term}>{note.term}.</b> {note.detail}
            </p>
          </li>
        ))}
      </ol>
    </section>
  )
}

const DAY_MS = 86_400_000

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

function key(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function level(total: number): 0 | 1 | 2 | 3 | 4 {
  if (total === 0) return 0
  if (total < 5) return 1
  if (total < 15) return 2
  if (total < 30) return 3
  return 4
}

const CAL_FILL: Record<number, string> = {
  0: 'bg-fg/10',
  1: 'bg-marker/30',
  2: 'bg-marker/55',
  3: 'bg-marker/80',
  4: 'bg-marker',
}

export function StudyCalendar({
  days,
  streak,
  weeks = 26,
}: {
  days: StudyDay[]
  streak: number
  weeks?: number
}) {
  const WEEKS = weeks
  const byDay = new Map(days.map((day) => [day.day, day]))

  const today = new Date()
  const end = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  )
  const start = new Date(end.getTime() - (WEEKS * 7 - 1) * DAY_MS)
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))

  const columns: {date: Date; day: StudyDay | undefined}[][] = []
  for (
    let cursor = new Date(start);
    cursor <= end;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const weekday = (cursor.getUTCDay() + 6) % 7
    if (weekday === 0) columns.push([])
    const date = new Date(cursor)
    columns[columns.length - 1]?.push({date, day: byDay.get(key(date))})
  }

  let lastLabelAt = -99

  const studied = days.length
  const total = days.reduce((sum, day) => sum + day.total, 0)
  const best = bestRun(days)

  return (
    <div>
      <dl className="mb-3 flex flex-wrap gap-x-6 gap-y-1">
        <Figure label="Current run" value={streak} unit="days" />
        <Figure label="Best run" value={best} unit="days" />
        <Figure label="Days studied" value={studied} unit={`of ${WEEKS * 7}`} />
      </dl>

      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="flex min-w-max gap-1.5">
          <div
            aria-hidden="true"
            className="grid shrink-0 grid-rows-7 gap-[3px] pt-[15px] text-right"
          >
            {WEEKDAYS.map((name, row) => (
              <span
                key={name}
                className="font-mono text-[9px] leading-[12px] text-muted"
              >
                {row % 2 === 1 ? name : ''}
              </span>
            ))}
          </div>

          <div>
            <div className="flex gap-[3px]">
              {columns.map((week, index) => {
                const first = week[0]?.date
                const previous = columns[index - 1]?.[0]?.date
                const isNewMonth =
                  first &&
                  (!previous || previous.getUTCMonth() !== first.getUTCMonth())
                const roomSinceLast = index - lastLabelAt >= 3
                const showLabel = isNewMonth && roomSinceLast
                if (showLabel) lastLabelAt = index

                return (
                  <span
                    key={first ? key(first) : index}
                    aria-hidden="true"
                    className="w-[12px] font-mono text-[9px] leading-[12px] text-muted"
                  >
                    {showLabel ? MONTHS[first.getUTCMonth()] : ''}
                  </span>
                )
              })}
            </div>

            <div className="mt-[3px] flex gap-[3px]">
              {columns.map((week, index) => (
                <div key={index} className="grid grid-rows-7 gap-[3px]">
                  {week.map(({date, day}) => (
                    <span
                      key={key(date)}
                      title={describe(date, day)}
                      className={`size-[12px] ${
                        CAL_FILL[level(day?.total ?? 0)]
                      }`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <p className="sr-only">
        You have studied on {studied} of the last {WEEKS * 7} days, {total}{' '}
        questions in total. Your current run is {streak}{' '}
        {streak === 1 ? 'day' : 'days'} and your best run in this period is{' '}
        {best} {best === 1 ? 'day' : 'days'}.
      </p>

      <div
        aria-hidden="true"
        className="mt-2 flex items-center justify-end gap-1.5"
      >
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">
          Lighter
        </span>
        {[0, 1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className={`size-[10px] ${CAL_FILL[step]}`}
          />
        ))}
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">
          Heavier
        </span>
      </div>
    </div>
  )
}

function Figure({
  label,
  value,
  unit,
}: {
  label: string
  value: number
  unit: string
}) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="font-display text-xl font-semibold tabular-nums">
        {value}{' '}
        <span className="font-sans text-xs font-normal text-muted">{unit}</span>
      </dd>
    </div>
  )
}

function describe(date: Date, day: StudyDay | undefined): string {
  const when = date.toISOString().slice(0, 10)
  if (!day) return `${when}: nothing`
  return `${when}: ${day.total} answered, ${day.correct} right, ${day.wrong} missed`
}

function bestRun(days: StudyDay[]): number {
  let best = 0
  let run = 0
  let previous: number | null = null

  for (const day of days) {
    const at = Date.parse(`${day.day}T00:00:00Z`)
    run = previous !== null && at - previous === DAY_MS ? run + 1 : 1
    if (run > best) best = run
    previous = at
  }

  return best
}

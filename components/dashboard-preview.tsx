import { AccuracyLabel, Meter } from './meter'
import { MIN_ATTEMPTS } from '@/lib/dashboard'

import styles from './dashboard-preview.module.css'

const STATS = [
  { label: 'Due now', value: 12, link: true, pin: 3 },
  { label: 'Later this week', value: 41 },
  { label: 'Questions tracked', value: 218, pin: 1 },
  { label: 'Worksheets', value: 9 },
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
  { name: 'Competition Math', correct: 28, attempts: 32 },
  { name: 'SAT Math', correct: 71, attempts: 104 },
  { name: 'SAT Reading and Writing', correct: 65, attempts: 82 },
] as const

const FRAGILE = [
  { name: 'Words in context', unsureRate: 38 },
  { name: 'Percentages', unsureRate: 31 },
  { name: 'Transitions', unsureRate: 27 },
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

const PERCENT = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 0,
})

export default function DashboardPreview() {
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
                          {PERCENT.format(accuracy)}
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

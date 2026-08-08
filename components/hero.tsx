import Mark from './mark'

import styles from './hero.module.css'

/**
 * The four topics the demo extracts. Kept honest on purpose: these are real
 * taxonomy names, each one is the topic of the matching question in
 * QUESTIONS below, and they add up to the 24 the counter lands on.
 */
const TOPICS = [
  { name: 'Ratio & proportion', count: 6 },
  { name: 'Linear equations', count: 5 },
  { name: 'Reading inference', count: 8 },
  { name: 'Vocabulary in context', count: 5 },
] as const

const TOTAL = TOPICS.reduce((sum, topic) => sum + topic.count, 0)

/**
 * Decay, reset, decay again, each reset buying longer than the last. Shared
 * by the drawn line and the highlight that runs along it, so the two can
 * never drift apart.
 */
const CURVE =
  'M6,24 C18,48 26,56 34,57 L34,36 C44,58 52,66 62,67 L62,42 C76,64 86,70 98,71 L98,50 C116,68 134,74 154,76'

/** The three review peaks, as percentages of the curve's 160x90 box. */
const REVIEWS = [
  { left: '21.25%', top: '40%' },
  { left: '38.75%', top: '46.7%' },
  { left: '61.25%', top: '55.6%' },
] as const

/**
 * The worksheet being read. These are verbatim stems from the 2024 SHSAT
 * sample form in `benchmark/input`: one per topic above, in the same order,
 * so the boxes that snap on and the pills that fly in describe each other.
 * Placeholder bars would have shown the mechanism; the real sentences show
 * the product.
 */
const QUESTIONS = [
  'A child grows 1 1/4 inches in 1/3 of a year. What would be his yearly growth rate in inches per year?',
  'If (3/5 − 1/2)x = 1/4 + 2/3, what is the value of x?',
  'The narrator’s actions in paragraph 5 reveal that he is',
  'In paragraph 3, the phrase “the butterflies of the sea” conveys the idea that',
] as const

export default function Hero({ children }: { children: React.ReactNode }) {
  return (
    <section className={styles.hero}>
      <Curve />

      <div className={styles.stack}>
        <p className={styles.brand}>
          <Mark className={styles.mark} />
          StudyBuddy
        </p>

        <h1 className={styles.blurb}>
          Turn the worksheets you have already done into a record of what you
          actually know.
        </h1>

        <div className={styles.panel}>
          <div>
            <p className={styles.count} aria-hidden="true" />
            <span className="sr-only">
              {TOTAL} questions found in one worksheet
            </span>
            <p className="hint mt-1">pulled out, tagged and scheduled</p>

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
            <div className={styles.beam} />
          </div>
        </div>

        {children}

        <p className={`${styles.caption} text-sm text-pretty text-muted`}>
          Then each one comes back on the day you are about to lose it. That is
          the curve behind this page.
        </p>
      </div>

      <div className={styles.axis} aria-hidden="true">
        <span>Today</span>
        <span>Day 30</span>
      </div>
    </section>
  )
}

/**
 * Ebbinghaus, roughly: memory decays, a review resets it, and each reset
 * buys longer than the last. Schematic rather than plotted; it is stretched
 * to the viewport width, so it carries the shape and not the numbers.
 */
function Curve() {
  return (
    <div className={styles.plot} aria-hidden="true">
      <svg viewBox="0 0 160 90" preserveAspectRatio="none">
        <path
          className={styles.area}
          d="M6,24 C18,48 26,56 34,57 L34,36 C44,58 52,66 62,67 L62,42 C76,64 86,70 98,71 L98,50 C116,68 134,74 154,76 L154,90 L6,90 Z"
        />
        {/* The box is stretched to the viewport, so the stroke has to opt out
            of that scaling or it renders ~9x too heavy on a wide screen. */}
        <path
          className={styles.curve}
          vectorEffect="non-scaling-stroke"
          d={CURVE}
        />
      </svg>

      {/* Draws the line on, then runs a band of light back along it. */}
      <div className={styles.wipe} />
      <div className={styles.sweep} />

      {/* Review points as elements rather than SVG circles: a circle in a
          stretched viewBox is an ellipse. */}
      {REVIEWS.map((review) => (
        <span
          key={review.left}
          className={styles.dot}
          style={{ left: review.left, top: review.top }}
        />
      ))}
    </div>
  )
}

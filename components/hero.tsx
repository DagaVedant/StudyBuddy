import Link from 'next/link'

import Mark from './mark'

import styles from './hero.module.css'

export const TOPICS = [
  { name: 'Ratios and rates', count: 6 },
  { name: 'Linear equations', count: 5 },
  { name: 'Inferences', count: 8 },
  { name: 'Words in context', count: 5 },
] as const

const TOTAL = TOPICS.reduce((sum, topic) => sum + topic.count, 0)

const CURVE =
  'M6,24 C18,48 26,56 34,57 L34,36 C44,58 52,66 62,67 L62,42 C76,64 86,70 98,71 L98,50 C116,68 134,74 154,76'

const REVIEWS = [
  { left: '21.25%', top: '40%' },
  { left: '38.75%', top: '46.7%' },
  { left: '61.25%', top: '55.6%' },
] as const

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
        {/*
          The wordmark is the top-left thing on the page and looks exactly
          like the one in the signed-in masthead, which is a link. It was a
          bare <p> here, so it invited a click and did nothing.

          Home, matching the masthead. On this page that is a self-link, which
          is what a wordmark on a homepage normally is, and it keeps the mark
          meaning one thing wherever it appears.
        */}
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
            <p className={styles.count} aria-hidden="true" />
            <span className="sr-only">
              {TOTAL} questions found in one worksheet
            </span>
            <p className="hint mt-1">pulled out, tagged and ready to mark</p>

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

      <div className={styles.sweep} />

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

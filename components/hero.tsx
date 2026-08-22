import Link from 'next/link'

import styles from './styles.module.css'
import {Mark} from './mark'

const TOPICS = [
  {name: 'Ratios and rates', count: 6}, {name: 'Linear equations', count: 5},
  {name: 'Inferences', count: 8}, {name: 'Words in context', count: 5},
] as const

const TOTAL = TOPICS.reduce((sum, topic) => sum + topic.count, 0)

const QUESTIONS = [
  'A child grows 1 1/4 inches in 1/3 of a year. What would be his yearly growth rate in inches per year?',
  'If (3/5 − 1/2)x = 1/4 + 2/3, what is the value of x?',
  'The narrator’s actions in paragraph 5 reveal that he is',
  'In paragraph 3, the phrase “the butterflies of the sea” conveys the idea that',
] as const

export function Hero({children}: {children: React.ReactNode}) {
  return (
    <section className={styles.hero}>
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
      </div>
    </section>
  )
}

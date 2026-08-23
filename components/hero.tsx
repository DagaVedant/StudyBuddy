import Link from 'next/link'

import styles from './styles.module.css'

export function Hero({children}: {children: React.ReactNode}) {
  return (
    <section className={styles.hero}>
      <p>
        <Link href="/">StudyBuddy</Link>
      </p>

      <h1 className={styles.title}>
        Turn the worksheets you have already done into a record of what you
        actually know.
      </h1>

      <p>
        Upload a worksheet, mark what you missed, and StudyBuddy tracks which
        topics are actually costing you marks.
      </p>

      {children}
    </section>
  )
}

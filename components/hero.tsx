import Link from 'next/link'

import styles from './styles.module.css'
import {Mark} from './mark'

export function Hero({children}: {children: React.ReactNode}) {
  return (
    <section className={styles.hero}>
      <div className={styles.stack}>
        <Link href="/" className={styles.brand}>
          <Mark className={styles.mark} />
          StudyBuddy
        </Link>

        <h1 className={styles.blurb}>
          Turn the worksheets you have already done into a record of{' '}
          <span className="marked">what you actually know</span>.
        </h1>

        <p className="hint mt-4 max-w-md">
          Upload a worksheet, mark what you missed, and StudyBuddy tracks which
          topics are actually costing you marks.
        </p>

        {children}
      </div>
    </section>
  )
}

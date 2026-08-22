import Image from 'next/image'

import styles from './styles.module.css'

export function DashboardPreview() {
  return (
    <section className={styles.section} aria-labelledby="preview-title">
      <h2 id="preview-title" className={styles.title}>
        After eighteen worksheets, it looks like this.
      </h2>
      <div className={styles.stage}>
        <Image
          src="/dashboard.png"
          alt="The dashboard: a headline saying 150 questions are due for review today, a ranked list of the topics costing the most marks with an accuracy meter on each, and a sidebar counting questions tracked, worksheets and the current study streak."
          width={1894}
          height={790}
          priority
          sizes="(min-width: 64rem) 63rem, 100vw"
          className={styles.shot}
        />
      </div>
    </section>
  )
}

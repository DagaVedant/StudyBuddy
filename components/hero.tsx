import styles from './hero.module.css'

/**
 * The four topics the demo extracts. Kept honest on purpose: these are real
 * taxonomy names and they add up to the 24 the counter lands on.
 */
const TOPICS = [
  { name: 'Ratio & proportion', count: 6 },
  { name: 'Linear equations', count: 5 },
  { name: 'Reading inference', count: 8 },
  { name: 'Vocabulary in context', count: 5 },
] as const

const TOTAL = TOPICS.reduce((sum, topic) => sum + topic.count, 0)

/** Widths for the fake worksheet's text lines — irregular, like prose. */
const QUESTIONS = [
  ['92%', '70%'],
  ['84%', '58%'],
  ['96%', '64%'],
  ['78%', '50%'],
] as const

export default function Hero({ children }: { children: React.ReactNode }) {
  return (
    <section className={`${styles.hero} px-6 pt-12 pb-16 sm:pt-20 sm:pb-24`}>
      <Curve />

      <div className="mx-auto w-full max-w-6xl">
        <p className="eyebrow">Practice, measured</p>

        {/* Sized so the panel below it clears a ~700px viewport: the whole
            point of this layout is both ideas above the fold. */}
        <h1 className="display mt-3 text-[clamp(2.25rem,7vw,4.25rem)]">
          Know what
          <br />
          you don&rsquo;t know
        </h1>

        <p className="mt-5 max-w-lg text-lg text-pretty text-muted">
          Upload the worksheets you have already done. Every question gets pulled
          out, tagged, and brought back before you forget it.
        </p>

        <div className={`${styles.panel} mt-8 max-w-3xl`}>
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
            {QUESTIONS.map((widths, index) => (
              <div key={index} className={styles.q}>
                {widths.map((width) => (
                  <div key={width} className={styles.line} style={{ width }} />
                ))}
                <span className={styles.qbox} />
              </div>
            ))}
            <div className={styles.beam} />
          </div>
        </div>

        {children}

        <p className={`${styles.caption} mt-12 max-w-md text-sm text-pretty text-muted`}>
          Then each one comes back on the day you are about to lose it — that is
          the curve behind this page.
        </p>

        <div
          className="mt-3 flex justify-between text-xs uppercase tracking-[0.1em] text-muted"
          aria-hidden="true"
        >
          <span>Today</span>
          <span>Day 30</span>
        </div>
      </div>
    </section>
  )
}

/**
 * Ebbinghaus, roughly: memory decays, a review resets it, and each reset
 * buys longer than the last. Schematic rather than plotted — it is stretched
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
        <path
          className={styles.curve}
          d="M6,24 C18,48 26,56 34,57 L34,36 C44,58 52,66 62,67 L62,42 C76,64 86,70 98,71 L98,50 C116,68 134,74 154,76"
        />
        <circle className={styles.dot} cx="34" cy="36" r="1.8" />
        <circle className={styles.dot} cx="62" cy="42" r="1.8" />
        <circle className={styles.dot} cx="98" cy="50" r="1.8" />
      </svg>
    </div>
  )
}

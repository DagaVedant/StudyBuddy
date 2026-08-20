import Link from 'next/link'

/*
 * The furniture of a textbook page.
 *
 * Four ideas, and they are load-bearing rather than decorative:
 *
 *   Rules divide. A printed hairline under a section head and a heavy one at
 *   the masthead and the foot, which is what a page of a book actually uses
 *   to group things. The pencil is kept for the reader's layer, so the two
 *   materials never do the same job.
 *
 *   Sections are numbered and indexed. A textbook does not ask you to scan
 *   nine equal tiles to find out what is in it; it prints a contents list
 *   with the figures on it, and then repeats the number beside each section
 *   so you can find your way back.
 *
 *   Colour categorises. Three note levels, and each means something: `info`
 *   is the argument the data is making, `action` is something to go and do,
 *   `quiet` is reference you are not expected to read every visit. Nothing is
 *   tinted because it looked nice.
 *
 *   The margin is a real column. Metadata, counts and status live there so
 *   the main column can stay a comfortable measure for reading.
 */

export type Tone = 'info' | 'action' | 'quiet'

export type NoteColour = 'yellow' | 'pink' | 'blue' | 'green' | 'orange'

const NOTE: Record<NoteColour, string> = {
  yellow: 'bg-note-yellow',
  pink: 'bg-note-pink',
  blue: 'bg-note-blue',
  green: 'bg-note-green',
  orange: 'bg-note-orange',
}

/*
 * A sticky note.
 *
 * A square of coloured paper with padding on it, and nothing else. No shadow,
 * no gradient, no rotation, no curled corner, no drawn outline. Every one of
 * those is available and every one of them is the thing that would make this
 * look like an effect rather than a note, so the whole component is one div
 * and a background colour.
 *
 * Square corners for the same reason: a sticky note is cut, not rounded.
 */
export function Note({
  colour,
  labelledBy,
  className = '',
  children,
}: {
  colour: NoteColour
  labelledBy?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={`rounded-none p-5 ${NOTE[colour]} ${className}`}
    >
      {children}
    </section>
  )
}

/*
 * Fill and ink per note level, kept in one place so a tone cannot drift into
 * meaning something different in two components. The fills are deliberately
 * weak: a callout has to read as a panel on the page, not as a highlight.
 */
const TONE: Record<Tone, string> = {
  info: 'text-accent',
  action: 'text-fg',
  quiet: 'text-muted',
}

/*
 * A numbered section head with its rule.
 *
 * The number is a link target as well as a label: the contents list and the
 * foot of the page both point at it, which is the whole reason a textbook
 * numbers its sections in the first place.
 */
export function SectionHead({
  no,
  id,
  title,
  hint,
  tone = 'info',
}: {
  no?: string
  id: string
  title: string
  hint?: string
  tone?: Tone
}) {
  return (
    <div className="mb-4">
      <div className="flex items-baseline gap-3 border-b border-fg/20 pb-2">
        {no && (
          <span
            aria-hidden="true"
            className={`font-mono text-[0.6875rem] tabular-nums ${TONE[tone]}`}
          >
            §{no}
          </span>
        )}
        <h2
          id={id}
          className="font-display text-lg font-semibold tracking-tight sm:text-xl"
        >
          {title}
        </h2>
      </div>
      {/* Capped at a reading measure rather than the column width: the column
          is wide enough to run past 75 characters, which is where a line stops
          being comfortable. */}
      {hint && <p className="hint max-w-[62ch] text-pretty">{hint}</p>}
    </div>
  )
}

/*
 * A pulled-out panel: the "Did you know" box of a textbook, used here for the
 * one thing on the page that is an instruction rather than a reading. It is a
 * sticky note like everything else; only the label marks it out.
 */
export function Callout({
  label,
  colour = 'orange',
  children,
}: {
  label: string
  colour?: NoteColour
  children: React.ReactNode
}) {
  return (
    <Note colour={colour}>
      <p className="eyebrow">{label}</p>
      <div className="mt-2">{children}</div>
    </Note>
  )
}

/* One entry in the margin, on its own note. */
export function MarginNote({
  label,
  colour,
  children,
}: {
  label: string
  colour: NoteColour
  children: React.ReactNode
}) {
  return (
    <Note colour={colour}>
      <h2 className="eyebrow">{label}</h2>
      <div className="mt-2">{children}</div>
    </Note>
  )
}

/*
 * The contents list.
 *
 * This is the part that replaces a wall of equal tiles. A reader arriving at
 * a long page wants to know what is on it and what the number is, in one
 * place, before deciding where to go; that is what a contents page is for,
 * and a dashboard has exactly the same problem.
 */
export function Contents({
  entries,
}: {
  entries: { no: string; id: string; title: string; figure?: string }[]
}) {
  return (
    <nav aria-labelledby="contents-heading" className="mb-10">
      <h2 id="contents-heading" className="eyebrow border-b border-rule-heavy pb-2">
        Contents
      </h2>
      <ol className="mt-1">
        {entries.map((entry) => (
          <li key={entry.id} className="border-b border-rule">
            <Link
              href={`#${entry.id}`}
              className="flex items-baseline gap-3 py-2 text-sm hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span
                aria-hidden="true"
                className="font-mono text-[0.6875rem] tabular-nums text-accent"
              >
                §{entry.no}
              </span>
              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
              {entry.figure && (
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                  {entry.figure}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  )
}

/*
 * The foot of the page.
 *
 * A book puts its number and its running head at the bottom; this does the
 * same job for a page that scrolls, which is to say it tells you where the
 * end is and gives you a way back rather than leaving you at the bottom of an
 * infinite column.
 */
export function PageFoot({
  running,
  entries,
}: {
  running: string
  entries: { no: string; id: string }[]
}) {
  return (
    <footer className="mt-14 border-t border-rule-heavy pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="eyebrow">{running}</p>
        <nav aria-label="Sections" className="flex flex-wrap items-baseline gap-3">
          {entries.map((entry) => (
            <Link
              key={entry.id}
              href={`#${entry.id}`}
              className="font-mono text-[0.6875rem] tabular-nums text-muted hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              §{entry.no}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  )
}

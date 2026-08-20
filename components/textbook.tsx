import Link from 'next/link'


export type Tone = 'info' | 'action' | 'quiet'

export type NoteColour = 'yellow' | 'pink' | 'blue' | 'green' | 'orange'

const NOTE: Record<NoteColour, string> = {
  yellow: 'bg-note-yellow',
  pink: 'bg-note-pink',
  blue: 'bg-note-blue',
  green: 'bg-note-green',
  orange: 'bg-note-orange',
}

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

const TONE: Record<Tone, string> = {
  info: 'text-accent',
  action: 'text-fg',
  quiet: 'text-muted',
}

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
      {hint && <p className="hint max-w-[62ch] text-pretty">{hint}</p>}
    </div>
  )
}

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

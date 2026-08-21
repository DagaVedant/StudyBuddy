import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'

import { MIN_ATTEMPTS } from '@/lib/upload'
import { type QuestionEvidence } from '@/lib/questions/text'
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="3.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.6 13.9C4.3 15.4 5.9 17.4 7.5 19.7 11.7 13.7 16.3 8.3 21.4 4.4" />
    </svg>
  )
}

export function MainRegion({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
      {children}
    </div>
  )
}

export function PageHead({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow?: string
  title: React.ReactNode
  lede?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="max-w-2xl">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="mt-1.5 text-balance font-display text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
          {title}
        </h1>
        {lede && <p className="mt-3 text-pretty text-muted">{lede}</p>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  )
}
const PERCENT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})

type Band = 'critical' | 'serious' | 'warning' | 'good' | 'unknown'

function band(accuracy: number, ranked: boolean): Band {
  if (!ranked) return 'unknown'
  if (accuracy < 0.5) return 'critical'
  if (accuracy < 0.7) return 'serious'
  if (accuracy < 0.85) return 'warning'
  return 'good'
}

const FILL: Record<Band, string> = {
  critical: 'bg-danger',
  serious: 'bg-warning',
  warning: 'bg-caution',
  good: 'bg-success',
  unknown: 'bg-muted/40',
}

export function Meter({
  accuracy,
  ranked = true,
  label,
  thick = false,
}: {
  accuracy: number
  ranked?: boolean
  label: string
  thick?: boolean
}) {
  const pct = Math.round(accuracy * 100)

  const measured = ranked
    ? {
        role: 'meter' as const,
        'aria-valuenow': pct,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-label': `${label}: ${PERCENT.format(accuracy)} correct`,
      }
    : { 'aria-hidden': true as const }

  return (
    <div
      {...measured}
      className={`w-full overflow-hidden bg-fg/15 ${thick ? 'h-3' : 'h-1.5'}`}
    >
      <div
        className={`h-full ${FILL[band(accuracy, ranked)]}`}
        style={{ width: `${ranked ? Math.max(pct, 2) : 100}%` }}
      />
    </div>
  )
}

export function AccuracyLabel({
  accuracy,
  ranked,
  attempts,
}: {
  accuracy: number
  ranked: boolean
  attempts: number
}) {
  if (!ranked) {
    return (
      <span className="text-sm text-muted">
        {attempts}/{MIN_ATTEMPTS} answered
      </span>
    )
  }

  return <span className="text-sm font-medium tabular-nums">{PERCENT.format(accuracy)}</span>
}
function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      )
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

type Block =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }

export function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
      paragraph = []
    }
    if (list) {
      blocks.push({ kind: 'list', ...list })
      list = null
    }
  }

  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()

    if (!line) {
      flush()
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({
        kind: 'heading',
        level: heading[1].length <= 2 ? 2 : 3,
        text: heading[2],
      })
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line)

    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      const item = (bullet ?? numbered)![1]

      if (list && list.ordered !== ordered) flush()

      if (paragraph.length > 0) {
        blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
        paragraph = []
      }

      list = list ?? { ordered, items: [] }
      list.items.push(item)
      continue
    }

    if (list) flush()
    paragraph.push(line)
  }

  flush()
  return blocks
}

export function Prose({ markdown }: { markdown: string }) {
  const blocks = blocksOf(markdown)

  return (
    <div className="space-y-3 text-sm">
      {blocks.map((block, index) => {
        const key = `b-${index}`

        if (block.kind === 'heading') {
          return block.level === 2 ? (
            <h3 key={key} className="mt-5 text-sm font-semibold tracking-tight">
              {inline(block.text, key)}
            </h3>
          ) : (
            <h4 key={key} className="mt-4 text-sm font-medium">
              {inline(block.text, key)}
            </h4>
          )
        }

        if (block.kind === 'list') {
          const items = block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`} className="text-pretty">
              {inline(item, `${key}-${itemIndex}`)}
            </li>
          ))

          return block.ordered ? (
            <ol key={key} className="ml-5 list-decimal space-y-1.5">
              {items}
            </ol>
          ) : (
            <ul key={key} className="ml-5 list-disc space-y-1.5">
              {items}
            </ul>
          )
        }

        return (
          <p key={key} className="text-pretty">
            {inline(block.text, key)}
          </p>
        )
      })}
    </div>
  )
}

export function Underline({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 300 14"
      preserveAspectRatio="none"
      fill="none"
      className={`pointer-events-none absolute left-0 top-[92%] h-[0.26em] w-full ${className}`}
    >
      <path
        d="M3 8.5C52 4.2 104 10.4 152 6.1 200 1.8 249 9.7 297 5"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Tick({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3.4 12.8C5.1 14.1 6.6 16 8.1 18.6 11.6 12.1 15.9 6.6 21 2.6" />
    </svg>
  )
}
const CROP_MARGIN = 0.04

export function QuestionCrop({
  image,
  alt,
}: {
  image: QuestionEvidence
  alt: string
}) {
  const [x0, y0, x1, y1] = image.bbox

  const padX = (x1 - x0) * CROP_MARGIN
  const padY = (y1 - y0) * CROP_MARGIN
  const left = Math.max(0, x0 - padX)
  const top = Math.max(0, y0 - padY)
  const cropWidth = Math.min(image.width, x1 + padX) - left
  const cropHeight = Math.min(image.height, y1 + padY) - top

  return (
    <div className="my-0.5 overflow-hidden rounded-lg [rotate:0.35deg]">
      <div className="relative" style={{ aspectRatio: `${cropWidth} / ${cropHeight}` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.src}
          alt={alt}
          width={image.width}
          height={image.height}
          className="absolute max-w-none"
          style={{
            left: `${(-left / cropWidth) * 100}%`,
            top: `${(-top / cropHeight) * 100}%`,
            width: `${(image.width / cropWidth) * 100}%`,
            height: 'auto',
          }}
        />
      </div>
    </div>
  )
}
export function AiSetupPrompt() {
  return (
    <section
      aria-labelledby="ai-setup-prompt-heading"
      className="card my-8 p-4"
    >
      <h2 id="ai-setup-prompt-heading" className="text-sm font-medium">
        One trial worksheet left
      </h2>
      <p className="hint text-pretty">
        After that, StudyBuddy stops reading worksheets for you. Everything else
        keeps working: marking, review, explanations you have already generated,
        and your whole dashboard. Three ways forward.
      </p>

      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="font-medium">Your own API key</dt>
          <dd className="text-muted">
            Best extraction quality. You pay Anthropic or OpenAI directly, per
            worksheet, and nothing is capped.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Your own GPU</dt>
          <dd className="text-muted">
            Free and private if you already run Ollama. Reading happens in your
            browser, so the tab has to stay open while it works.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Stay free</dt>
          <dd className="text-muted">
            Do nothing. You type each worksheet&rsquo;s questions in yourself,
            and every other feature is unchanged.
          </dd>
        </div>
      </dl>

      <Link href="/settings" className="btn btn-primary mt-4 sm:w-auto sm:px-6">
        Choose how StudyBuddy thinks
      </Link>
    </section>
  )
}

export function Note({
  labelledBy,
  className = '',
  children,
}: {
  labelledBy?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={`border border-rule bg-surface p-5 ${className}`}
    >
      {children}
    </section>
  )
}

export function SectionHead({ id, title }: { id: string; title: string }) {
  return (
    <div className="mb-4 border-b border-fg/20 pb-2">
      <h2
        id={id}
        className="font-display text-lg font-semibold tracking-tight sm:text-xl"
      >
        {title}
      </h2>
    </div>
  )
}

export function Callout({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Note>
      <p className="eyebrow">{label}</p>
      <div className="mt-2">{children}</div>
    </Note>
  )
}

export function MarginNote({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Note>
      <h2 className="eyebrow">{label}</h2>
      <div className="mt-2">{children}</div>
    </Note>
  )
}

export function PageFoot({ running }: { running: string }) {
  return (
    <footer className="mt-14 border-t border-rule-heavy pt-3">
      <p className="eyebrow">{running}</p>
    </footer>
  )
}

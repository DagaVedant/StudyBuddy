import { Fragment, type ReactNode } from 'react'

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

export default function Prose({ markdown }: { markdown: string }) {
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

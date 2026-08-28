import {Fragment, type ReactNode} from 'react'

function inline(text: string, keyPrefix: string) {
  let parts = text.split(/(\*\*[^*]+\*\*)/g)
  let out: ReactNode[] = []

  for (let index = 0; index < parts.length; index++) {
    let part = parts[index]
    let key = keyPrefix + '-' + index

    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      out.push(
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>,
      )
    } else {
      out.push(<Fragment key={key}>{part}</Fragment>)
    }
  }

  return out
}

type Block = {
  kind: string
  level: number
  text: string
  ordered: boolean
  items: string[]
}

function blocksOf(markdown: string) {
  let blocks: Block[] = []
  let paragraph: string[] = []
  let listItems: string[] = []
  let listOrdered = false
  let inList = false

  function flushParagraph() {
    if (paragraph.length === 0) return
    blocks.push({
      kind: 'paragraph',
      level: 0,
      text: paragraph.join(' '),
      ordered: false,
      items: [],
    })
    paragraph = []
  }

  function flushList() {
    if (!inList) return
    blocks.push({kind: 'list', level: 0, text: '', ordered: listOrdered, items: listItems})
    listItems = []
    inList = false
  }

  let lines = markdown.replace(/\r\n/g, '\n').split('\n')

  for (let raw of lines) {
    let line = raw.trim()

    if (!line) {
      flushParagraph()
      flushList()
      continue
    }

    let heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()

      let level = 3
      if (heading[1].length <= 2) level = 2

      blocks.push({kind: 'heading', level: level, text: heading[2], ordered: false, items: []})
      continue
    }

    let bullet = /^[-*]\s+(.*)$/.exec(line)
    let numbered = /^\d+[.)]\s+(.*)$/.exec(line)

    let match = bullet
    let ordered = false

    if (!match) {
      match = numbered
      ordered = true
    }

    if (match) {
      if (inList && listOrdered !== ordered) {
        flushParagraph()
        flushList()
      }

      flushParagraph()

      if (!inList) {
        inList = true
        listOrdered = ordered
      }

      listItems.push(match[1])
      continue
    }

    if (inList) {
      flushParagraph()
      flushList()
    }

    paragraph.push(line)
  }

  flushParagraph()
  flushList()

  return blocks
}

export function Prose({markdown}: {markdown: string}) {
  let blocks = blocksOf(markdown)
  let out = []

  for (let index = 0; index < blocks.length; index++) {
    let block = blocks[index]
    let key = 'b-' + index

    if (block.kind === 'heading') {
      if (block.level === 2) {
        out.push(
          <h3 key={key} className="mt-5 text-sm font-semibold tracking-tight">
            {inline(block.text, key)}
          </h3>,
        )
      } else {
        out.push(
          <h4 key={key} className="mt-4 text-sm font-medium">
            {inline(block.text, key)}
          </h4>,
        )
      }
      continue
    }

    if (block.kind === 'list') {
      let items = []

      for (let i = 0; i < block.items.length; i++) {
        items.push(
          <li key={key + '-' + i} className="text-pretty">
            {inline(block.items[i], key + '-' + i)}
          </li>,
        )
      }

      if (block.ordered) {
        out.push(
          <ol key={key} className="ml-5 list-decimal space-y-1.5">
            {items}
          </ol>,
        )
      } else {
        out.push(
          <ul key={key} className="ml-5 list-disc space-y-1.5">
            {items}
          </ul>,
        )
      }
      continue
    }

    out.push(
      <p key={key} className="text-pretty">
        {inline(block.text, key)}
      </p>,
    )
  }

  return <div className="space-y-3 text-sm">{out}</div>
}

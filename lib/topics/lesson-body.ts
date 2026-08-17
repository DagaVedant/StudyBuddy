const SECTION_START = /^(#{1,6})\s+(.*)$|^\*\*([^*]+)\*\*:?\s*$/

const DUPLICATED =
  /^(some\s+|a\s+few\s+|other\s+)?(worked\s+|sample\s+|practice\s+)?(examples?|common\s+(errors?|mistakes?|pitfalls?)|errors?|mistakes?|pitfalls?|traps?|things\s+to\s+(avoid|watch\s+(out\s+)?for)|watch\s+outs?|what\s+(people|students)\s+get\s+wrong)\b/i

interface Section {
  title: string
  level: number
}

function sectionOf(line: string): Section | null {
  const match = SECTION_START.exec(line.trim())
  if (!match) return null

  if (match[3] !== undefined) return { title: match[3].trim(), level: 99 }

  return { title: (match[2] ?? '').trim(), level: match[1].length }
}

export function trimLessonBody(bodyMd: string): string {
  const lines = bodyMd.replace(/\r\n/g, '\n').split('\n')
  const kept: string[] = []

  let skipping = false

  for (const line of lines) {
    const section = sectionOf(line)

    if (section) {
      if (section.level === 1 && !DUPLICATED.test(section.title)) {
        skipping = false
        continue
      }

      skipping = DUPLICATED.test(section.title)
      if (skipping) continue
    }

    if (!skipping) kept.push(line)
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Takes the walkthrough back out of a lesson body that carries more than one.
 *
 * The page renders `body_md`, then the worked examples under their own
 * heading, then the common errors under theirs. A body that also collects its
 * own examples or pitfalls is shown beside the real ones and the reader meets
 * the lesson twice.
 *
 * The prompt forbids this in three separate sentences. It went on happening:
 * forbidding a `## Common errors` heading produced a bold **Common pitfalls to
 * avoid** carrying the same four items, and forbidding that by name would
 * invite the next spelling. Prompt wording cannot enforce a structural rule,
 * so this enforces it after the fact, where the rule is about shape rather
 * than about a phrase a model happened to choose.
 *
 * Not a markdown parser and not trying to be. It walks lines, recognises what
 * introduces a section, and drops the sections that duplicate a field the page
 * renders separately.
 */

/** A heading (`## Thing`) or a line that is entirely bold (`**Thing**`). */
const SECTION_START = /^(#{1,6})\s+(.*)$|^\*\*([^*]+)\*\*:?\s*$/

/**
 * What a duplicated section is called, in any of the spellings seen so far
 * plus the near ones. Matched against the section's title only, so a step that
 * mentions a trap in passing is untouched: this is about collecting them.
 */
const DUPLICATED =
  /^(some\s+|a\s+few\s+|other\s+)?(worked\s+|sample\s+|practice\s+)?(examples?|common\s+(errors?|mistakes?|pitfalls?)|errors?|mistakes?|pitfalls?|traps?|things\s+to\s+(avoid|watch\s+(out\s+)?for)|watch\s+outs?|what\s+(people|students)\s+get\s+wrong)\b/i

interface Section {
  title: string
  level: number
}

function sectionOf(line: string): Section | null {
  const match = SECTION_START.exec(line.trim())
  if (!match) return null

  // A bold line is a section start without a level, so it is treated as the
  // shallowest thing that can be interrupted by any heading.
  if (match[3] !== undefined) return { title: match[3].trim(), level: 99 }

  return { title: (match[2] ?? '').trim(), level: match[1].length }
}

/**
 * The body with its duplicated sections and its title removed.
 *
 * A section runs until the next section start, so dropping one takes its
 * prose with it, including a closing line that belongs to it. That is the
 * intent: "these pitfalls often arise from..." is part of the pitfalls.
 */
export function trimLessonBody(bodyMd: string): string {
  const lines = bodyMd.replace(/\r\n/g, '\n').split('\n')
  const kept: string[] = []

  let skipping = false

  for (const line of lines) {
    const section = sectionOf(line)

    if (section) {
      // A level-1 heading is the lesson's own title, which the page already
      // prints above it. Drop the line, keep what follows.
      if (section.level === 1 && !DUPLICATED.test(section.title)) {
        skipping = false
        continue
      }

      skipping = DUPLICATED.test(section.title)
      if (skipping) continue
    }

    if (!skipping) kept.push(line)
  }

  // Collapse the runs of blank lines a removed section leaves behind, and
  // trim the ends, so the body does not render with a gap where it was.
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

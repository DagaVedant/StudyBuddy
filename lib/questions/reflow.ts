const ITEM_START = /^(?:[-•*·–—]\s|\(?(?:[IVX]{1,4}|[A-H]|\d{1,2})[).]\s)/

export function reflowText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

      return lines.reduce((joined, line) => {
        if (!joined) return line
        if (ITEM_START.test(line)) return `${joined}\n${line}`
        if (/[a-z]-$/.test(joined) && /^[a-z]/.test(line)) {
          return `${joined.slice(0, -1)}${line}`
        }
        return `${joined} ${line}`
      }, '')
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

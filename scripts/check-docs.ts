import { readFileSync } from 'node:fs'

const schema = readFileSync('lib/db/schema.ts', 'utf8')
const tableCount = (schema.match(/=\s*pgTable\(/g) ?? []).length

const files = ['README.md']
let bad = false

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const match = text.match(/creates (\d+) tables/)

  if (!match) {
    console.log(`  skip  ${file}: no "creates N tables" line found`)
    continue
  }

  const stated = Number(match[1])
  if (stated === tableCount) {
    console.log(`  ok    ${file}: says ${stated}, schema has ${tableCount}`)
  } else {
    bad = true
    console.log(`  BAD   ${file}: says ${stated}, schema has ${tableCount}`)
  }
}

if (bad) {
  console.log(`\nUpdate the stale figure(s) above.`)
  process.exit(1)
}

console.log(`\nAll table counts match the schema (${tableCount} tables).`)

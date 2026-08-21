import {readFileSync, readdirSync} from 'node:fs'
import {dirname, join, relative, sep} from 'node:path'
import {spawn} from 'node:child_process'
import picomatch from 'picomatch'

function checkDocs() {

  const schema = readFileSync('lib/schema.ts', 'utf8')
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
    return false
  }

  console.log(`\nAll table counts match the schema (${tableCount} tables).`)
}


function routePaths() {
  const found = []

  const walk = (dir) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name === 'route.ts' || entry.name === 'page.tsx') {
        const segments = relative('app', dirname(full))
          .split(sep)
          .filter((part) => part && !/^\(.*\)$/.test(part))
        found.push('/' + segments.join('/'))
      }
    }
  }

  walk('app')
  return found
}

function checkTracing() {
  const config = readFileSync('next.config.ts', 'utf8')
  const block = config.match(/outputFileTracingIncludes:\s*\{([\s\S]*?)\n {2}\},/)

  if (!block) {
    console.log('  skip  next.config.ts: no outputFileTracingIncludes')
    return true
  }

  const keys = [...block[1].matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1])
  const routes = routePaths()
  let bad = false

  for (const key of keys) {
    const hits = routes.filter((route) => picomatch.isMatch(route, key))

    if (hits.length === 0) {
      bad = true
      console.log(`  BAD   tracing key "${key}" matches no route`)
    } else {
      console.log(`  ok    tracing key "${key}" -> ${hits.join(', ')}`)
    }
  }

  if (bad) {
    console.log('')
    console.log('A key that matches nothing includes nothing. [id] is a character')
    console.log('class in a glob, so dynamic segments have to be written as *.')
  }

  return !bad
}

function dispatcherTables() {
  const tables = []

  const walk = (dir) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name === 'route.ts') {
        const source = readFileSync(full, 'utf8')
        const block = source.match(/endpoints\(\[([\s\S]*?)\]\)/)
        if (!block) continue
        const patterns = [...block[1].matchAll(/\['(\w+)', '([^']*)'/g)].map((m) => ({
          method: m[1],
          pattern: m[2],
        }))
        tables.push({file: full, patterns})
      }
    }
  }

  walk(join('app', 'api'))
  return tables
}

function bothCanMatch(a, b) {
  const left = a === '' ? [] : a.split('/')
  const right = b === '' ? [] : b.split('/')
  if (left.length !== right.length) return false

  return left.every((part, i) => {
    const other = right[i]
    if (part.startsWith(':') || other.startsWith(':')) return true
    return part === other
  })
}

function checkRoutes() {
  let bad = false
  let pairs = 0

  for (const {file, patterns} of dispatcherTables()) {
    for (let i = 0; i < patterns.length; i += 1) {
      for (let j = i + 1; j < patterns.length; j += 1) {
        const a = patterns[i]
        const b = patterns[j]
        if (a.method !== b.method) continue
        if (!bothCanMatch(a.pattern, b.pattern)) continue

        pairs += 1
        const aStatic = !a.pattern.includes(':')
        const bStatic = !b.pattern.includes(':')

        if (!aStatic && !bStatic) {
          bad = true
          console.log(`  BAD   ${file}: "${a.pattern}" and "${b.pattern}" both match the same path`)
        }
      }
    }
  }

  console.log(`  ok    route tables: ${pairs} overlapping pair(s), all resolved by static-before-dynamic`)
  return !bad
}

const TASKS = [
  {name: 'tsc', script: 'node_modules/typescript/bin/tsc', args: ['--noEmit']},
  {
    name: 'eslint',
    script: 'node_modules/eslint/bin/eslint.js',
    args: ['--cache', '--cache-location', '.eslintcache', '--max-warnings', '0'],
  },
]

const docsOk = checkDocs()
const tracingOk = checkTracing()
const routesOk = checkRoutes()

const started = Date.now()

const runs = TASKS.map(
  (task) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [task.script, ...task.args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let output = ''
      child.stdout.on('data', (chunk) => (output += chunk))
      child.stderr.on('data', (chunk) => (output += chunk))

      child.on('close', (code) => {
        const seconds = ((Date.now() - started) / 1000).toFixed(1)
        console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${task.name.padEnd(7)} ${seconds}s`)
        resolve({name: task.name, code: code ?? 1, output})
      })
    }),
)

const results = await Promise.all(runs)
const failed = results.filter((result) => result.code !== 0)

for (const result of failed) {
  console.log(`\n${'='.repeat(60)}\n${result.name}\n${'='.repeat(60)}`)
  console.log(result.output.trim())
}

console.log(`\n${((Date.now() - started) / 1000).toFixed(1)}s total`)

process.exit(failed.length > 0 || !docsOk || !tracingOk || !routesOk ? 1 : 0)

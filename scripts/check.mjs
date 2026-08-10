import { spawn } from 'node:child_process'

/**
 * Typecheck, lint and test at the same time instead of one after another.
 *
 * They are independent: none reads what another writes, and all three want the
 * same thing from you, which is to know everything that is wrong in one go.
 * Chained with `&&` the run costs their sum and stops at the first failure, so
 * a lint slip hides a failing test until the next round trip. Run together the
 * wall clock is the slowest of the three, and you see every failure at once.
 *
 * ESLint is cached; the cache is keyed on file contents, so an unchanged file
 * is not re-linted. Nothing else here keeps state that a stale cache could
 * make wrong: tsc has its own incremental build info and vitest re-runs
 * everything.
 */
/**
 * Each tool's own entry point, run by node directly.
 *
 * Not `npx`, which costs a resolution step per task and needs a shell on
 * Windows to find the .cmd shim, and not a shell at all: passing arguments
 * through one is how they end up concatenated rather than escaped.
 */
const TASKS = [
  { name: 'tsc', script: 'node_modules/typescript/bin/tsc', args: ['--noEmit'] },
  {
    name: 'eslint',
    script: 'node_modules/eslint/bin/eslint.js',
    // --max-warnings 0: a warning nothing fails on is a comment. The
    // no-unused-vars rule is configured as a warning on purpose so an
    // in-progress edit is not fatal in the editor, and this is what makes it
    // fatal at the gate.
    args: ['--cache', '--cache-location', '.eslintcache', '--max-warnings', '0'],
  },
  { name: 'vitest', script: 'node_modules/vitest/vitest.mjs', args: ['run'] },
]

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
        resolve({ name: task.name, code: code ?? 1, output })
      })
    }),
)

const results = await Promise.all(runs)
const failed = results.filter((result) => result.code !== 0)

// Only the output that matters. All three passing is three words, not three
// screens; anything that failed prints in full.
for (const result of failed) {
  console.log(`\n${'='.repeat(60)}\n${result.name}\n${'='.repeat(60)}`)
  console.log(result.output.trim())
}

console.log(`\n${((Date.now() - started) / 1000).toFixed(1)}s total`)

process.exit(failed.length > 0 ? 1 : 0)

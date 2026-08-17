import { spawn } from 'node:child_process'

const TASKS = [
  { name: 'tsc', script: 'node_modules/typescript/bin/tsc', args: ['--noEmit'] },
  {
    name: 'eslint',
    script: 'node_modules/eslint/bin/eslint.js',
    args: ['--cache', '--cache-location', '.eslintcache', '--max-warnings', '0'],
  },
  { name: 'vitest', script: 'node_modules/vitest/vitest.mjs', args: ['run'] },
  { name: 'docs', script: 'scripts/check-docs.mjs', args: [] },
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

for (const result of failed) {
  console.log(`\n${'='.repeat(60)}\n${result.name}\n${'='.repeat(60)}`)
  console.log(result.output.trim())
}

console.log(`\n${((Date.now() - started) / 1000).toFixed(1)}s total`)

process.exit(failed.length > 0 ? 1 : 0)

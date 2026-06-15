import { copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Copies pdf.js — BOTH the main library and its worker — into /public.
 *
 * pdf.js cannot be bundled here. Two separate failures, both verified against
 * the live app (see /debug/raster):
 *
 *  1. `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` does
 *     not resolve under Turbopack; the worker 404s and `getDocument()` hangs
 *     forever with no error.
 *  2. Even with the worker served correctly, the Turbopack-RE-BUNDLED main
 *     module's `page.render()` never completes against the stock worker,
 *     while the unbundled module renders in milliseconds. Same version,
 *     different module instance, render hangs.
 *
 * Serving both files from /public keeps the main module and worker as the
 * matched, unmodified pair pdf.js ships. This script runs on postinstall and
 * before every dev/build, so the copies track the installed package version.
 */
const require = createRequire(import.meta.url)

const build = join(dirname(require.resolve('pdfjs-dist/package.json')), 'build')
const publicDir = join(process.cwd(), 'public')

await mkdir(publicDir, { recursive: true })

for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  await copyFile(join(build, file), join(publicDir, file))
}

console.log('pdf.min.mjs + pdf.worker.min.mjs -> public/')

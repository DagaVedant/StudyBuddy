import {copyFile, mkdir} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'

const require = createRequire(import.meta.url)

const build = join(dirname(require.resolve('pdfjs-dist/package.json')), 'build')
const publicDir = join(process.cwd(), 'public')

await mkdir(publicDir, {recursive: true})

for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  await copyFile(join(build, file), join(publicDir, file))
}

console.log('pdf.min.mjs + pdf.worker.min.mjs -> public/')

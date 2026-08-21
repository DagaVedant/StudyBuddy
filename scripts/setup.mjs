import {execFileSync} from 'node:child_process'
import {createHash, randomBytes} from 'node:crypto'
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

async function secrets() {
  const lines = [
    `AUTH_SECRET="${randomBytes(32).toString('base64')}"`,
    `CREDENTIALS_ENC_KEY="${randomBytes(32).toString('base64')}"`,
    `WORKER_API_TOKEN="sb_worker_${randomBytes(24).toString('hex')}"`,
  ]

  console.log(lines.join('\n'))
}

async function hooks() {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {stdio: 'ignore'})
  } catch {
    process.exit(0)
  }

  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {stdio: 'inherit'})
}

async function pdf_worker() {
  const require = createRequire(import.meta.url)

  const build = join(dirname(require.resolve('pdfjs-dist/package.json')), 'build')
  const publicDir = join(process.cwd(), 'public')

  await mkdir(publicDir, {recursive: true})

  for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    await copyFile(join(build, file), join(publicDir, file))
  }

  console.log('pdf.min.mjs + pdf.worker.min.mjs -> public/')
}

async function embedding_model() {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

  const MODEL = 'Xenova/all-MiniLM-L6-v2'
  const TARGET = join(REPO, 'models', ...MODEL.split('/'))

  const FILES = [
    {
      path: 'config.json',
      bytes: 650,
      sha256: '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
    },
    {
      path: 'tokenizer.json',
      bytes: 711661,
      sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
    },
    {
      path: 'tokenizer_config.json',
      bytes: 366,
      sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
    },
    {
      path: 'onnx/model_quantized.onnx',
      bytes: 22972370,
      sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
    },
  ]

  const REMOTE = `https://huggingface.co/${MODEL}/resolve/main`

  function digest(buffer) {
    return createHash('sha256').update(buffer).digest('hex')
  }

  async function present(file) {
    try {
      const existing = await readFile(join(TARGET, file.path))
      return digest(existing) === file.sha256
    } catch {
      return false
    }
  }

  async function fetchFile(file) {
    const url = `${REMOTE}/${file.path}`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`${url} answered ${response.status} ${response.statusText}`)
    }

    const body = Buffer.from(await response.arrayBuffer())

    if (body.length !== file.bytes) {
      throw new Error(
        `${file.path} is ${body.length} bytes, expected ${file.bytes}. ` +
          `A truncated download or a changed upstream file; not written.`,
      )
    }

    const got = digest(body)
    if (got !== file.sha256) {
      throw new Error(
        `${file.path} hashes to ${got}, expected ${file.sha256}. ` +
          `Upstream has changed; check it, then update the digest in this script.`,
      )
    }

    const destination = join(TARGET, file.path)
    await mkdir(dirname(destination), {recursive: true})
    await writeFile(destination, body)

    return body.length
  }

  async function main() {
    const missing = []
    for (const file of FILES) {
      if (!(await present(file))) missing.push(file)
    }

    if (missing.length === 0) {
      console.log('[embedding-model] already vendored, nothing to fetch')
      return
    }

    console.log(
      `[embedding-model] fetching ${missing.length} file(s) for ${MODEL} into models/`,
    )

    let total = 0
    for (const file of missing) {
      total += await fetchFile(file)
      console.log(`[embedding-model]   ${file.path}`)
    }

    console.log(`[embedding-model] ${(total / 1_000_000).toFixed(1)}MB written`)
  }

  await main().catch((error) => {
    console.error(`[embedding-model] ${error.message}`)
    process.exitCode = 1
  })
}

const TASKS = {
  'secrets': secrets,
  'hooks': hooks,
  'pdf-worker': pdf_worker,
  'embedding-model': embedding_model,
}

const task = process.argv[2]
const run = TASKS[task]

if (!run) {
  console.error(`setup: unknown task "${task}". One of: ${Object.keys(TASKS).join(', ')}`)
  process.exit(1)
}

await run()

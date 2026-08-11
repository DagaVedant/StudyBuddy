import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Puts the embedding model on disk at build time instead of mid-request.
 *
 * @huggingface/transformers ships no weights. npm installs the runtime, and the
 * model itself is fetched from huggingface.co on first use into a cache
 * directory inside node_modules. That is invisible on a developer machine,
 * where it happens once and then never again, and it is a real problem on a
 * serverless host: a fresh deploy has no cache, so the first worksheet to be
 * classified downloads 23MB inside an `after()` callback, on the clock of a
 * request that has already returned, over a connection nothing is watching.
 * When it fails the job still completes and the student gets a worksheet with
 * every question untagged.
 *
 * So it is fetched here, where a failure fails the build, and read from the
 * repo at runtime with the network turned off. `next.config.ts` traces this
 * directory into the serverless bundle; `lib/embeddings/index.ts` points the
 * library at it.
 *
 * Checked by digest rather than by presence. A half-written 23MB file from an
 * interrupted build looks exactly like a complete one to a `existsSync`, and
 * the failure it produces at runtime is an ONNX parse error a long way from
 * here.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Kept in step with EMBEDDING_MODEL in lib/embeddings/index.ts. The layout
// under it is what the library looks for: `${localModelPath}/${model}/...`.
const MODEL = 'Xenova/all-MiniLM-L6-v2'
const TARGET = join(REPO, 'models', ...MODEL.split('/'))

// Digests are of the files this app was built and benchmarked against, taken
// from the copy the local cache already held. They are the reason this script
// is not a way to have arbitrary weights substituted into a build.
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
    // The q8 build, because that is the dtype lib/embeddings asks the pipeline
    // for. A different dtype is a different filename and a different vector.
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
  await mkdir(dirname(destination), { recursive: true })
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
  // Loud, and fatal. A build that skipped this quietly is a deploy that
  // classifies nothing, and the only sign of it is topics that never appear.
  console.error(`[embedding-model] ${error.message}`)
  process.exitCode = 1
})

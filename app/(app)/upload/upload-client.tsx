'use client'

import Link from 'next/link'
import {useRouter} from 'next/navigation'
import {useCallback, useEffect, useId, useRef, useState} from 'react'

import {ingestWorksheet, type IngestProgress} from '@/lib/client/ingest'
import {
  findSample,
  parsePageRange,
  parseQuestionCount,
  SAMPLE_WORKSHEETS,
} from '@/lib/upload'

export type SubjectGroup = {
  label: string
  options: {slug: string; label: string}[]
}

type Props = {
  subjects: SubjectGroup[]
  initialSample?: string
}

const STAGE_LABEL: Record<IngestProgress['stage'], string> = {
  reading: 'Reading Files',
  rasterizing: 'Rendering Pages',
  uploading: 'Uploading Pages',
  ocr: 'Reading Text',
  finishing: 'Finishing Up',
  done: 'Done',
}

const BYTES = new Intl.NumberFormat(undefined, {maximumFractionDigits: 1})

function formatSize(bytes: number): string {
  if (bytes < 1000) return bytes + ' B'
  if (bytes < 1_000_000) return BYTES.format(bytes / 1000) + ' KB'
  return BYTES.format(bytes / 1_000_000) + ' MB'
}

function defaultTitle(files: File[]): string {
  const first = files[0]
  if (!first) return ''
  return first.name.replace(/\.[^.]+$/, '').slice(0, 120)
}

export default function UploadClient({subjects, initialSample}: Props) {
  const router = useRouter()
  const titleId = useId()
  const subjectId = useId()
  const filesId = useId()
  const pageFromId = useId()
  const pageToId = useId()
  const countId = useId()

  const [files, setFiles] = useState<File[]>([])
  const [title, setTitle] = useState('')
  const titleTouchedRef = useRef(false)
  const [subject, setSubject] = useState('')
  const [pageFrom, setPageFrom] = useState('')
  const [pageTo, setPageTo] = useState('')
  const [questionCount, setQuestionCount] = useState('')
  const [dragging, setDragging] = useState(false)

  let dropClass = 'card-sunk p-6 text-center'
  if (dragging) dropClass = 'card-sunk p-6 text-center bg-accent/10'
  const [progress, setProgress] = useState<IngestProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [handedOff, setHandedOff] = useState(false)
  const [loadingSample, setLoadingSample] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const runningRef = useRef(false)
  const worksheetRef = useRef<string | null>(null)

  const busy = handedOff || (progress !== null && progress.stage !== 'done')

  useEffect(() => {
    if (!busy) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [busy])

  useEffect(() => {
    return () => {
      const controller = abortRef.current
      if (controller) controller.abort()

      import('@/lib/client/rasterize').then((mod) => {
        mod.terminateOcr().catch(() => {})
      })
    }
  }, [])

  const addFiles = useCallback((incoming: ArrayLike<File> | null) => {
    if (!incoming || incoming.length === 0) return
    setError(null)

    setFiles((current) => {
      const next = [...current, ...Array.from(incoming)]
      if (!titleTouchedRef.current) setTitle(defaultTitle(next))
      return next
    })
  }, [])

  const loadSample = useCallback(
    async (slug: string, keepACopy: boolean) => {
      const sample = findSample(slug)
      if (!sample) return

      setError(null)
      setLoadingSample(slug)

      try {
        const response = await fetch('/samples/' + slug + '.pdf')
        if (!response.ok) throw new Error(String(response.status))

        const blob = await response.blob()
        const name = sample.title + '.pdf'

        addFiles([new File([blob], name, {type: 'application/pdf'})])

        setPageFrom('1')
        setPageTo(String(sample.pages))
        setQuestionCount(String(sample.questions))

        if (keepACopy) {
          const href = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = href
          link.download = name
          document.body.append(link)
          link.click()
          link.remove()
          setTimeout(() => URL.revokeObjectURL(href), 60_000)
        }
      } catch {
        setError('Could not load that sample worksheet. Try again.')
      } finally {
        setLoadingSample(null)
      }
    },
    [addFiles],
  )

  const requested = useRef(false)

  useEffect(() => {
    if (requested.current || !initialSample) return
    requested.current = true
    void loadSample(initialSample, false)
  }, [initialSample, loadSample])

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index))
  }

  function cancel() {
    runningRef.current = false

    const controller = abortRef.current
    if (controller) controller.abort()

    abortRef.current = null
    setProgress(null)
    setPending(null)

    const started = worksheetRef.current
    worksheetRef.current = null

    if (!started) {
      setNotice('Upload cancelled.')
      return
    }

    setNotice('Upload cancelled. Removing what had already gone up…')

    fetch('/api/worksheets/' + started, {method: 'DELETE'})
      .then(() => setNotice('Upload cancelled. Nothing was kept.'))
      .catch(() => setNotice('Upload cancelled.'))
  }

  async function start() {
    if (runningRef.current) return

    setError(null)
    setNotice(null)
    setPending(null)

    const parsed = parsePageRange(pageFrom, pageTo)
    if (!parsed.ok) {
      setError(parsed.message)
      return
    }

    const expected = parseQuestionCount(questionCount)
    if (!expected.ok) {
      setError(expected.message)
      return
    }

    runningRef.current = true
    worksheetRef.current = null

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const result = await ingestWorksheet({
        files,
        title: title.trim() || 'Untitled worksheet',
        subjectHint: subject || null,
        pageRange: parsed.range,
        expectedQuestionCount: expected.count,
        onProgress: (next) => {
          if (controller.signal.aborted) return
          setProgress(next)
        },
        onWorksheetCreated: (id) => {
          worksheetRef.current = id
        },
        signal: controller.signal,
      })
      worksheetRef.current = null

      if (result.message) {
        setProgress(null)
        setNotice(result.message)
        setPending(result.next)
        return
      }

      setHandedOff(true)
      router.push(result.next)
    } catch (cause) {
      if (controller.signal.aborted) return

      setProgress(null)
      setError(
        cause instanceof Error
          ? cause.message
          : 'Something went wrong. Try uploading again.',
      )
    } finally {
      runningRef.current = false
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  const pct = progress ? Math.round((progress.completed / Math.max(progress.total, 1)) * 100) : 0

  return (
    <div className="space-y-8">
      <section
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          addFiles(event.dataTransfer.files)
        }}
        aria-labelledby="add-heading"
        className={dropClass}
      >
        <h2 id="add-heading" className="text-pretty font-medium">
          Drop your pages here, or choose a file
        </h2>
        <div className="mx-auto mt-4 flex max-w-xs flex-col gap-2">
          <div className="sm:flex-1">
            <input
              id={filesId}
              type="file"
              accept="application/pdf,image/*"
              multiple
              className="peer sr-only"
              disabled={busy}
              onChange={(event) => {
                addFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <label
              htmlFor={filesId}
              className="btn btn-secondary cursor-pointer touch-manipulation peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:cursor-not-allowed peer-disabled:opacity-60"
            >
              Choose files
            </label>
          </div>
        </div>

        <p className="hint mt-4">
          No worksheet to hand? Try a sample:{' '}
          {SAMPLE_WORKSHEETS.map((sample, index) => (
            <span key={sample.slug}>
              {index > 0 && ', '}
              <button
                type="button"
                disabled={busy || loadingSample !== null}
                onClick={() => void loadSample(sample.slug, true)}
                className="underline underline-offset-2 hover:text-fg disabled:opacity-60"
              >
                {sample.questions} questions
              </button>
            </span>
          ))}
          {loadingSample !== null && ' loading...'}
        </p>
      </section>

      {files.length > 0 && (
        <section aria-labelledby="selected-heading">
          <h2 id="selected-heading" className="text-sm font-medium">
            Selected files
          </h2>
          <ul className="mt-2 divide-y divide-fg/20">
            {files.map((file, index) => (
              <li
                key={file.name + '-' + index}
                className="flex items-center gap-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>
                  {file.name}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-muted">
                  {formatSize(file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  disabled={busy}
                  aria-label={'Remove ' + file.name}
                  className="btn-compact shrink-0 rounded px-1 text-sm text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-4">
        <div>
          <label className="label" htmlFor={titleId}>
            Worksheet name
          </label>
          <input
            id={titleId}
            name="worksheet-title"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Unit 4 Practice: Triangles…"
            className="field"
            disabled={busy}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value)
              titleTouchedRef.current = true
            }}
          />
        </div>

        <div>
          <label className="label" htmlFor={subjectId}>
            Subject
          </label>
          <select
            id={subjectId}
            name="subject-hint"
            className="field bg-surface text-fg"
            disabled={busy}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          >
            <option value="">Not sure</option>
            {subjects.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.slug} value={option.slug}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <fieldset>
          <legend className="label">
            Pages
          </legend>

          <div className="flex items-center gap-2">
            <input
              id={pageFromId}
              name="page-from"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="1"
              className="field w-24 tabular-nums"
              disabled={busy}
              value={pageFrom}
              aria-label="First page"
              onChange={(event) => setPageFrom(event.target.value)}
            />
            <span aria-hidden="true" className="text-muted">
              to
            </span>
            <input
              id={pageToId}
              name="page-to"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="end"
              className="field w-24 tabular-nums"
              disabled={busy}
              value={pageTo}
              aria-label="Last page"
              onChange={(event) => setPageTo(event.target.value)}
            />
          </div>
        </fieldset>

        <div className="rounded-2xl bg-tint-butter p-4">
          <label className="label" htmlFor={countId}>
            Questions
          </label>
          <input
            id={countId}
            name="question-count"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="20"
            className="field w-32 tabular-nums"
            disabled={busy}
            value={questionCount}
            onChange={(event) => setQuestionCount(event.target.value)}
          />
        </div>
      </section>

      {error && (
        <p
          role="alert"
          className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {notice && (
        <div
          role="status"
          className="rounded-xl bg-surface px-3 py-2 text-sm text-muted"
        >
          <p className="text-pretty">{notice}</p>
          {pending && (
            <Link href={pending} className="mt-2 inline-block text-accent">
              Add its questions
            </Link>
          )}
        </div>
      )}

      {progress && (
        <section aria-labelledby="progress-heading">
          <div className="flex items-baseline justify-between gap-3 border-b border-fg/20 pb-2">
            <h2 id="progress-heading" className="text-sm font-medium">
              {STAGE_LABEL[progress.stage]}
            </h2>
            <span className="text-sm tabular-nums text-muted">
              {progress.completed} / {progress.total}
            </span>
          </div>

          <div
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-labelledby="progress-heading"
            className="mt-3 h-1.5 overflow-hidden rounded bg-wash-strong"
          >
            <div
              className="h-full bg-accent"
              style={{width: pct + '%'}}
            />
          </div>

          <p aria-live="polite" className="hint">
            {progress.detail}…
          </p>
        </section>
      )}

      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <button
          type="button"
          className="btn btn-primary touch-manipulation sm:w-auto sm:px-6"
          disabled={files.length === 0 || busy}
          onClick={start}
        >
          {busy ? 'Working…' : 'Start processing'}
        </button>

        {busy && (
          <button
            type="button"
            className="btn btn-secondary touch-manipulation sm:w-auto sm:px-6"
            onClick={cancel}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}

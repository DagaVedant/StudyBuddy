'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { ingestWorksheet, type IngestProgress } from '@/lib/client/ingest'
import { MAX_PAGES_PER_UPLOAD } from '@/lib/upload/limits'
import { parsePageRange } from '@/lib/upload/page-range'

export interface SubjectGroup {
  label: string
  options: { slug: string; label: string }[]
}

interface Props {
  subjects: SubjectGroup[]
  isAdmin: boolean
}

const STAGE_LABEL: Record<IngestProgress['stage'], string> = {
  reading: 'Reading Files',
  rasterizing: 'Rendering Pages',
  uploading: 'Uploading Pages',
  ocr: 'Reading Text',
  finishing: 'Finishing Up',
  done: 'Done',
}

const BYTES = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
})

function formatSize(bytes: number): string {
  return `${BYTES.format(bytes / 1_000_000)} MB`
}

function defaultTitle(files: File[]): string {
  const first = files[0]
  if (!first) return ''
  return first.name.replace(/\.[^.]+$/, '').slice(0, 120)
}

export default function UploadClient({ subjects, isAdmin }: Props) {
  const router = useRouter()
  const titleId = useId()
  const subjectId = useId()
  const filesId = useId()
  const cameraId = useId()
  const pageFromId = useId()
  const pageToId = useId()
  const countId = useId()

  const [files, setFiles] = useState<File[]>([])
  const [title, setTitle] = useState('')
  const [titleTouched, setTitleTouched] = useState(false)
  const [subject, setSubject] = useState('')
  const [pageFrom, setPageFrom] = useState('')
  const [pageTo, setPageTo] = useState('')
  const [questionCount, setQuestionCount] = useState('')
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<IngestProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  /**
   * True from the click, not from the first progress event.
   *
   * `busy` below is derived from state, and state does not update until React
   * re-renders, so between pressing Upload and the first progress arriving the
   * button was still live. A second press in that window started a second
   * ingest of the same files, which is how one PDF became two worksheets.
   */
  const runningRef = useRef(false)
  const busy = progress !== null && progress.stage !== 'done'

  // Closing the tab mid-ingest loses the rasterized pages, so warn first.
  useEffect(() => {
    if (!busy) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [busy])

  const addFiles = useCallback(
    (incoming: FileList | null) => {
      if (!incoming?.length) return
      setError(null)
      // Built outside the updater: calling setTitle inside setFiles' updater
      // is a side effect React is free to drop, and does — the default title
      // silently never applied.
      const next = [...files, ...Array.from(incoming)]
      setFiles(next)
      if (!titleTouched) setTitle(defaultTitle(next))
    },
    [files, titleTouched],
  )

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index))
  }

  /**
   * Clears the screen on the click rather than waiting for the in-flight step
   * to unwind. Rasterizing a page or recognizing text can take seconds, and
   * leaving a progress bar creeping forward after someone pressed Cancel reads
   * as the button not having worked.
   */
  function cancel() {
    runningRef.current = false
    abortRef.current?.abort()
    abortRef.current = null
    setProgress(null)
    setNotice('Upload cancelled. Nothing was saved.')
  }

  async function start() {
    if (runningRef.current) return
    runningRef.current = true

    setError(null)
    setNotice(null)

    const parsed = parsePageRange(pageFrom, pageTo)
    if (!parsed.ok) {
      setError(parsed.message)
      return
    }

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const result = await ingestWorksheet({
        files,
        title: title.trim() || 'Untitled worksheet',
        subjectHint: subject || null,
        pageRange: parsed.range,
        expectedQuestionCount: questionCount.trim()
          ? Number(questionCount.trim())
          : null,
        onProgress: (next) => {
          // A cancelled run can still emit one last progress event as it
          // unwinds; ignoring those keeps the bar from flickering back.
          if (controller.signal.aborted) return
          setProgress(next)
        },
        signal: controller.signal,
      })
      router.push(result.next)
    } catch (cause) {
      // Covers our own CancelledError and the DOMException fetch throws on
      // abort — either way the user asked for this, so it is not an error.
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
        className={`rounded-2xl border border-dashed p-6 text-center ${
          dragging ? 'border-accent bg-accent/5' : 'border-border'
        }`}
      >
        <h2 id="add-heading" className="text-pretty font-medium">
          Add Your Worksheet
        </h2>
        <p className="hint mx-auto max-w-sm text-pretty">
          PDFs, scans, or photos of the pages. Everything is rendered and read on
          your device. The file itself never leaves your browser.
        </p>

        <div className="mx-auto mt-4 flex max-w-xs flex-col gap-2 sm:flex-row">
          {/* Input precedes its label so `peer-*` can surface focus on the
              visible control — an sr-only input's own focus ring is invisible. */}
          <div className="sm:flex-1">
            <input
              id={cameraId}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="peer sr-only"
              disabled={busy}
              onChange={(event) => {
                addFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <label
              htmlFor={cameraId}
              className="btn btn-secondary cursor-pointer touch-manipulation peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:cursor-not-allowed peer-disabled:opacity-60"
            >
              Take Photo
            </label>
          </div>

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
              Choose Files
            </label>
          </div>
        </div>

        <p className="hint">
          {isAdmin ? 'No page limit on your account.' : `Up to ${MAX_PAGES_PER_UPLOAD} pages per upload.`}
        </p>
      </section>

      {files.length > 0 && (
        <section aria-labelledby="selected-heading">
          <h2 id="selected-heading" className="text-sm font-medium">
            Selected files
          </h2>
          <ul className="card mt-2 divide-y divide-border overflow-hidden">
            {files.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="flex items-center gap-3 px-3 py-2"
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
                  aria-label={`Remove ${file.name}`}
                  className="shrink-0 rounded px-1 text-sm text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
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
              setTitleTouched(true)
            }}
          />
        </div>

        <div>
          <label className="label" htmlFor={subjectId}>
            Subject <span className="font-normal text-muted">(optional)</span>
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
          <p className="hint">Helps sort the questions into the right topics later.</p>
        </div>

        <fieldset>
          <legend className="label">
            Pages <span className="font-normal text-muted">(optional)</span>
          </legend>

          <div className="flex items-center gap-2">
            <input
              id={pageFromId}
              name="page-from"
              type="number"
              inputMode="numeric"
              min={1}
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
              type="number"
              inputMode="numeric"
              min={1}
              placeholder="end"
              className="field w-24 tabular-nums"
              disabled={busy}
              value={pageTo}
              aria-label="Last page"
              onChange={(event) => setPageTo(event.target.value)}
            />
          </div>

          <p className="hint text-pretty">
            Leave blank for the whole file. Worth setting when a practice test
            is followed by an answer key or explanations. Those pages aren&rsquo;t
            questions, and skipping them means they are never rendered,
            uploaded, or read.
          </p>
        </fieldset>

        {/* Given its own tinted panel rather than sitting last in the column
            as another greyed-out "(optional)": this is the only thing that
            tells the checker what to aim for, and left blank it cannot tell a
            question it missed from one it counted twice. */}
        <div className="rounded-2xl bg-tint-butter p-4">
          <label className="label" htmlFor={countId}>
            How many questions?{' '}
            <span className="font-normal text-muted">(worth filling in)</span>
          </label>
          <input
            id={countId}
            name="question-count"
            type="number"
            inputMode="numeric"
            min={1}
            placeholder="20"
            className="field w-32 tabular-nums"
            disabled={busy}
            value={questionCount}
            onChange={(event) => setQuestionCount(event.target.value)}
          />
          <p className="hint text-pretty">
            Usually printed on the front of a practice test. StudyBuddy
            compares it against what it actually pulled out, so a question it
            skipped or grabbed twice gets caught and re-read before it reaches
            you. Leave it blank and there is nothing to check against.
          </p>
        </div>
      </section>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {notice && (
        <p
          role="status"
          className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-muted"
        >
          {notice}
        </p>
      )}

      {progress && (
        <section
          aria-labelledby="progress-heading"
          className="card p-4"
        >
          <div className="flex items-baseline justify-between gap-3">
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
            className="mt-3 h-1.5 overflow-hidden rounded bg-border"
          >
            <div
              className="h-full bg-accent motion-safe:transition-[width] motion-safe:duration-300"
              style={{ width: `${pct}%` }}
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
          {busy ? 'Working…' : 'Start Processing'}
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

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

  const abortRef = useRef<AbortController | null>(null)
  const busy = progress !== null && progress.stage !== 'done'

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
      const next = [...files, ...Array.from(incoming)]
      setFiles(next)
      if (!titleTouched) setTitle(defaultTitle(next))
    },
    [files, titleTouched],
  )

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index))
  }

  async function start() {
    setError(null)

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
        onProgress: setProgress,
        signal: controller.signal,
      })
      router.push(result.next)
    } catch (cause) {
      setProgress(null)
      setError(
        cause instanceof Error
          ? cause.message
          : 'Something went wrong. Try uploading again.',
      )
    } finally {
      abortRef.current = null
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
        className={`rounded border border-dashed p-6 text-center ${
          dragging ? 'border-accent bg-accent/5' : 'border-border'
        }`}
      >
        <h2 id="add-heading" className="text-pretty font-medium">
          Add Your Worksheet
        </h2>
        <p className="hint mx-auto max-w-sm text-pretty">
          PDFs, scans, or photos of the pages. Everything is rendered and read on
          your device — the file itself never leaves your browser.
        </p>

        <div className="mx-auto mt-4 flex max-w-xs flex-col gap-2 sm:flex-row">
          {
}
          <div className="sm:flex-1">
            <input
              id={cameraId}
              type="file"
              accept="image
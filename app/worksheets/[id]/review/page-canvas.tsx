'use client'

import { useCallback, useRef, useState } from 'react'

import type { BBox, TextLine } from '@/lib/db/schema'

import type { EditablePage } from './types'

/** Below this, a drag is a click that wobbled. */
const MIN_DRAG_PX = 12

/**
 * The words whose centres fall inside the box, in reading order.
 *
 * Centres rather than overlap, so a line clipped by the edge of the drag
 * belongs to whichever side most of it is on. That matters because a student
 * dragging around question 12 will always catch the descenders of 11.
 */
export function textInside(lines: TextLine[], box: BBox): string {
  const [bx0, by0, bx1, by1] = box

  return lines
    .filter((line) => {
      const [x0, y0, x1, y1] = line.bbox
      const cx = (x0 + x1) / 2
      const cy = (y0 + y1) / 2
      return cx >= bx0 && cx <= bx1 && cy >= by0 && cy <= by1
    })
    .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
    .map((line) => line.text)
    .join('\n')
    .trim()
}

/**
 * The page, and the drag that adds a question the reader missed.
 *
 * Owns nothing but the drag: the box being drawn is local state because it
 * changes on every pointermove, and lifting it would re-render the question
 * list sixty times a second for a rectangle the list does not care about.
 * A finished drag leaves through `onSelect` as a box and the text under it.
 */
export default function PageCanvas({
  page,
  pageNumber,
  pageCount,
  worksheetTitle,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onSelect,
}: {
  page: EditablePage
  pageNumber: number
  pageCount: number
  worksheetTitle: string
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onSelect: (bbox: BBox, promptText: string) => void
}) {
  const [draft, setDraft] = useState<BBox | null>(null)

  const imageRef = useRef<HTMLImageElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const draftRef = useRef<BBox | null>(null)

  const toPageCoords = useCallback(
    (event: React.PointerEvent): { x: number; y: number } => {
      const image = imageRef.current
      if (!image) return { x: 0, y: 0 }

      const rect = image.getBoundingClientRect()
      return {
        x: Math.max(
          0,
          Math.min(page.width, (event.clientX - rect.left) * (page.width / rect.width)),
        ),
        y: Math.max(
          0,
          Math.min(page.height, (event.clientY - rect.top) * (page.height / rect.height)),
        ),
      }
    },
    [page.width, page.height],
  )

  const pctX = (v: number) => `${(v / page.width) * 100}%`
  const pctY = (v: number) => `${(v / page.height) * 100}%`

  return (
    <section aria-labelledby="page-heading" className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="page-heading" className="truncate text-sm font-medium">
          <span className="text-muted">{worksheetTitle} · </span>
          Page <span className="tabular-nums">{pageNumber}</span> of{' '}
          <span className="tabular-nums">{pageCount}</span>
        </h2>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className="rounded-xl border border-border px-2 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            disabled={!canGoBack}
            onClick={onBack}
          >
            Previous
          </button>
          <button
            type="button"
            className="rounded-xl border border-border px-2 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            disabled={!canGoForward}
            onClick={onForward}
          >
            Next
          </button>
        </div>
      </div>

      <div
        className="card relative touch-none select-none overflow-hidden lg:sticky lg:top-4"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          const point = toPageCoords(event)
          dragStart.current = point
          const box: BBox = [point.x, point.y, point.x, point.y]
          draftRef.current = box
          setDraft(box)
        }}
        onPointerMove={(event) => {
          if (!dragStart.current) return
          const point = toPageCoords(event)
          const start = dragStart.current
          const box: BBox = [
            Math.min(start.x, point.x),
            Math.min(start.y, point.y),
            Math.max(start.x, point.x),
            Math.max(start.y, point.y),
          ]
          draftRef.current = box
          setDraft(box)
        }}
        onPointerUp={() => {
          // Reads the ref, not the `draft` state closure: a pointerup that
          // arrives before React commits the last pointermove's setDraft
          // would otherwise see a stale (often zero-size) box.
          const box = draftRef.current
          dragStart.current = null
          draftRef.current = null
          setDraft(null)
          if (!box) return
          if (box[2] - box[0] < MIN_DRAG_PX || box[3] - box[1] < MIN_DRAG_PX) return
          onSelect(box, textInside(page.textLines, box))
        }}
      >
        {/* Authenticated dynamic route; next/image can't forward the session. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imageRef}
          src={page.imageSrc}
          alt={`Page ${page.pageNumber} of ${worksheetTitle}`}
          width={page.width}
          height={page.height}
          className="block h-auto w-full"
        />

        {/* Nothing is drawn over the extracted questions: the boxes the model
            reports are loose enough that they framed the wrong lines as often
            as the right ones, and the cards beside the page are where the
            checking actually happens. The draft box below is still drawn,
            because that one is the pointer the reader is dragging. */}
        {draft && (
          <div
            aria-hidden="true"
            style={{
              left: pctX(draft[0]),
              top: pctY(draft[1]),
              width: pctX(draft[2] - draft[0]),
              height: pctY(draft[3] - draft[1]),
            }}
            className="absolute rounded-sm border-2 border-dashed border-accent bg-accent/10"
          />
        )}
      </div>

      <p className="hint">Missed one? Drag a box around it on the page.</p>
    </section>
  )
}

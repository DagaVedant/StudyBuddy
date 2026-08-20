'use client'
import { useCallback, useRef, useState } from 'react'

import type { BBox, TextLine } from '@/lib/db/schema'

import type { EditablePage } from './types'

const MIN_DRAG_PX = 12

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

export default function PageCanvas({
  page,
  linesReady,
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
  linesReady: boolean
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
  const [drawing, setDrawing] = useState(false)

  const imageRef = useRef<HTMLImageElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const draftRef = useRef<BBox | null>(null)

  const endDrag = useCallback(() => {
    dragStart.current = null
    draftRef.current = null
    setDraft(null)
  }, [])

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
            className="min-h-11 rounded-xl px-3 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            disabled={!canGoBack}
            onClick={onBack}
          >
            Previous
          </button>
          <button
            type="button"
            className="min-h-11 rounded-xl px-3 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            disabled={!canGoForward}
            onClick={onForward}
          >
            Next
          </button>
        </div>
      </div>

      <div
        className={`card relative select-none overflow-hidden lg:sticky lg:top-4 ${
          drawing ? 'touch-none ring-2 ring-accent' : 'touch-manipulation'
        }`}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          if (event.pointerType !== 'mouse' && !drawing) return
          if (!linesReady) return
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
          const box = draftRef.current
          endDrag()
          if (!box) return
          if (box[2] - box[0] < MIN_DRAG_PX || box[3] - box[1] < MIN_DRAG_PX) return

          setDrawing(false)
          onSelect(box, textInside(page.textLines, box))
        }}
        onPointerCancel={endDrag}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imageRef}
          src={page.imageSrc}
          alt={`Page ${page.pageNumber} of ${worksheetTitle}`}
          width={page.width}
          height={page.height}
          className="block h-auto w-full"
        />

        {draft && (
          <div
            aria-hidden="true"
            style={{
              left: pctX(draft[0]),
              top: pctY(draft[1]),
              width: pctX(draft[2] - draft[0]),
              height: pctY(draft[3] - draft[1]),
            }}
            /* The one border left in the app, and deliberately so: this is
               the marquee you are dragging, not chrome around content. A
               selection rectangle has to show its exact bounds, and a fill
               alone cannot show an edge you are placing to the pixel. */
            className="absolute rounded-sm border-2 border-dashed border-accent bg-accent/10"
          />
        )}
      </div>

      <p className="hint any-pointer-coarse:hidden" role={linesReady ? undefined : 'status'}>
        {linesReady
          ? 'Missed one? Drag a box around it on the page.'
          : 'Loading this page’s text…'}
      </p>

      {/* Only where there is a touch screen to gate. `any-pointer-coarse`
          rather than a width breakpoint: a laptop with a touch screen has the
          same problem as a phone and a wide window, and a mouse-only desktop
          should not be shown a button it never needs.

          Sticky, because the button has to be reachable from wherever the
          student has scrolled to. A page image is several screens tall, and the
          question they want to box is rarely the one next to the heading. */}
      {/* `inset-safe-bottom` rather than the fixed `bottom-2` offset it
          replaced: that was a guess at clearing the home indicator that
          happened to be close, and on a device that actually reports one,
          env(safe-area-inset-bottom) is what makes the guess correct instead
          of coincidental. The class is padding on a background-less wrapper
          sized to its own button, so it reads the same as the offset it
          replaced: empty space below the button, not a bar extending to the
          edge with its own fill. */}
      <div className="inset-safe-bottom sticky bottom-0 mt-1.5 hidden items-center gap-2 any-pointer-coarse:flex">
        <button
          type="button"
          aria-pressed={drawing}
          disabled={!linesReady}
          className="shrink-0 rounded-xl bg-surface px-3 py-1.5 text-sm shadow-[0_8px_20px_-14px_oklch(0%_0_0_/_0.35)] hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
          onClick={() => {
            setDrawing((on) => !on)
            endDrag()
          }}
        >
          {drawing ? 'Cancel' : 'Draw a Box'}
        </button>
        <span className="text-sm text-muted">
          {!linesReady
            ? 'Loading this page’s text…'
            : drawing
              ? 'Drag around the question you want to add.'
              : 'Missed one? Draw a box around it.'}
        </span>
      </div>
    </section>
  )
}

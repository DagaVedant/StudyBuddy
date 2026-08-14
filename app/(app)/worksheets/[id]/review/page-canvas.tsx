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
 *
 * A finger has to ask first. The container used to carry `touch-none`, which
 * hands every touch on it to these handlers and none to the browser, and the
 * page image is as tall as a phone: a student could neither scroll past the
 * page nor pinch into it to read the question they were meant to be checking,
 * and every attempt at either drew a box instead. So a touch drag is gated
 * behind a drawing mode, which the button under the page turns on for one box
 * at a time. A mouse is not gated, because a mouse never had the problem.
 */
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
  /**
   * Whether `page.textLines` is this page's real lines rather than the empty
   * array a page waiting on its own fetch starts with (ReviewClient, which
   * only ships page one's lines up front). Gates the drag rather than
   * letting it run against an empty array: reading nothing under a
   * genuine box would look identical to a page with nothing printed on it,
   * and the reader dragging it would have no way to tell the two apart.
   */
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
            className="min-h-11 rounded-xl border border-border px-3 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            disabled={!canGoBack}
            onClick={onBack}
          >
            Previous
          </button>
          <button
            type="button"
            className="min-h-11 rounded-xl border border-border px-3 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            disabled={!canGoForward}
            onClick={onForward}
          >
            Next
          </button>
        </div>
      </div>

      <div
        // `touch-manipulation` is pan and pinch-zoom kept, double-tap zoom
        // dropped. The browser only gets to keep them while no box is being
        // drawn: mid-drag it has to be `touch-none`, or the first vertical
        // movement is read as a scroll and the drag is cancelled out from under
        // the student.
        className={`card relative select-none overflow-hidden lg:sticky lg:top-4 ${
          drawing ? 'touch-none ring-2 ring-accent' : 'touch-manipulation'
        }`}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          // Off a mouse this is a scroll or a pinch until the student has said
          // otherwise, and the browser is already treating it as one.
          if (event.pointerType !== 'mouse' && !drawing) return
          // This page's lines have not arrived yet (page-canvas.tsx's own
          // note on `linesReady`). No box at all, rather than one that reads
          // as empty either because nothing is there or because the fetch
          // has not landed - the reader has no way to tell those apart.
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
          // Reads the ref, not the `draft` state closure: a pointerup that
          // arrives before React commits the last pointermove's setDraft
          // would otherwise see a stale (often zero-size) box.
          const box = draftRef.current
          endDrag()
          if (!box) return
          if (box[2] - box[0] < MIN_DRAG_PX || box[3] - box[1] < MIN_DRAG_PX) return

          // One box per opt-in. Leaving the mode on would leave the page
          // unscrollable again the moment the student wanted to go and read the
          // card that just appeared. A drag too small to count leaves it on,
          // because that one was a slip rather than a change of mind.
          setDrawing(false)
          onSelect(box, textInside(page.textLines, box))
        }}
        // The browser takes the gesture back if it decides it was a scroll
        // after all, and says so here. Without this the half-drawn box stayed
        // painted and the next touch carried on from where that one stopped.
        onPointerCancel={endDrag}
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
          className="shrink-0 rounded-xl border border-border bg-surface px-3 py-1.5 text-sm shadow-[0_8px_20px_-14px_oklch(0%_0_0_/_0.35)] hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
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

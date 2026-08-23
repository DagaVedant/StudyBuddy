'use client'

import {Cross, Tick} from '@/components/hand'

export function GradeStamp({tone, tick}: {tone: 'correct' | 'miss'; tick: number}) {
  if (tick === 0) return null

  return (
    <div
      key={tick}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center"
    >
      <div
        className={`stamp-pop flex size-28 items-center justify-center rounded-full border-4 ${
          tone === 'correct' ? 'border-success text-success' : 'border-danger text-danger'
        }`}
        style={{['--stamp-tilt' as string]: tone === 'correct' ? '-8deg' : '6deg'}}
      >
        {tone === 'correct' ? (
          <Tick className="size-14" />
        ) : (
          <Cross className="size-14" />
        )}
      </div>
    </div>
  )
}

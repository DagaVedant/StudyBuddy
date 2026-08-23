'use client'

const SCRAPS = [
  {x: -70, y: 130, r0: -10, r1: 200, delay: 0, tone: 'var(--marker)'},
  {x: 40, y: 150, r0: 15, r1: -160, delay: 60, tone: 'var(--success)'},
  {x: -20, y: 110, r0: 5, r1: 260, delay: 120, tone: 'var(--accent)'},
  {x: 90, y: 140, r0: -20, r1: -220, delay: 40, tone: 'var(--marker)'},
  {x: -100, y: 100, r0: 25, r1: 180, delay: 100, tone: 'var(--success)'},
  {x: 10, y: 160, r0: -30, r1: -260, delay: 20, tone: 'var(--accent)'},
]

export function Celebration() {
  return (
    <div aria-hidden="true" className="pointer-events-none relative h-0 overflow-visible">
      {SCRAPS.map((scrap, index) => (
        <span
          key={index}
          className="scrap absolute left-1/2 top-0 block h-3 w-2"
          style={
            {
              background: scrap.tone,
              animationDelay: `${scrap.delay}ms`,
              '--scrap-x': `${scrap.x}px`,
              '--scrap-y': `${scrap.y}px`,
              '--scrap-r0': `${scrap.r0}deg`,
              '--scrap-r1': `${scrap.r1}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  )
}

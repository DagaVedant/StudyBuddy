import { ImageResponse } from 'next/og'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const alt =
  'StudyBuddy: turn the worksheets you have already done into a record of what you actually know.'

export const size = { width: 1200, height: 630 }

export const contentType = 'image/png'

const BG = '#fbf4fc'
const FG = '#301f34'
const MUTED = '#67576a'
const ACCENT = '#c23600'

const CURVE = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <g opacity="0.45">
    <path fill="${ACCENT}" opacity="0.09" d="M0,168 C97.3,336 162.2,392 227,399 L227,252 C308.1,406 373,462 454.1,469 L454.1,294 C567.6,448 648.6,490 745.9,497 L745.9,350 C891.9,476 1037.8,518 1200,532 L1200,630 L0,630 Z" />
    <path fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round" d="M0,168 C97.3,336 162.2,392 227,399 L227,252 C308.1,406 373,462 454.1,469 L454.1,294 C567.6,448 648.6,490 745.9,497 L745.9,350 C891.9,476 1037.8,518 1200,532" />
    <circle cx="227" cy="252" r="5" fill="${ACCENT}" />
    <circle cx="454.1" cy="294" r="5" fill="${ACCENT}" />
    <circle cx="745.9" cy="350" r="5" fill="${ACCENT}" />
  </g>
</svg>`

const BLURB =
  'Turn the worksheets you have already done into a record of what you actually know.'

const curveSrc = `data:image/svg+xml;base64,${Buffer.from(CURVE).toString('base64')}`

function Mark({ unit }: { unit: number }) {
  const square = unit * 7
  const gutter = unit * 2
  const radius = unit * 1.5

  const cell = (dim: boolean) => ({
    width: square,
    height: square,
    borderRadius: radius,
    backgroundColor: dim ? 'rgba(194, 54, 0, 0.35)' : ACCENT,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: gutter }}>
      <div style={{ display: 'flex', gap: gutter }}>
        <div style={cell(false)} />
        <div style={cell(true)} />
      </div>
      <div style={{ display: 'flex', gap: gutter }}>
        <div style={cell(true)} />
        <div style={cell(false)} />
      </div>
    </div>
  )
}

export default async function Image() {
  const [archivo, geist] = await Promise.all([
    readFile(join(process.cwd(), 'assets/fonts/Archivo-ExtraBold-latin.ttf')),
    readFile(join(process.cwd(), 'assets/fonts/Geist-Medium-latin.ttf')),
  ])

  return new ImageResponse(
    (
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          backgroundColor: BG,
          color: FG,
          fontFamily: 'Geist',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- next/image
            has no meaning inside ImageResponse; Satori only renders <img>. */}
        <img src={curveSrc} width={1200} height={630} alt="" style={{ position: 'absolute', top: 0, left: 0 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 21 }}>
          <Mark unit={3} />
          <div
            style={{
              fontFamily: 'Archivo',
              fontSize: 40,
              letterSpacing: -1.2 /* -0.03em, the site's display tracking */,
            }}
          >
            StudyBuddy
          </div>
        </div>

        {/* The largest thing on the card for the same reason it is the
            largest thing on the page. It sits straight on the curve with no
            panel behind it, which is also what the hero does; the hero's
            panel starts below the h1, not around it. */}
        <div
          style={{
            display: 'flex',
            maxWidth: 860,
            marginTop: 38,
            fontSize: 54,
            lineHeight: 1.35,
            letterSpacing: -1.08 /* -0.02em, matching .blurb */,
            textAlign: 'center',
          }}
        >
          {BLURB}
        </div>

        {/* The hero's axis labels, which are what make the shape behind the
            text legible as thirty days of forgetting rather than decoration. */}
        <div
          style={{
            position: 'absolute',
            left: 48,
            right: 48,
            bottom: 40,
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 20,
            letterSpacing: 2 /* 0.1em */,
            textTransform: 'uppercase',
            color: MUTED,
          }}
        >
          <div>Today</div>
          <div>Day 30</div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Archivo', data: archivo, style: 'normal', weight: 800 },
        { name: 'Geist', data: geist, style: 'normal', weight: 500 },
      ],
    }
  )
}

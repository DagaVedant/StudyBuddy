import {ImageResponse} from 'next/og'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

export const alt =
  'StudyBuddy: turn the worksheets you have already done into a record of what you actually know.'

export const size = {width: 1200, height: 630}

export const contentType = 'image/png'

const BG = '#f1ebe1'
const FG = '#1d1712'
const MUTED = '#59514a'
const ACCENT = '#00489f'
const PAPER_RED = 'rgba(184,54,38,0.5)'
const RULE = 'rgba(29,23,18,0.14)'

const CURVE = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" preserveAspectRatio="none">
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

const MARK_PATH = 'M2.6 13.9C4.3 15.4 5.9 17.4 7.5 19.7 11.7 13.7 16.3 8.3 21.4 4.4'

const markSrc = (size: number) =>
  `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${ACCENT}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="${MARK_PATH}"/></svg>`,
  ).toString('base64')}`

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
          alignItems: 'flex-start',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          paddingLeft: 110,
          paddingRight: 90,
          paddingBottom: 60,
          backgroundColor: BG,
          color: FG,
          fontFamily: 'Geist',
          backgroundImage: `repeating-linear-gradient(to bottom, ${BG} 0px, ${BG} 31px, ${RULE} 31px, ${RULE} 32px)`,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- next/image
            has no meaning inside ImageResponse; Satori only renders <img>. */}
        <img src={curveSrc} width={1200} height={272} alt="" style={{position: 'absolute', bottom: 0, left: 0}} />

        <div style={{position: 'absolute', top: 0, bottom: 0, left: 56, width: 1, backgroundColor: PAPER_RED}} />
        <div style={{position: 'absolute', top: 0, bottom: 0, left: 60, width: 1, backgroundColor: PAPER_RED}} />

        <div style={{display: 'flex', alignItems: 'center', gap: 21}}>
          {/* eslint-disable-next-line @next/next/no-img-element -- Satori
              only renders <img>; next/image has no meaning inside
              ImageResponse. */}
          <img src={markSrc(46)} width={46} height={46} alt="" />
          <div
            style={{
              fontFamily: 'Archivo',
              fontSize: 26,
              textTransform: 'uppercase',
              letterSpacing: 4 /* the masthead's mono tracking, approximated */,
            }}
          >
            StudyBuddy
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            maxWidth: 820,
            marginTop: 30,
            fontFamily: 'Archivo',
            fontSize: 62,
            lineHeight: 1.08,
            letterSpacing: -1.9 /* -0.03em, matching .blurb */,
          }}
        >
          {BLURB}
        </div>

        <div
          style={{
            position: 'absolute',
            left: 110,
            right: 90,
            bottom: 34,
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
        {name: 'Archivo', data: archivo, style: 'normal', weight: 800},
        {name: 'Geist', data: geist, style: 'normal', weight: 500},
      ],
    }
  )
}

import { ImageResponse } from 'next/og'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The social card.
 *
 * Built from the same three things the homepage leads with — the mark, the
 * wordmark, and the one sentence — sitting on the forgetting curve that is
 * the hero's background. Nothing here is invented for the card: the copy is
 * `components/hero.tsx` verbatim, the geometry is `components/mark.tsx`, and
 * the curve is the hero's own path.
 *
 * Two constraints shape how that gets expressed:
 *
 *  - Satori (what `ImageResponse` renders with) supports flexbox and a
 *    subset of CSS. No grid, no CSS variables, and no `oklch()` — so the
 *    "Soft Pastels" tokens from `app/globals.css` are inlined below as their
 *    sRGB equivalents rather than referenced. They are conversions, not new
 *    colours; if a token moves, recompute rather than eyeball.
 *  - `next/font` does not reach this file, so the two faces are read off
 *    disk from `assets/fonts/`. See the note there on why they are committed
 *    rather than pulled from the build output or the network.
 */

export const alt =
  'StudyBuddy — turn the worksheets you have already done into a record of what you actually know.'

export const size = { width: 1200, height: 630 }

export const contentType = 'image/png'

/**
 * `app/globals.css` light theme, converted from oklch to sRGB.
 *
 * Light only. A social card is pasted into someone else's chat window and
 * has no way to read their colour scheme, so it commits to one — and the
 * light theme is the one the palette is named for.
 */
const BG = '#fbf4fc' /* --bg      oklch(97.5% 0.012 320) */
const FG = '#301f34' /* --fg      oklch(27%   0.045 320) */
const MUTED = '#67576a' /* --muted   oklch(48%   0.035 320) */
const ACCENT = '#c23600' /* --accent  oklch(54%   0.19   42) */

/**
 * The hero's curve, with its coordinates pre-multiplied from the source
 * 160x90 viewBox to the card's 1200x630 box.
 *
 * The hero stretches this with `preserveAspectRatio="none"` and cancels the
 * distortion on the stroke with `vector-effect`. Neither trick is needed
 * here: baking the scale into the path means the box already matches the
 * card, so the stroke is a plain 2px and stays 2px.
 *
 * The one real departure from the source path: x is remapped so the curve
 * starts at 0 and ends at 1200 rather than keeping the hero's 6/160 side
 * inset. On the page that inset is invisible, because the shaded area under
 * the curve resolves to about 4% opacity. Rendered flat to a PNG the same
 * 4% is enough to show the straight edge where the fill closes on itself,
 * which reads as a stray vertical rule. Bleeding it off both sides removes
 * the edge and has the side effect of making the axis labels honest — the
 * curve now genuinely runs from Today to Day 30.
 *
 * Opacity 0.45 on the group is the hero's resting state — the value the
 * `brighten` keyframe lands on once the page has finished animating. The
 * card is a still of the end of that sequence, so the review points are lit
 * too.
 */
const CURVE = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <g opacity="0.45">
    <path fill="${ACCENT}" opacity="0.09" d="M0,168 C97.3,336 162.2,392 227,399 L227,252 C308.1,406 373,462 454.1,469 L454.1,294 C567.6,448 648.6,490 745.9,497 L745.9,350 C891.9,476 1037.8,518 1200,532 L1200,630 L0,630 Z" />
    <path fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round" d="M0,168 C97.3,336 162.2,392 227,399 L227,252 C308.1,406 373,462 454.1,469 L454.1,294 C567.6,448 648.6,490 745.9,497 L745.9,350 C891.9,476 1037.8,518 1200,532" />
    <circle cx="227" cy="252" r="5" fill="${ACCENT}" />
    <circle cx="454.1" cy="294" r="5" fill="${ACCENT}" />
    <circle cx="745.9" cy="350" r="5" fill="${ACCENT}" />
  </g>
</svg>`

/**
 * `components/hero.tsx`'s h1, verbatim. A constant rather than JSX text so
 * that it stays one string on one line and cannot pick up stray whitespace
 * from source wrapping.
 */
const BLURB =
  'Turn the worksheets you have already done into a record of what you actually know.'

/* base64 rather than percent-encoding: the path data is full of commas and
   the SVG of parentheses, which an unquoted `url()`/`src` would swallow. */
const curveSrc = `data:image/svg+xml;base64,${Buffer.from(CURVE).toString('base64')}`

/** `components/mark.tsx` as flexbox — four rounded squares, two dimmed. */
function Mark({ unit }: { unit: number }) {
  /* The source is a 16x16 box: 7-wide squares, a 2-wide gutter, rx 1.5. */
  const square = unit * 7
  const gutter = unit * 2
  const radius = unit * 1.5

  const cell = (dim: boolean) => ({
    width: square,
    height: square,
    borderRadius: radius,
    /* An explicit alpha rather than `opacity`, so the two dimmed quarters
       composite against the page exactly as the SVG's `opacity="0.35"`
       does and cannot pick up a stacking context of their own. */
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

        {/* The brand line. Proportioned off the hero, where the mark is 1.2x
            the wordmark's size and the gutter between them is 0.53em — the
            card just sets it larger, because a card is read as a thumbnail. */}
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
            panel behind it, which is also what the hero does — the hero's
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

import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Fraunces, Public_Sans, Space_Mono } from 'next/font/google'
import { SessionProvider } from 'next-auth/react'

import AutoRefresh from '@/components/auto-refresh'
import { appBaseUrl } from '@/lib/app-url'

import './globals.css'

/*
 * Three families, each with one job: see the note in globals.css for why
 * these three and not the grotesque-plus-nothing this replaced.
 *
 * Fraunces is loaded as a variable font across the axes the stylesheet
 * actually sets. `opsz` matters most: without it the display sizes get the
 * text-optical cut, which is the version drawn to survive being small, and a
 * 3rem heading set in it looks soft.
 */
const fraunces = Fraunces({
  variable: '--font-fraunces',
  subsets: ['latin'],
  axes: ['SOFT', 'WONK', 'opsz'],
  display: 'swap',
})

const publicSans = Public_Sans({
  variable: '--font-public-sans',
  subsets: ['latin'],
  display: 'swap',
})

/* Labels and metadata only, so two weights cover it. */
const spaceMono = Space_Mono({
  variable: '--font-space-mono',
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL(appBaseUrl()),
  title: 'StudyBuddy',
  description:
    'Turn finished practice worksheets into a record of what you actually know.',
  openGraph: {
    type: 'website',
    siteName: 'StudyBuddy',
    url: '/',
    title: 'StudyBuddy',
    description:
      'Turn finished practice worksheets into a record of what you actually know.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'StudyBuddy',
    description:
      'Turn finished practice worksheets into a record of what you actually know.',
  },
}

export const viewport: Viewport = {
  viewportFit: 'cover',
  /* Paper, matching --bg. One value, because the app is light only. */
  themeColor: '#f7f2e8',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${publicSans.variable} ${fraunces.variable} ${spaceMono.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:outline-2 focus:outline-accent"
        >
          Skip to content
        </a>
        <SessionProvider>{children}</SessionProvider>
        <AutoRefresh />
        <Analytics />
      </body>
    </html>
  )
}

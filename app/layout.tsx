import {Analytics} from '@vercel/analytics/next'
import type {Metadata, Viewport} from 'next'
import {Fugaz_One, Space_Mono, Work_Sans} from 'next/font/google'
import {SessionProvider} from 'next-auth/react'

import {AutoRefresh} from '@/components/auto-refresh'
import {appBaseUrl} from '@/lib/api'

import './globals.css'

const fugazOne = Fugaz_One({
  variable: '--font-fugaz-one',
  subsets: ['latin'],
  weight: ['400'],
  display: 'swap',
})

const workSans = Work_Sans({
  variable: '--font-work-sans',
  subsets: ['latin'],
  display: 'swap',
})

const spaceMono = Space_Mono({
  variable: '--font-space-mono',
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
})

const DESCRIPTION =
  'Turn finished practice worksheets into a record of what you actually know.'

export const metadata: Metadata = {
  metadataBase: new URL(appBaseUrl()),
  title: 'StudyBuddy',
  description: DESCRIPTION,
  openGraph: {
    type: 'website',
    siteName: 'StudyBuddy',
    url: '/',
    title: 'StudyBuddy',
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'StudyBuddy',
    description: DESCRIPTION,
  },
}

export const viewport: Viewport = {viewportFit: 'cover', themeColor: '#f7f2e8'}

export default function RootLayout({
  children,
}: Readonly<{children: React.ReactNode}>) {
  return (
    <html
      lang="en"
      className={`${workSans.variable} ${fugazOne.variable} ${spaceMono.variable} h-full`}
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

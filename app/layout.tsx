import {Analytics} from '@vercel/analytics/next'
import type {Metadata, Viewport} from 'next'
import {Fraunces, Public_Sans, Space_Mono} from 'next/font/google'
import {SessionProvider} from 'next-auth/react'

import {AutoRefresh} from '@/components/client'
import {appBaseUrl} from '@/lib/api'

import './globals.css'

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

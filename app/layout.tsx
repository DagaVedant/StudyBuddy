import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Archivo, Geist } from 'next/font/google'
import { SessionProvider } from 'next-auth/react'
import { ViewTransition } from 'react'

import AppTopbar from '@/components/app-topbar'
import AutoRefresh from '@/components/auto-refresh'
import { themeInitScript } from '@/components/theme-toggle'
import { appBaseUrl } from '@/lib/app-url'

import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

// One weight, because one weight is painted: the hero wordmark, at 800. This
// is declared in the root layout, so next/font preloads every weight listed
// here on every route; three files were being fetched to use one.
const archivo = Archivo({
  variable: '--font-archivo',
  subsets: ['latin'],
  weight: ['800'],
})

export const metadata: Metadata = {
  /*
   * Without this the generated OG card resolves against VERCEL_URL, which is
   * the deployment-specific host, and behind Deployment Protection a crawler
   * fetching it gets a 401, so the card silently fails to unfurl. The site's
   * own configured URL is the only one guaranteed to be public.
   */
  metadataBase: new URL(appBaseUrl()),
  title: 'StudyBuddy',
  description:
    'Turn finished practice worksheets into a record of what you actually know.',
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fcfcfd' },
    { media: '(prefers-color-scheme: dark)', color: '#22242a' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${archivo.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="flex min-h-full flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:outline-2 focus:outline-accent"
        >
          Skip to content
        </a>
        <SessionProvider>
          <AppTopbar />
          {/*
            Route changes crossfade the page body. `update` (not enter/exit) is
            the right trigger: this wrapper persists across navigations, so what
            React sees is a mutation inside it rather than a mount. `default`
            stays "none" so nothing fires on unrelated transitions; Suspense
            reveals, router.refresh() after a review rating, and so on.

            The topbar sits outside this on purpose: it is never snapshotted, so
            it stays put while the content underneath it changes.
          */}
          <ViewTransition default="none" update="page">
            <div id="main" className="flex min-w-0 flex-1 flex-col">
              {children}
            </div>
          </ViewTransition>
        </SessionProvider>
        <AutoRefresh />
        <Analytics />
      </body>
    </html>
  )
}

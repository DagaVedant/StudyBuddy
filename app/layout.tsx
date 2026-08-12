import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Archivo, Geist } from 'next/font/google'
import { SessionProvider } from 'next-auth/react'

import AutoRefresh from '@/components/auto-refresh'
import { themeInitScript } from '@/lib/theme-script'
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
  /*
   * `opengraph-image.tsx` renders a 1200x630 card, and without a `twitter:card`
   * of `summary_large_image` every Twitter-family unfurler falls back to
   * `summary`, which crops that card into a small square thumbnail beside the
   * text. The image was being generated correctly and then thrown away by the
   * thing it was generated for.
   *
   * The `openGraph` block is separate from the fields above it because Next
   * only infers `og:title` and `og:description` from them, not `og:type`,
   * `og:url` or `og:siteName`, and a card with no type is treated as a bare
   * website by some scrapers and skipped by others.
   */
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
  /*
   * Lays the page out edge to edge behind a notch or a home indicator, which
   * is what makes `env(safe-area-inset-*)` report anything but zero. Without
   * it the browser letterboxes the page and every safe-area rule in the
   * stylesheet is a no-op, which is what the one already in the markup screen
   * had been.
   */
  viewportFit: 'cover',
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
        {/*
          The `#main` wrapper this skip link points at is rendered by each route
          group rather than here, in `components/main-region.tsx`. It has to sit
          below the topbar, and the topbar belongs to the (app) group, which
          nests inside this layout.
        */}
        <SessionProvider>{children}</SessionProvider>
        <AutoRefresh />
        <Analytics />
      </body>
    </html>
  )
}

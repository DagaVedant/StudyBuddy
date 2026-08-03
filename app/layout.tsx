import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Archivo, Geist } from 'next/font/google'
import { SessionProvider } from 'next-auth/react'

import AppTopbar from '@/components/app-topbar'
import { themeInitScript } from '@/components/theme-toggle'

import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const archivo = Archivo({
  variable: '--font-archivo',
  subsets: ['latin'],
  weight: ['700', '800', '900'],
})

export const metadata: Metadata = {
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
        {}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="flex min-h-full flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:outline-2 focus:outline-accent"
        >
          Skip to content
        </a>
        {}
        <SessionProvider>
          <AppTopbar />
          <div id="main" className="flex min-w-0 flex-1 flex-col">
            {children}
          </div>
        </SessionProvider>
        <Analytics />
      </body>
    </html>
  )
}

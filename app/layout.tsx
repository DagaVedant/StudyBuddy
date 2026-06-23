import type { Metadata, Viewport } from 'next'
import { Geist } from 'next/font/google'
import { SessionProvider } from 'next-auth/react'

import AppSidebar from '@/components/app-sidebar'
import { themeInitScript } from '@/components/theme-toggle'

import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
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
      className={`${geistSans.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        {/* Applies the stored theme before first paint; without it every load
            flashes the system theme before the user's choice takes effect. */}
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
          <div className="flex min-h-dvh flex-col lg:flex-row">
            <AppSidebar />
            <div id="main" className="flex min-w-0 flex-1 flex-col">
              {children}
            </div>
          </div>
        </SessionProvider>
      </body>
    </html>
  )
}

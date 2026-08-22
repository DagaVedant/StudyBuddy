import Link from 'next/link'

import {MainRegion} from '@/components/page-head'

export default function PublicLayout({children}: {children: React.ReactNode}) {
  return (
    <>
      <MainRegion>{children}</MainRegion>

      <footer className="mx-auto w-full max-w-2xl px-6 pb-10 text-sm text-muted">
        <nav aria-label="Policies" className="flex gap-4">
          <Link href="/privacy" className="underline underline-offset-2 hover:text-fg">
            Privacy
          </Link>
          <Link href="/terms" className="underline underline-offset-2 hover:text-fg">
            Terms
          </Link>
        </nav>
      </footer>
    </>
  )
}

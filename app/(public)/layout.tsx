import Link from 'next/link'

import {MainRegion} from '@/components/page-head'

export default function PublicLayout({children}: {children: React.ReactNode}) {
  return (
    <>
      <MainRegion>{children}</MainRegion>

      <footer className="w-full px-6 pb-10 text-sm text-muted">
        <nav aria-label="Policies" className="flex justify-center gap-4">
          <Link href="/privacy" className="hover:text-fg">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-fg">
            Terms
          </Link>
          <Link href="/dmca" className="hover:text-fg">
            Copyright
          </Link>
        </nav>
      </footer>
    </>
  )
}

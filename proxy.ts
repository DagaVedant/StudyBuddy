import { NextResponse } from 'next/server'

import { auth } from '@/auth'

/**
 * Next 16 renamed `middleware` to `proxy` and pinned it to the Node runtime,
 * which is why the full Auth.js config (Drizzle + bcrypt) can run here.
 */
export const proxy = auth((req) => {
  const { pathname } = req.nextUrl
  const session = req.auth

  const isAuthed = Boolean(session?.user)
  const isAdmin = session?.user?.role === 'admin'

  if (pathname.startsWith('/admin')) {
    if (!isAuthed) return NextResponse.redirect(new URL('/signin', req.nextUrl))
    // Admin is an operations role only (spec §2.1) — 404 rather than 403 so the
    // console isn't discoverable by probing.
    if (!isAdmin) return NextResponse.rewrite(new URL('/not-found', req.nextUrl))
    return NextResponse.next()
  }

  if (!isAuthed) {
    const signin = new URL('/signin', req.nextUrl)
    signin.searchParams.set('next', pathname)
    return NextResponse.redirect(signin)
  }

  // The 13+ gate (spec §2): OAuth signups never supplied a date of birth, so
  // they land here until they do.
  if (!session?.user?.hasDob && pathname !== '/onboarding/age') {
    return NextResponse.redirect(new URL('/onboarding/age', req.nextUrl))
  }

  return NextResponse.next()
})

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/upload/:path*',
    '/worksheets/:path*',
    '/topics/:path*',
    '/review/:path*',
    '/settings/:path*',
    '/admin/:path*',
    '/onboarding/:path*',
  ],
}

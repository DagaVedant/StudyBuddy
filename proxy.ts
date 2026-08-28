import {NextResponse} from 'next/server'

import {auth} from '@/auth'

export const proxy = auth((req) => {
  const {pathname, search} = req.nextUrl
  const session = req.auth

  let isAuthed = false
  let isAdmin = false
  let hasDob = false
  let hasAcceptedTerms = false

  if (session && session.user) {
    isAuthed = true

    if (session.user.role === 'admin') isAdmin = true
    if (session.user.hasDob) hasDob = true
    if (session.user.hasAcceptedTerms) hasAcceptedTerms = true
  }

  if (pathname.startsWith('/admin')) {
    if (!isAuthed) return NextResponse.redirect(new URL('/signin', req.nextUrl))
    if (!isAdmin) return NextResponse.rewrite(new URL('/not-found', req.nextUrl))

    return NextResponse.next()
  }

  if (!isAuthed) {
    const signin = new URL('/signin', req.nextUrl)
    signin.searchParams.set('next', pathname + search)

    return NextResponse.redirect(signin)
  }

  if (!hasDob && pathname !== '/onboarding/age') {
    return NextResponse.redirect(new URL('/onboarding/age', req.nextUrl))
  }

  if (!hasAcceptedTerms && pathname !== '/onboarding/terms') {
    return NextResponse.redirect(new URL('/onboarding/terms', req.nextUrl))
  }

  return NextResponse.next()
})

export const config = {
  matcher: [
    '/dashboard/:path*', '/upload/:path*', '/worksheets/:path*', '/topics/:path*',
    '/review/:path*', '/settings/:path*', '/admin/:path*', '/onboarding/:path*',
  ],
}

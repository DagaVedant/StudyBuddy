import {NextResponse} from 'next/server'

import {auth} from '@/auth'

export const proxy = auth((req) => {
  const {pathname} = req.nextUrl
  const session = req.auth

  const isAuthed = Boolean(session?.user)
  const isAdmin = session?.user?.role === 'admin'

  if (pathname.startsWith('/admin')) {
    if (!isAuthed) return NextResponse.redirect(new URL('/signin', req.nextUrl))
    if (!isAdmin) return NextResponse.rewrite(new URL('/not-found', req.nextUrl))
    return NextResponse.next()
  }

  if (!isAuthed) {
    const signin = new URL('/signin', req.nextUrl)
    signin.searchParams.set('next', pathname)
    return NextResponse.redirect(signin)
  }

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

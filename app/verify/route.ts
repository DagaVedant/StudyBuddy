import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { verifyEmail } from '@/lib/auth/actions'

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  const email = request.nextUrl.searchParams.get('email')

  const target = new URL('/signin', request.nextUrl)

  if (!token || !email) {
    target.searchParams.set('error', 'InvalidVerificationLink')
    return NextResponse.redirect(target)
  }

  const ok = await verifyEmail(email.toLowerCase(), token)
  target.searchParams.set(ok ? 'verified' : 'error', ok ? '1' : 'VerificationExpired')

  return NextResponse.redirect(target)
}

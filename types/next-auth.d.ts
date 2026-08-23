import type { DefaultSession } from 'next-auth'

type Role = 'student' | 'admin'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: Role
      hasDob: boolean
      hasAcceptedTerms: boolean
    } & DefaultSession['user']
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    id?: string
    role?: Role
    hasDob?: boolean
    hasAcceptedTerms?: boolean
  }
}

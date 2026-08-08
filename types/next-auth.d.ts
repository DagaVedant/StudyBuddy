import type { DefaultSession } from 'next-auth'

type Role = 'student' | 'admin'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: Role
      /** False until the 13+ gate has been satisfied (spec §2). */
      hasDob: boolean
    } & DefaultSession['user']
  }
}

// next-auth/jwt only re-exports this module, so the augmentation has to target
// where the JWT interface is actually declared.
declare module '@auth/core/jwt' {
  interface JWT {
    id?: string
    role?: Role
    hasDob?: boolean
  }
}

import { DrizzleAdapter } from '@auth/drizzle-adapter'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import Google from 'next-auth/providers/google'

import { accountMayBeAdmin } from '@/lib/auth/admin'
import { db } from '@/lib/db'
import { accounts, sessions, users, verificationTokens } from '@/lib/db/schema'
import { signInThrottled } from '@/lib/auth/admin'

type Role = 'student' | 'admin'

interface UserClaims {
  role: Role
  hasDob: boolean
}

async function syncUserClaims(userId: string): Promise<UserClaims> {
  const [row] = await db
    .select({
      email: users.email,
      role: users.role,
      dob: users.dob,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!row) {
    return { role: 'student', hasDob: false }
  }

  const shouldBeAdmin = await accountMayBeAdmin(db, userId, row.email)
  const desiredRole: Role = shouldBeAdmin ? 'admin' : 'student'

  if (row.role !== desiredRole) {
    await db.update(users).set({ role: desiredRole }).where(eq(users.id, userId))
  }

  return {
    role: desiredRole,
    hasDob: row.dob !== null,
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),

  session: { strategy: 'jwt' },

  trustHost: true,

  pages: {
    signIn: '/signin',
    error: '/signin',
  },

  providers: [
    Google({
      allowDangerousEmailAccountLinking: false,
    }),

    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, request) {
        const email = String(credentials?.email ?? '')
          .trim()
          .toLowerCase()
        const password = String(credentials?.password ?? '')

        if (!email || !password) return null

        const headers = request instanceof Request ? request.headers : new Headers()
        if (await signInThrottled(db, headers, email)) return null

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1)

        if (!user?.passwordHash) return null

        const valid = await bcrypt.compare(password, user.passwordHash)
        if (!valid) return null

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        }
      },
    }),
  ],

  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === 'google' && user.id) {
        const verified = (profile as { email_verified?: boolean } | undefined)
          ?.email_verified
        if (verified) {
          await db
            .update(users)
            .set({ emailVerified: new Date() })
            .where(eq(users.id, user.id))
        }
      }
      return true
    },

    async jwt({ token, user, trigger }) {
      if (user?.id) token.id = user.id

      const shouldRefresh = Boolean(user) || trigger === 'update' || !token.role

      if (token.id && shouldRefresh) {
        const claims = await syncUserClaims(token.id)
        token.role = claims.role
        token.hasDob = claims.hasDob
      }

      return token
    },

    async session({ session, token }) {
      if (token.id) session.user.id = token.id
      session.user.role = token.role ?? 'student'
      session.user.hasDob = token.hasDob ?? false
      return session
    },
  },
})

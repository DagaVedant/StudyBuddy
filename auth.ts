import { DrizzleAdapter } from '@auth/drizzle-adapter'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import Google from 'next-auth/providers/google'

import { isAdminEmail } from '@/lib/auth/policy'
import { db } from '@/lib/db'
import { accounts, sessions, users, verificationTokens } from '@/lib/db/schema'

type Role = 'student' | 'admin'
type AiTier = 'trial' | 'free' | 'cloud' | 'ollama'

interface UserClaims {
  role: Role
  aiTier: AiTier
  hasDob: boolean
}

/**
 * Reads the account's current claims, re-deriving admin status from
 * ADMIN_EMAILS on every login so that removing an email demotes the account
 * (spec §2.1). Admin additionally requires a verified email; otherwise anyone
 * who registers an unverified account at an admin address would inherit it.
 */
async function syncUserClaims(userId: string): Promise<UserClaims> {
  const [row] = await db
    .select({
      email: users.email,
      emailVerified: users.emailVerified,
      role: users.role,
      aiTier: users.aiTier,
      dob: users.dob,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!row) {
    return { role: 'student', aiTier: 'trial', hasDob: false }
  }

  const shouldBeAdmin = Boolean(row.emailVerified) && isAdminEmail(row.email)
  const desiredRole: Role = shouldBeAdmin ? 'admin' : 'student'

  if (row.role !== desiredRole) {
    await db.update(users).set({ role: desiredRole }).where(eq(users.id, userId))
  }

  return {
    role: desiredRole,
    aiTier: row.aiTier as AiTier,
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

  // The Credentials provider cannot use database sessions, so the whole app
  // runs on JWT sessions. The adapter still handles OAuth account linking.
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
      async authorize(credentials) {
        const email = String(credentials?.email ?? '')
          .trim()
          .toLowerCase()
        const password = String(credentials?.password ?? '')

        if (!email || !password) return null

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1)

        // Account exists but was created via OAuth, so no password to check.
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
      // Google has already verified the address; mirror that so the account
      // isn't stuck behind our own verification gate.
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

      // Refresh on login and on an explicit session update; otherwise trust the
      // token so we aren't hitting the DB on every request.
      const shouldRefresh = Boolean(user) || trigger === 'update' || !token.role

      if (token.id && shouldRefresh) {
        const claims = await syncUserClaims(token.id)
        token.role = claims.role
        token.aiTier = claims.aiTier
        token.hasDob = claims.hasDob
      }

      return token
    },

    async session({ session, token }) {
      if (token.id) session.user.id = token.id
      session.user.role = token.role ?? 'student'
      session.user.aiTier = token.aiTier ?? 'trial'
      session.user.hasDob = token.hasDob ?? false
      return session
    },
  },
})

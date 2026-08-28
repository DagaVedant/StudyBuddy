import {DrizzleAdapter} from '@auth/drizzle-adapter'
import bcrypt from 'bcryptjs'
import {eq} from 'drizzle-orm'
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'

import {accountMayBeAdmin, signInThrottled} from '@/lib/auth/identity'
import {db} from '@/lib/db'
import {accounts, sessions, users, verificationTokens} from '@/lib/schema'

type Role = 'student' | 'admin'

type UserClaims = {
  role: Role
  hasDob: boolean
  hasAcceptedTerms: boolean
}

async function syncUserClaims(userId: string): Promise<UserClaims> {
  const [row] = await db
    .select({
      email: users.email,
      role: users.role,
      dob: users.dob,
      termsAcceptedAt: users.termsAcceptedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!row) {
    return {role: 'student', hasDob: false, hasAcceptedTerms: false}
  }

  const shouldBeAdmin = await accountMayBeAdmin(db, userId, row.email)
  let desiredRole: Role = 'student'
  if (shouldBeAdmin) desiredRole = 'admin'

  if (row.role !== desiredRole) {
    await db.update(users).set({role: desiredRole}).where(eq(users.id, userId))
  }

  return {
    role: desiredRole,
    hasDob: row.dob !== null,
    hasAcceptedTerms: row.termsAcceptedAt !== null,
  }
}

export const {handlers, auth, signIn, signOut} = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),

  session: {strategy: 'jwt'},

  trustHost: true,

  pages: {signIn: '/signin', error: '/signin'},

  providers: [
    Credentials({
      credentials: {
        email: {label: 'Email', type: 'email'},
        password: {label: 'Password', type: 'password'},
      },
      async authorize(credentials, request) {
        let email = ''
        let password = ''

        if (credentials) {
          if (credentials.email) email = String(credentials.email).trim().toLowerCase()
          if (credentials.password) password = String(credentials.password)
        }

        if (!email || !password) return null

        let headers = new Headers()
        if (request instanceof Request) headers = request.headers
        if (await signInThrottled(db, headers, email)) return null

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1)

        if (!user || !user.passwordHash) return null

        const valid = await bcrypt.compare(password, user.passwordHash)
        if (!valid) return null

        return {id: user.id, email: user.email, name: user.name, image: user.image}
      },
    }),
  ],

  callbacks: {
    async jwt({token, user, trigger}) {
      if (user && user.id) token.id = user.id

      const shouldRefresh = Boolean(user) || trigger === 'update' || !token.role

      if (token.id && shouldRefresh) {
        const claims = await syncUserClaims(token.id)
        token.role = claims.role
        token.hasDob = claims.hasDob
        token.hasAcceptedTerms = claims.hasAcceptedTerms
      }

      return token
    },

    async session({session, token}) {
      if (token.id) session.user.id = token.id
      session.user.role = 'student'
      if (token.role) session.user.role = token.role

      session.user.hasDob = false
      if (token.hasDob) session.user.hasDob = true

      session.user.hasAcceptedTerms = false
      if (token.hasAcceptedTerms) session.user.hasAcceptedTerms = true
      return session
    },
  },
})

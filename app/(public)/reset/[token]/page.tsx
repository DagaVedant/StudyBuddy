import Link from 'next/link'

import {findResetTarget} from '@/lib/auth/identity'
import {db} from '@/lib/db'

import ResetForm from './reset-form'

export const metadata = {title: 'Set a new password · StudyBuddy'}

type Params = {params: Promise<{token: string}>}

export default async function ResetPasswordPage({params}: Params) {
  const {token} = await params

  const target = await findResetTarget(db, token)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>

      {target ? (
        <>
          <p className="hint text-pretty">
            This link works once. Pick something you have not used elsewhere.
          </p>
          <ResetForm token={token} />
        </>
      ) : (
        <>
          <p className="hint text-pretty">
            That link has expired or has already been used. Links last an hour.
          </p>
          <Link href="/forgot" className="btn btn-primary mt-6">
            Send me another
          </Link>
        </>
      )}
    </main>
  )
}

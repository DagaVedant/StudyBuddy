import Link from 'next/link'

export const metadata = {title: 'Not Found · StudyBuddy'}

export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
      <p className="eyebrow">404</p>
      <h1 className="mt-2 text-balance text-2xl font-semibold tracking-tight">
        We could not find that
      </h1>
      <p className="hint text-pretty">
        The page may have moved, or it may belong to another account.
      </p>

      <p className="mt-6">
        <Link href="/dashboard" className="text-accent">
          Go to your dashboard
        </Link>
      </p>
    </main>
  )
}

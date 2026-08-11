/**
 * The fallback for any route without a closer one.
 *
 * There was no `loading.tsx` anywhere, which means there was no Suspense
 * boundary anywhere, which means the browser sat on the old page until the new
 * one was ready. The dashboard runs five queries and the worksheet review page
 * runs five plus the taxonomy; on a cold serverless function against a remote
 * database that is a visible stall in which the click appears to have done
 * nothing at all.
 *
 * Deliberately vague, because it stands in for pages of different shapes. The
 * routes whose shape is worth matching have their own.
 */
export default function Loading() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading"
      className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6"
    >
      <div className="skeleton h-8 w-56" />
      <div className="skeleton mt-3 h-4 w-80 max-w-full" />

      <div className="mt-8 space-y-3">
        <div className="skeleton h-28" />
        <div className="skeleton h-28" />
      </div>
    </main>
  )
}

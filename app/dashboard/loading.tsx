/**
 * The dashboard's own shape: four tiles, then the panels under them.
 *
 * Worth matching rather than falling through to the generic one because this
 * page runs five queries in parallel and is the app's landing screen after
 * sign-in, so it is the stall a student meets most often.
 */
export default function Loading() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading your dashboard"
      className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="skeleton h-8 w-40" />
        <div className="skeleton h-11 w-44" />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => (
          <div key={tile} className="skeleton h-[4.75rem] rounded-2xl" />
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="skeleton h-56 rounded-2xl lg:col-span-2" />
        <div className="skeleton h-40 rounded-2xl" />
        <div className="skeleton h-40 rounded-2xl" />
      </div>
    </main>
  )
}

export default function Loading() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading"
      className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6"
    >
      <p className="text-lg text-muted">Loading…</p>
    </main>
  )
}

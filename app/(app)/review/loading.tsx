export default function Loading() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading your review queue"
      className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6"
    >
      <div className="skeleton h-8 w-32" />
      <div className="skeleton mt-3 h-4 w-64 max-w-full" />

      <div className="skeleton mt-6 h-1.5" />

      <div className="card mt-6 space-y-3 p-4">
        <div className="skeleton h-3 w-40" />
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-4/5" />
        <div className="skeleton h-11" />
        <div className="skeleton h-11" />
      </div>
    </main>
  )
}

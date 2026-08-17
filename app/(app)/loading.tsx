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

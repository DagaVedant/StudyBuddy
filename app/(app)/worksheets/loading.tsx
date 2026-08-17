export default function Loading() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading your worksheets"
      className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-11 w-44" />
      </div>
      <div className="skeleton mt-4 h-4 w-72 max-w-full" />

      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((card) => (
          <li key={card} className="skeleton h-72 rounded-2xl" />
        ))}
      </ul>
    </main>
  )
}

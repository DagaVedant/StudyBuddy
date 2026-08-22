export function Underline({className = ''}: {className?: string}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 300 14"
      preserveAspectRatio="none"
      fill="none"
      className={`pointer-events-none absolute left-0 top-[92%] h-[0.26em] w-full ${className}`}
    >
      <path
        d="M3 8.5C52 4.2 104 10.4 152 6.1 200 1.8 249 9.7 297 5"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Tick({className = ''}: {className?: string}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3.4 12.8C5.1 14.1 6.6 16 8.1 18.6 11.6 12.1 15.9 6.6 21 2.6" />
    </svg>
  )
}

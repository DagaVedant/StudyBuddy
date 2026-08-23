export function Note({
  labelledBy,
  className = '',
  children,
}: {
  labelledBy?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={labelledBy} className={`card card-fold p-5 ${className}`}>
      {children}
    </section>
  )
}

export function SectionHead({id, title}: {id: string; title: string}) {
  return (
    <h2 id={id} className="mb-4 font-sans text-lg font-bold tracking-tight sm:text-xl">
      {title}
    </h2>
  )
}

export function Callout({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Note>
      <p className="eyebrow">{label}</p>
      <div className="mt-2">{children}</div>
    </Note>
  )
}

export function MarginNote({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Note>
      <h2 className="eyebrow">{label}</h2>
      <div className="mt-2">{children}</div>
    </Note>
  )
}

export function PageFoot({running}: {running: string}) {
  return (
    <footer className="mt-14">
      <p className="eyebrow">{running}</p>
    </footer>
  )
}

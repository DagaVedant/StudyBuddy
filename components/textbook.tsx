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
    <section
      aria-labelledby={labelledBy}
      className={`border border-rule bg-surface p-5 ${className}`}
    >
      {children}
    </section>
  )
}

export function SectionHead({ id, title }: { id: string; title: string }) {
  return (
    <div className="mb-4 border-b border-fg/20 pb-2">
      <h2
        id={id}
        className="font-display text-lg font-semibold tracking-tight sm:text-xl"
      >
        {title}
      </h2>
    </div>
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

export function PageFoot({ running }: { running: string }) {
  return (
    <footer className="mt-14 border-t border-rule-heavy pt-3">
      <p className="eyebrow">{running}</p>
    </footer>
  )
}

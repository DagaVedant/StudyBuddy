export default function PageHead({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow?: string
  title: React.ReactNode
  lede?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="max-w-2xl">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="mt-1.5 text-balance font-display text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
          {title}
        </h1>
        {lede && <p className="mt-3 text-pretty text-muted">{lede}</p>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  )
}

export function MainRegion({children}: {children: React.ReactNode}) {
  return (
    <div
      id="main"
      tabIndex={-1}
      className="flex min-w-0 flex-1 flex-col bg-bg/90 outline-none"
    >
      {children}
    </div>
  )
}

export function PageHead({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string
  title: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="max-w-2xl">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className="mt-1.5 text-2xl font-bold sm:text-3xl">
            {title}
          </h1>
        </div>
        {children && <div className="shrink-0">{children}</div>}
      </div>
      <div className="mt-6 border-b-2 border-rule-heavy" />
    </>
  )
}

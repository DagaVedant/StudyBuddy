export default function MainRegion({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
      {children}
    </div>
  )
}

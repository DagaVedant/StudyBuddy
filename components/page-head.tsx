/*
 * The top of a page.
 *
 * Twenty pages used to open with a byte-identical h1,
 * `text-balance text-2xl font-semibold tracking-tight`, which is what a
 * template looks like from the outside. This does not fix that by giving
 * every page a different treatment; a masthead that changes shape per page
 * is not craft, it is inconsistency. It fixes it by making the treatment
 * good once and pushing the differences into what each page actually says.
 *
 * So the rule the app follows is about words, not CSS:
 *
 *   index pages take a noun     Topics, Your worksheets
 *   task pages take a verb      Upload a worksheet, Check your questions
 *   the dashboard and a review
 *   sitting take a sentence,    "12 questions are due for review today"
 *   because those two pages
 *   have an answer to give
 *
 * A page whose title would only repeat its nav item has nothing to say and
 * should pass a lede that does the work instead.
 */
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
      {/* Actions sit on the baseline of the title rather than under the lede,
          so the eye finds them without the lede having to be read first. */}
      {children && <div className="shrink-0">{children}</div>}
    </div>
  )
}

import { ViewTransition } from 'react'

/**
 * The page body: the skip link's target, and what crossfades on navigation.
 *
 * This lived in the root layout until the topbar moved into the (app) route
 * group. A group layout nests *inside* the root one, which put the topbar
 * inside this wrapper, and both of the things it does quietly stopped being
 * true: "Skip to content" landed above the nav it exists to skip, and the
 * topbar started animating with the content it is supposed to stay still
 * behind. So each group renders this itself, below its own chrome.
 */
export default function MainRegion({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /*
      Route changes crossfade the page body. `update` (not enter/exit) is the
      right trigger: this wrapper persists across navigations, so what React
      sees is a mutation inside it rather than a mount. `default` stays "none"
      so nothing fires on unrelated transitions; Suspense reveals,
      router.refresh() after a review rating, and so on.
    */
    <ViewTransition default="none" update="page">
      {/*
        `tabIndex={-1}` is what makes the skip link actually skip. A plain
        `<div id="main">` is not focusable, so following the link moved the
        viewport and left focus on the link: the next Tab went to the topbar,
        which is the thing being skipped. Focus lands here now, just outside
        each page's own `<main>`, and Tab continues into the content.

        No focus ring on it, deliberately. It is not reachable by Tab and cannot
        be operated, so an outline around the entire page would be feedback for
        something the reader cannot act on; the first real control they reach
        shows its own.
      */}
      <div id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
        {children}
      </div>
    </ViewTransition>
  )
}

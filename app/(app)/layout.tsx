import AppTopbar from '@/components/app-topbar'
import MainRegion from '@/components/main-region'

/**
 * The signed-in shell, and the reason it is a route group.
 *
 * `AppTopbar` calls `auth()`, which reads cookies. A layout that reads cookies
 * opts every route beneath it out of static rendering, and this one used to be
 * the root layout, so all 39 routes built dynamic. That included the three that
 * have nothing to personalise: the pitch, sign in and sign up. The marketing
 * page in particular is the one most likely to be reached by someone with no
 * cookie at all, and it could not be served from a CDN.
 *
 * The group is what separates them. Everything under here is behind the proxy's
 * matcher and needs a session anyway, so nothing is lost by it being dynamic.
 * The pages in (public) prerender.
 *
 * The topbar is outside `MainRegion` rather than inside it so that the skip
 * link clears the nav and the topbar does not animate with the page.
 */
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <AppTopbar />
      <MainRegion>{children}</MainRegion>
    </>
  )
}

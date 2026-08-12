import MainRegion from '@/components/main-region'

/**
 * The pages anyone can reach: the pitch, sign in, sign up.
 *
 * No topbar and, more to the point, nothing here reads cookies, which is what
 * lets all three prerender. Anything added to this group that calls `auth()`
 * takes that away for the whole group, silently: the build output is the place
 * it shows up, as an f beside a route that used to have a circle.
 */
export default function PublicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <MainRegion>{children}</MainRegion>
}

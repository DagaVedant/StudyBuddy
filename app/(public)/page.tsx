import DashboardPreview from '@/components/dashboard-preview'
import Hero from '@/components/hero'

import HomeCta from './home-cta'

/**
 * Static, and worth keeping that way.
 *
 * Nothing here is personalised except the pair of buttons, which `HomeCta`
 * decides on the client. Anything that reads cookies in this file, `auth()`
 * most of all, takes the whole page back to being rendered per request.
 */
export default function HomePage() {
  return (
    <main>
      <Hero>
        <HomeCta />
      </Hero>

      <DashboardPreview />
    </main>
  )
}

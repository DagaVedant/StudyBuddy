import DashboardPreview from '@/components/dashboard-preview'
import Hero from '@/components/hero'

import HomeCta from './home-cta'

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

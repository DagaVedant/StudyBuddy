import {DashboardPreview} from '@/components/ui'
import {Hero} from '@/components/ui'

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

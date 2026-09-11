import {Hero} from '@/components/hero'
import {UsageNotice} from '@/components/usage-notice'
import {operatorCloudEnabled} from '@/lib/ai/resolve'
import {operatorUsage} from '@/lib/ai/usage'
import {db} from '@/lib/db'

import HomeCta from './home-cta'

export const revalidate = 60

export default async function HomePage() {
  let usage = null
  if (operatorCloudEnabled()) usage = await operatorUsage(db)

  return (
    <main>
      <Hero>
        {usage && (
          <div className="mt-8 w-full max-w-xl">
            <UsageNotice usage={usage} samplesHref="/upload" />
          </div>
        )}
        <HomeCta />
      </Hero>
    </main>
  )
}

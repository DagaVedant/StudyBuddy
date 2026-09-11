import Link from 'next/link'

import {type OperatorUsage} from '@/lib/ai/usage'

export function UsageNotice({usage, samplesHref}: {usage: OperatorUsage; samplesHref: string}) {
  if (usage.level === 'ok') return null

  let lead = 'Busy day. '
  let body =
    'The free model that reads worksheets allows ' +
    usage.cap +
    ' reads a day and ' +
    usage.calls +
    ' are used, so it may run out before midnight UTC. If a worksheet comes back unread, ' +
    'that is the limit, not the app.'

  if (usage.level === 'exhausted') {
    lead = 'Free reads are used up for today. '
    body =
      'The free model that reads worksheets allows ' +
      usage.cap +
      ' reads a day and they are gone until midnight UTC. Anything uploaded now waits ' +
      'for you to add its questions by hand.'
  }

  return (
    <div
      role="status"
      className="rounded-xl border border-caution/40 bg-caution/10 px-3 py-2 text-left text-sm text-caution"
    >
      <p className="text-pretty">
        <strong className="font-medium">{lead}</strong>
        {body} The{' '}
        <Link href={samplesHref} className="underline">
          sample worksheets
        </Link>{' '}
        cost no reads and always work.
      </p>
    </div>
  )
}

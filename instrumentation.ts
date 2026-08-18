import type { Instrumentation } from 'next'

import { reportError } from '@/lib/observability/report-error'

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  await reportError({
    message: err instanceof Error ? err.message : String(err),
    digest:
      typeof err === 'object' && err !== null && 'digest' in err
        ? String((err as { digest?: unknown }).digest)
        : undefined,
    path: request.path,
    method: request.method,
    routeType: context.routeType,
  })
}

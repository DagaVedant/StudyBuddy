import type {Instrumentation} from 'next'

import {reportError} from '@/lib/mail'

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  const hasDigest = typeof err === 'object' && err !== null && 'digest' in err

  await reportError({
    message: err instanceof Error ? err.message : String(err),
    digest: hasDigest ? String((err as {digest?: unknown}).digest) : undefined,
    path: request.path,
    method: request.method,
    routeType: context.routeType,
  })
}

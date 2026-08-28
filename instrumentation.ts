import type {Instrumentation} from 'next'

import {reportError} from '@/lib/mail'

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  let message = String(err)
  if (err instanceof Error) message = err.message

  let digest = undefined
  if (typeof err === 'object' && err !== null && 'digest' in err) {
    digest = String((err as {digest?: unknown}).digest)
  }

  await reportError({
    message: message,
    digest: digest,
    path: request.path,
    method: request.method,
    routeType: context.routeType,
  })
}

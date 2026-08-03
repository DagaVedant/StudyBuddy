/**
 * Cancelling an upload is a deliberate user action, not a failure, so it gets
 * its own error type: callers can tell it apart from a genuine problem and
 * report it differently.
 */
export class CancelledError extends Error {
  constructor(message = 'Upload cancelled.') {
    super(message)
    this.name = 'CancelledError'
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof CancelledError
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError()
}

/**
 * Races work that cannot itself be interrupted against the cancel signal.
 *
 * The underlying task keeps running — this only stops us waiting on it — so
 * callers that use this should also stop the real work where they can (by
 * tearing down the worker that owns it, say). The listener is removed once
 * either side settles so long loops do not accumulate them.
 */
export function untilCancelled<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new CancelledError())

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError())
    signal.addEventListener('abort', onAbort, { once: true })

    // Detached in the same turn the work settles, rather than in a trailing
    // .finally() — that leaves the listener attached for an extra microtask
    // after the caller has already moved on.
    const cleanup = () => signal.removeEventListener('abort', onAbort)

    work.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

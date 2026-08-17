export class CancelledError extends Error {
  constructor(message = 'Upload cancelled.') {
    super(message)
    this.name = 'CancelledError'
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError()
}

export function untilCancelled<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new CancelledError())

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError())
    signal.addEventListener('abort', onAbort, { once: true })

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

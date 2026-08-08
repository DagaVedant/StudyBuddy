import { describe, expect, it, vi } from 'vitest'

import { CancelledError, throwIfCancelled, untilCancelled } from '@/lib/client/abort'

describe('throwIfCancelled', () => {
  it('does nothing without a signal', () => {
    expect(() => throwIfCancelled()).not.toThrow()
  })

  it('does nothing while the signal is live', () => {
    const controller = new AbortController()
    expect(() => throwIfCancelled(controller.signal)).not.toThrow()
  })

  it('throws a CancelledError once aborted', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => throwIfCancelled(controller.signal)).toThrow(CancelledError)
  })
})

describe('untilCancelled', () => {
  it('passes the value through when nothing is cancelled', async () => {
    const controller = new AbortController()
    await expect(untilCancelled(Promise.resolve('ok'), controller.signal)).resolves.toBe(
      'ok',
    )
  })

  it('passes the value through with no signal at all', async () => {
    await expect(untilCancelled(Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('rejects immediately if the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      untilCancelled(new Promise(() => {}), controller.signal),
    ).rejects.toBeInstanceOf(CancelledError)
  })

  // The point of the whole exercise: a step that will not finish on its own
  // must not hold the cancel up.
  it('rejects on abort without waiting for the work to settle', async () => {
    const controller = new AbortController()
    let settled = false

    // Stands in for a page render or an OCR pass: in flight, and not about to
    // finish on its own.
    const neverSettles = new Promise<string>(() => {}).then((value) => {
      settled = true
      return value
    })

    const raced = untilCancelled(neverSettles, controller.signal)
    void raced.catch(() => {})

    controller.abort()

    await expect(raced).rejects.toBeInstanceOf(CancelledError)
    expect(settled).toBe(false)
  })

  it('still surfaces a genuine failure from the work', async () => {
    const controller = new AbortController()
    const boom = new Error('render failed')

    await expect(untilCancelled(Promise.reject(boom), controller.signal)).rejects.toBe(
      boom,
    )
  })

  it('removes its abort listener so long loops do not accumulate them', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')

    await untilCancelled(Promise.resolve('ok'), controller.signal)

    expect(remove).toHaveBeenCalledTimes(1)
  })
})

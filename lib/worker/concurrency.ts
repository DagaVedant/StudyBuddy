/**
 * How many pages to read at once.
 *
 * Benchmarking a 58-page packet put 59% of wall time in decode and 38% in
 * prefill. Decode at one request in flight is bandwidth-bound and leaves the
 * card mostly idle between token reads, so overlapping it is close to free;
 * prefill already saturates. That caps the useful gain at roughly 1.7x however
 * many slots are opened, which is why this tops out low.
 *
 * A short worksheet stays sequential on purpose. Its whole run is under a
 * minute, the saving would be seconds, and every extra slot reserves its own
 * KV cache — memory that is far better spent making sure a long packet never
 * spills out of VRAM.
 */
export const PARALLEL_PAGE_THRESHOLD = 15
export const PARALLEL_QUESTION_THRESHOLD = 30

export interface WorkloadSize {
  pageCount: number
  /** What the student said the paper holds; null when they did not say. */
  expectedQuestionCount?: number | null
}

/**
 * Slots for a packet big enough to be worth overlapping.
 *
 * Two rather than three by default. Three fits only if the context reservation
 * stays small, and overflowing VRAM is not a gentle slowdown — an offloaded
 * model measured 9.2 tokens/sec against 79, so guessing high costs more than
 * guessing low ever wins. Raise it deliberately once a machine is known to
 * have the headroom.
 */
export function maxParallelPages(): number {
  const raw = Number(process.env.OLLAMA_MAX_PARALLEL_PAGES ?? 2)
  if (!Number.isFinite(raw)) return 2
  return Math.min(4, Math.max(1, Math.trunc(raw)))
}

export function concurrencyFor(work: WorkloadSize): number {
  const big =
    work.pageCount > PARALLEL_PAGE_THRESHOLD ||
    (work.expectedQuestionCount ?? 0) > PARALLEL_QUESTION_THRESHOLD

  return big ? maxParallelPages() : 1
}

/**
 * Runs `worker` over every item, `limit` at a time.
 *
 * Order of completion is not order of input, which is the whole point — a slot
 * that finishes early takes the next page rather than waiting on a slow one.
 * Callers must not assume results arrive in order.
 */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return

  const width = Math.max(1, Math.min(limit, items.length))
  let next = 0

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      await worker(items[index])
    }
  })

  await Promise.all(runners)
}

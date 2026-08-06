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

/**
 * Always one. Reading pages in parallel is disabled.
 *
 * It worked, and it was 1.7x faster on a 59 page packet with no loss of
 * extraction accuracy: 114 of 114 questions found, none missing, none
 * numbered past the end. What it broke was the order.
 *
 * A question's ordinal is assigned when its row is written, as one past the
 * highest already stored. Read pages one at a time and that matches the paper.
 * Read them two at a time and page 4 can finish before page 3, so page 4's
 * questions take the lower ordinals. The review screen sorts by ordinal and
 * shows it, so the student got a list in the wrong order, labelled with
 * numbers that matched nothing on the page in front of them.
 *
 * Ordering by printed number would paper over it, but plenty of worksheets
 * have no printed numbers at all, and ordinal is what those fall back to.
 * The real fix is to assign ordinals by page and position rather than by
 * arrival, and until that exists this stays off.
 */
export function concurrencyFor(_work: WorkloadSize): number {
  return 1
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

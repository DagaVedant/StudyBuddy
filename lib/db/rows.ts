export function unwrapDriverRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  return ((result as { rows?: T[] }).rows ?? []) as T[]
}

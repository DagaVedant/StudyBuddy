export function isUniqueViolation(error: unknown): boolean {
  const codes = [error, (error as { cause?: unknown } | null)?.cause]
  return codes.some((candidate) => (candidate as { code?: unknown } | null)?.code === '23505')
}

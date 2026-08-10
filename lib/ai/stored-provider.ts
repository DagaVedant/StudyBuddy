import { aiProvider } from '@/lib/db/schema'

import type { ProviderName } from './types'

/**
 * The provider names the `ai_provider` column will accept.
 *
 * Narrower than {@link ProviderName}, which also covers the three providers
 * that never reach the database: `mock`, `null`, and `operator_gpu`.
 */
export type StoredProvider = (typeof aiProvider.enumValues)[number]

/**
 * A provider name if the column can hold it, null if it cannot.
 *
 * Written as a guard against `aiProvider.enumValues` rather than a hand-kept
 * list because the alternative was `provider.name as 'anthropic'`: a cast that
 * claimed every provider was Anthropic to get past the type, and would have
 * gone on compiling if a name were added that the enum did not have. The
 * mismatch would then have surfaced as a constraint violation thrown out of an
 * insert, after the model had already been paid for.
 */
export function storedProvider(name: ProviderName): StoredProvider | null {
  return isStored(name) ? name : null
}

function isStored(name: string): name is StoredProvider {
  return (aiProvider.enumValues as readonly string[]).includes(name)
}

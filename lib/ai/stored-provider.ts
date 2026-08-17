import { aiProvider } from '@/lib/db/schema'

import type { ProviderName } from './types'

export type StoredProvider = (typeof aiProvider.enumValues)[number]

export function storedProvider(name: ProviderName): StoredProvider | null {
  return isStored(name) ? name : null
}

function isStored(name: string): name is StoredProvider {
  return (aiProvider.enumValues as readonly string[]).includes(name)
}

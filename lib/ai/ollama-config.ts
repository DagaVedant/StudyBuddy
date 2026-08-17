import { and, eq } from 'drizzle-orm'

import { userAiCredentials } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

export const OLLAMA_FALLBACK_MODEL = 'qwen2.5vl:7b'

export interface OllamaConfig {
  baseUrl: string
  visionModel: string
  textModel: string
}

export async function ollamaConfig(
  db: Db,
  userId: string,
): Promise<OllamaConfig | null> {
  const [credential] = await db
    .select({
      baseUrl: userAiCredentials.ollamaBaseUrl,
      visionModel: userAiCredentials.visionModelName,
      textModel: userAiCredentials.modelName,
    })
    .from(userAiCredentials)
    .where(
      and(eq(userAiCredentials.userId, userId), eq(userAiCredentials.provider, 'ollama')),
    )
    .limit(1)

  if (!credential?.baseUrl) return null

  return {
    baseUrl: credential.baseUrl,
    visionModel: credential.visionModel ?? OLLAMA_FALLBACK_MODEL,
    textModel: credential.textModel ?? OLLAMA_FALLBACK_MODEL,
  }
}

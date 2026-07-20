import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { isAllowedOllamaUrl, sealApiKey } from '@/lib/ai/crypto'
import { CLOUD_PROVIDERS, deleteCredential, getCredentialSummary } from '@/lib/ai/resolve'
import type { Db } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import { userAiCredentials } from '@/lib/db/schema'

const cloudSchema = z.object({
  provider: z.enum(CLOUD_PROVIDERS),
  apiKey: z.string().trim().min(10).max(400),
  model: z.string().trim().max(120).nullish(),
})

const ollamaSchema = z.object({
  provider: z.literal('ollama'),
  baseUrl: z.string().trim().min(1).max(300),
  visionModel: z.string().trim().max(120).default('qwen2.5vl:7b'),
  textModel: z.string().trim().max(120).default('qwen2.5vl:7b'),
})

const bodySchema = z.union([cloudSchema, ollamaSchema])

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({
    credentials: await getCredentialSummary(db as unknown as Db, session.user.id),
  })
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Check the values and try again.' }, { status: 400 })
  }

  const userId = session.user.id
  const input = parsed.data

  if (input.provider === 'ollama') {
    if (!isAllowedOllamaUrl(input.baseUrl)) {
      return NextResponse.json(
        { error: 'Ollama must be on localhost — that is the only address your browser can reach.' },
        { status: 400 },
      )
    }

    await db
      .insert(userAiCredentials)
      .values({
        userId,
        provider: 'ollama',
        ollamaBaseUrl: input.baseUrl,
        visionModelName: input.visionModel,
        modelName: input.textModel,
        verifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [userAiCredentials.userId, userAiCredentials.provider],
        set: {
          ollamaBaseUrl: input.baseUrl,
          visionModelName: input.visionModel,
          modelName: input.textModel,
          updatedAt: new Date(),
        },
      })

    return NextResponse.json({ ok: true })
  }

  let sealed
  try {
    sealed = sealApiKey(input.apiKey)
  } catch {
    return NextResponse.json(
      { error: 'Encryption is not configured on the server.' },
      { status: 500 },
    )
  }

  await db
    .insert(userAiCredentials)
    .values({
      userId,
      provider: input.provider,
      encryptedKey: sealed.ciphertext,
      keyIv: sealed.iv,
      keyAuthTag: sealed.authTag,
      keyLast4: sealed.last4,
      modelName: input.model ?? null,
      visionModelName: input.model ?? null,
      verifiedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userAiCredentials.userId, userAiCredentials.provider],
      set: {
        encryptedKey: sealed.ciphertext,
        keyIv: sealed.iv,
        keyAuthTag: sealed.authTag,
        keyLast4: sealed.last4,
        modelName: input.model ?? null,
        visionModelName: input.model ?? null,
        updatedAt: new Date(),
      },
    })

  return NextResponse.json({ ok: true, last4: sealed.last4 })
}

export async function DELETE(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const provider = new URL(request.url).searchParams.get('provider')
  const deletable = z.enum([...CLOUD_PROVIDERS, 'ollama']).safeParse(provider)
  if (!deletable.success) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 400 })
  }

  await deleteCredential(db as unknown as Db, session.user.id, deletable.data)

  return NextResponse.json({ ok: true })
}

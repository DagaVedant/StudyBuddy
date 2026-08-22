import {NextResponse} from 'next/server'
import {z} from 'zod'

import {
  CLOUD_PROVIDERS,
  deleteCredential,
  getCredentialSummary,
  isAllowedOllamaUrl,
  sealApiKey,
  verifyCloudKey,
} from '@/lib/ai/resolve'
import {CREDENTIAL_LIMIT, guardRateLimit} from '@/lib/api'
import {auth} from '@/auth'
import {db} from '@/lib/db'
import {userAiCredentials} from '@/lib/schema'

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
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  return NextResponse.json({credentials: await getCredentialSummary(db, session.user.id)})
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Check the values and try again.'}, {status: 400})
  }

  const userId = session.user.id
  const input = parsed.data

  const limited = await guardRateLimit(
    db,
    CREDENTIAL_LIMIT,
    `user:${userId}`,
    'Too many credential changes. Try again shortly.',
  )
  if (limited) return limited

  if (input.provider === 'ollama') {
    if (!isAllowedOllamaUrl(input.baseUrl)) {
      return NextResponse.json(
        {error: 'Ollama must be on localhost. That is the only address your browser can reach.'},
        {status: 400},
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

    return NextResponse.json({ok: true})
  }

  let sealed
  try {
    sealed = sealApiKey(input.apiKey)
  } catch {
    return NextResponse.json(
      {error: 'Encryption is not configured on the server.'},
      {status: 500},
    )
  }

  const verdict = await verifyCloudKey(input.provider, input.apiKey)

  if (verdict.status === 'rejected') {
    return NextResponse.json({error: verdict.reason}, {status: 400})
  }

  const verified = verdict.status === 'ok'
  const verifiedAt = verified ? new Date() : null
  const model = input.model ?? null

  await db
    .insert(userAiCredentials)
    .values({
      userId,
      provider: input.provider,
      verifiedAt,
      encryptedKey: sealed.ciphertext,
      keyIv: sealed.iv,
      keyAuthTag: sealed.authTag,
      keyLast4: sealed.last4,
      modelName: model,
      visionModelName: model,
    })
    .onConflictDoUpdate({
      target: [userAiCredentials.userId, userAiCredentials.provider],
      set: {
        encryptedKey: sealed.ciphertext,
        keyIv: sealed.iv,
        keyAuthTag: sealed.authTag,
        keyLast4: sealed.last4,
        modelName: model,
        visionModelName: model,
        verifiedAt,
        updatedAt: new Date(),
      },
    })

  return NextResponse.json({
    ok: true,
    last4: sealed.last4,
    verified,
    message: verified
      ? undefined
      : `Saved, but ${input.provider} could not be reached to check it.`,
  })
}

export async function DELETE(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const provider = new URL(request.url).searchParams.get('provider')
  const deletable = z.enum([...CLOUD_PROVIDERS, 'ollama']).safeParse(provider)
  if (!deletable.success) {
    return NextResponse.json({error: 'Unknown provider'}, {status: 400})
  }

  const limited = await guardRateLimit(
    db,
    CREDENTIAL_LIMIT,
    `user:${session.user.id}`,
    'Too many credential changes. Try again shortly.',
  )
  if (limited) return limited

  await deleteCredential(db, session.user.id, deletable.data)

  return NextResponse.json({ok: true})
}

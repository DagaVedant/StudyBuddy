import {sql} from 'drizzle-orm'

import {type Db, unwrapDriverRows} from '@/lib/db'
import {operatorCallsPerDay, operatorCallsWarnAt} from '@/lib/ai/types'

function todayKey() {
  return 'operator:openrouter:' + new Date().toISOString().slice(0, 10)
}

export async function recordOperatorCall(db: Db) {
  const key = todayKey()
  const nowIso = new Date().toISOString()

  try {
    await db.execute(sql`
      INSERT INTO rate_limits (key, count, window_start)
      VALUES (${key}, 1, ${nowIso}::timestamptz)
      ON CONFLICT (key) DO UPDATE SET count = rate_limits.count + 1
    `)
  } catch (error) {
    console.error('[usage] could not record an OpenRouter call:', (error as Error).message)
  }
}

export async function operatorCallsToday(db: Db) {
  const key = todayKey()

  try {
    const rows = await db.execute(sql`SELECT count FROM rate_limits WHERE key = ${key}`)
    const found = unwrapDriverRows<{count: number | string}>(rows)

    if (!found[0]) return 0

    return Number(found[0].count)
  } catch (error) {
    console.error('[usage] could not read today\'s OpenRouter calls:', (error as Error).message)
    return 0
  }
}

export type OperatorUsage = {
  calls: number
  cap: number
  warnAt: number
  level: 'ok' | 'high' | 'exhausted'
}

export async function operatorUsage(db: Db): Promise<OperatorUsage> {
  const calls = await operatorCallsToday(db)
  const cap = operatorCallsPerDay()
  const warnAt = operatorCallsWarnAt()

  let level: 'ok' | 'high' | 'exhausted' = 'ok'
  if (calls >= cap) level = 'exhausted'
  else if (calls >= warnAt) level = 'high'

  return {calls: calls, cap: cap, warnAt: warnAt, level: level}
}

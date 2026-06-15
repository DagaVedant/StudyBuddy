import { eq } from 'drizzle-orm'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'

export type Guarded =
  | { ok: true; userId: string; role: 'student' | 'admin' }
  | { ok: false; status: 401 | 404 }

/**
 * Every worksheet-scoped route runs this first. Returns 404 rather than 403 on
 * a mismatch so the API can't be used to confirm that someone else's worksheet
 * exists (spec §8).
 */
export async function guardWorksheet(worksheetId: string): Promise<Guarded> {
  const session = await auth()
  if (!session?.user?.id) return { ok: false, status: 401 }

  const [worksheet] = await db
    .select({ userId: worksheets.userId })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet || worksheet.userId !== session.user.id) {
    return { ok: false, status: 404 }
  }

  return { ok: true, userId: session.user.id, role: session.user.role }
}

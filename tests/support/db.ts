import {readFile} from 'node:fs/promises'

import {PGlite} from '@electric-sql/pglite'
import {vector} from '@electric-sql/pglite-pgvector'
import {drizzle} from 'drizzle-orm/pglite'

import * as tables from '@/lib/schema'
import {type Db} from '@/lib/db'

export async function freshDb(): Promise<Db> {
  const client = await PGlite.create({extensions: {vector}})
  const sql = await readFile('drizzle/0000_fine_magneto.sql', 'utf8')

  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (!trimmed) continue
    if (/USING hnsw/i.test(trimmed)) continue
    await client.exec(trimmed)
  }

  return drizzle(client, {schema: tables}) as unknown as Db
}

let seq = 0
export const uid = (prefix: string) => `${prefix}-${(seq += 1)}`

export async function makeUser(db: Db): Promise<string> {
  const id = uid('user')
  await db.insert(tables.users).values({id, email: `${id}@example.test`})
  return id
}

export async function makeWorksheet(db: Db, userId: string): Promise<string> {
  const id = uid('sheet')
  await db.insert(tables.worksheets).values({
    id,
    userId,
    title: 'Unit 4 Practice',
    sourceType: 'pdf_digital',
    pageCount: 1,
  })
  return id
}

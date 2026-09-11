import {strict as assert} from 'node:assert'
import test from 'node:test'

import {operatorCallsToday, operatorUsage, recordOperatorCall} from '@/lib/ai/usage'
import {operatorCallsPerDay, operatorCallsWarnAt} from '@/lib/ai/types'

import {freshDb} from './support/db'

test('a fresh day has no reads and no notice', async () => {
  const db = await freshDb()

  assert.equal(await operatorCallsToday(db), 0)

  const usage = await operatorUsage(db)
  assert.equal(usage.level, 'ok')
})

test('every recorded call counts once', async () => {
  const db = await freshDb()

  for (let i = 0; i < 7; i++) await recordOperatorCall(db)

  assert.equal(await operatorCallsToday(db), 7)
})

test('the notice turns on at the warning line and off again only past the cap', async () => {
  const db = await freshDb()

  const warnAt = operatorCallsWarnAt()
  const cap = operatorCallsPerDay()

  for (let i = 0; i < warnAt - 1; i++) await recordOperatorCall(db)
  assert.equal((await operatorUsage(db)).level, 'ok')

  await recordOperatorCall(db)
  assert.equal((await operatorUsage(db)).level, 'high')

  for (let i = warnAt; i < cap; i++) await recordOperatorCall(db)
  const spent = await operatorUsage(db)

  assert.equal(spent.calls, cap)
  assert.equal(spent.level, 'exhausted')
})

import { timingSafeEqual } from 'node:crypto'

export function inviteRequired(): boolean {
  return Boolean(process.env.SIGNUP_INVITE_CODE?.trim())
}

export function inviteAccepted(offered: string): boolean {
  const expected = process.env.SIGNUP_INVITE_CODE?.trim()
  if (!expected) return true

  const left = Buffer.from(offered.trim())
  const right = Buffer.from(expected)

  return left.length === right.length && timingSafeEqual(left, right)
}

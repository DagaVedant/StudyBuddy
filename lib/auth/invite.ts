import { timingSafeEqual } from 'node:crypto'

/*
 * A closed launch without building a waitlist: set SIGNUP_INVITE_CODE and the
 * form asks for it. Unset, sign-ups are open, which is the default and what
 * every existing deployment does.
 */
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

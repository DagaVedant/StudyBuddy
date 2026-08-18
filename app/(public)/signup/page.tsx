import { inviteRequired } from '@/lib/auth/invite'

import SignUpForm from './signup-form'

export const metadata = { title: 'Create an Account · StudyBuddy' }

export default function SignUpPage() {
  return <SignUpForm inviteRequired={inviteRequired()} />
}

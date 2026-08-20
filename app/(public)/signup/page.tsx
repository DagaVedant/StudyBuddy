import { inviteRequired } from '@/lib/auth/reset'

import SignUpForm from './signup-form'

export const metadata = { title: 'Create an Account · StudyBuddy' }

export default function SignUpPage() {
  return <SignUpForm inviteRequired={inviteRequired()} />
}

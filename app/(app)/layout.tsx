import { auth } from '@/auth'
import AppTopbar from '@/components/app-topbar'
import BrowserDerivedRunner from '@/components/browser-derived-runner'
import MainRegion from '@/components/main-region'
import { getCredentialSummary } from '@/lib/ai/resolve'
import { db } from '@/lib/db'

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth()

  const runsHere = session?.user?.id
    ? (await getCredentialSummary(db, session.user.id)).some(
        (row) => row.provider === 'ollama' && row.ollamaBaseUrl,
      )
    : false

  return (
    <>
      <AppTopbar />
      <MainRegion>{children}</MainRegion>
      {runsHere && <BrowserDerivedRunner />}
    </>
  )
}

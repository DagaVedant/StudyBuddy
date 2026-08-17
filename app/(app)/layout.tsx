import AppTopbar from '@/components/app-topbar'
import MainRegion from '@/components/main-region'

export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <AppTopbar />
      <MainRegion>{children}</MainRegion>
    </>
  )
}

import MainRegion from '@/components/main-region'

export default function PublicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <MainRegion>{children}</MainRegion>
}
